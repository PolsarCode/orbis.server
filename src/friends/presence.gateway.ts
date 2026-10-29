import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type { UserStatus } from '../../prisma/generated/client';
import { PrismaService } from '../prisma.service';

const room = (userId: number) => `user:${userId}`;

export type PresenceStatus =
  | 'online'
  | 'idle'
  | 'busy'
  | 'streaming'
  | 'offline';

@WebSocketGateway({ cors: true })
export class PresenceGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private connections = new Map<number, number>();
  private idleConnections = new Map<number, number>();
  private live = new Map<number, string>();
  private playing = new Map<number, string>();
  private liveCommunities = new Set<number>();

  constructor(
    private jwt: JwtService,
    private prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket) {
    let userId: number;
    try {
      ({ sub: userId } = await this.jwt.verifyAsync(
        client.handshake.auth?.token,
      ));
    } catch {
      client.disconnect(true);
      return;
    }

    if (!client.connected) return;

    client.data.userId = userId;
    await client.join(room(userId));

    const wasIdle = this.isIdle(userId);
    const count = (this.connections.get(userId) ?? 0) + 1;
    this.connections.set(userId, count);
    if (count === 1 || wasIdle) await this.broadcastPresence(userId);
  }

  async handleDisconnect(client: Socket) {
    const userId: number | undefined = client.data.userId;
    if (userId === undefined) return;

    const wasIdle = this.isIdle(userId);
    if (client.data.idle) this.adjustIdle(userId, -1);
    const count = (this.connections.get(userId) ?? 1) - 1;
    if (count > 0) {
      this.connections.set(userId, count);
      if (this.isIdle(userId) !== wasIdle) await this.broadcastPresence(userId);
      return;
    }

    this.connections.delete(userId);
    this.idleConnections.delete(userId);
    await this.broadcastPresence(userId);
  }

  @SubscribeMessage('idle')
  async setIdle(
    @ConnectedSocket() client: Socket,
    @MessageBody() idle: unknown,
  ) {
    const userId: number | undefined = client.data.userId;
    const next = idle === true;
    if (userId === undefined || Boolean(client.data.idle) === next) return;

    const wasIdle = this.isIdle(userId);
    client.data.idle = next;
    this.adjustIdle(userId, next ? 1 : -1);
    if (this.isIdle(userId) !== wasIdle) await this.broadcastPresence(userId);
  }

  isOnline(userId: number) {
    return this.connections.has(userId);
  }

  isIdle(userId: number) {
    const connections = this.connections.get(userId) ?? 0;
    return (
      connections > 0 && (this.idleConnections.get(userId) ?? 0) >= connections
    );
  }

  statusOf(
    userId: number,
    { appearOffline, status }: { appearOffline: boolean; status: UserStatus },
  ): PresenceStatus {
    if (appearOffline) return 'offline';
    if (this.live.has(userId)) return 'streaming';
    if (!this.isOnline(userId)) return 'offline';
    if (status === 'busy') return 'busy';
    return status === 'idle' || this.isIdle(userId) ? 'idle' : 'online';
  }

  twitchOf(
    userId: number,
    user: { appearOffline: boolean; status: UserStatus },
  ) {
    return this.statusOf(userId, user) === 'streaming'
      ? (this.live.get(userId) ?? null)
      : null;
  }

  playingOf(
    userId: number,
    user: { appearOffline: boolean; status: UserStatus },
  ) {
    return this.statusOf(userId, user) === 'offline'
      ? null
      : (this.playing.get(userId) ?? null);
  }

  async updatePlaying(playing: Map<number, string>) {
    const changed = [
      ...new Set([...this.playing.keys(), ...playing.keys()]),
    ].filter((userId) => this.playing.get(userId) !== playing.get(userId));
    this.playing = playing;
    for (const userId of changed) await this.broadcastPresence(userId);
  }

  async stopPlaying(userId: number) {
    if (!this.playing.delete(userId)) return;
    await this.broadcastPresence(userId);
  }

  async updateLive(live: Map<number, string>) {
    const changed = [...new Set([...this.live.keys(), ...live.keys()])].filter(
      (userId) => this.live.get(userId) !== live.get(userId),
    );
    this.live = live;
    for (const userId of changed) await this.broadcastPresence(userId);
  }

  async stopLive(userId: number) {
    if (!this.live.delete(userId)) return;
    await this.broadcastPresence(userId);
  }

  isCommunityLive(communityId: number) {
    return this.liveCommunities.has(communityId);
  }

  async updateLiveCommunities(live: Set<number>) {
    const changed = [...new Set([...this.liveCommunities, ...live])].filter(
      (communityId) =>
        this.liveCommunities.has(communityId) !== live.has(communityId),
    );
    this.liveCommunities = live;
    for (const communityId of changed) {
      await this.announceCommunityLive(communityId);
    }
  }

  async stopCommunityLive(communityId: number) {
    if (!this.liveCommunities.delete(communityId)) return;
    await this.announceCommunityLive(communityId);
  }

  private async announceCommunityLive(communityId: number) {
    const members = await this.prisma.membership.findMany({
      where: { communityId },
      select: { userId: true },
    });
    if (members.length === 0) return;
    this.notify(
      members.map((member) => member.userId),
      'community:live',
      { communityId, live: this.liveCommunities.has(communityId) },
    );
  }

  private adjustIdle(userId: number, delta: number) {
    const next = (this.idleConnections.get(userId) ?? 0) + delta;
    if (next > 0) this.idleConnections.set(userId, next);
    else this.idleConnections.delete(userId);
  }

  notify(userIds: number[], event: string, payload?: unknown) {
    this.server.to(userIds.map(room)).emit(event, payload);
  }

  async broadcastPresence(userId: number) {
    const [user, friendships, coMembers] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { appearOffline: true, status: true },
      }),
      this.prisma.friendship.findMany({
        where: {
          status: 'accepted',
          OR: [{ requesterId: userId }, { addresseeId: userId }],
        },
        select: { requesterId: true, addresseeId: true },
      }),
      this.prisma.membership.findMany({
        where: {
          userId: { not: userId },
          community: { memberships: { some: { userId } } },
        },
        distinct: ['userId'],
        select: { userId: true },
      }),
    ]);

    const recipients = new Set([
      ...friendships.map(({ requesterId, addresseeId }) =>
        requesterId === userId ? addresseeId : requesterId,
      ),
      ...coMembers.map((membership) => membership.userId),
    ]);
    if (!user || recipients.size === 0) return;

    const status = this.statusOf(userId, user);
    this.server.to([...recipients].map(room)).emit('presence', {
      userId,
      online: status !== 'offline',
      status,
      playing: this.playingOf(userId, user),
      twitchLogin: this.twitchOf(userId, user),
    });
  }
}
