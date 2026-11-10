import { Logger } from '@nestjs/common';
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
import { Subject } from 'rxjs';
import { Server, Socket } from 'socket.io';
import type { UserStatus } from '../../prisma/generated/client';
import { PrismaService } from '../prisma.service';
import { isSuspended, sessionEnded, sessionFields } from '../users/suspension';
import { notBlockedWith } from '../safety/blocks';

const room = (userId: number) => `user:${userId}`;

export type PresenceStatus =
  | 'online'
  | 'idle'
  | 'busy'
  | 'streaming'
  | 'offline';

const DEVICES = ['web', 'desktop', 'mobile'] as const;

export type Device = (typeof DEVICES)[number];

const deviceFrom = (platform: unknown): Device =>
  DEVICES.find((device) => device === platform) ?? 'web';

@WebSocketGateway({ cors: true })
export class PresenceGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(PresenceGateway.name);
  private connections = new Map<number, Set<Socket>>();
  private live = new Map<number, string>();
  private playing = new Map<number, string>();
  private liveCommunities = new Set<number>();
  readonly cameOnline = new Subject<number>();

  constructor(
    private jwt: JwtService,
    private prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket) {
    let userId: number;
    let issuedAt: number | undefined;
    try {
      ({ sub: userId, iat: issuedAt } = await this.jwt.verifyAsync(
        client.handshake.auth?.token,
      ));
    } catch {
      client.disconnect(true);
      return;
    }

    try {
      await this.admit(client, userId, issuedAt);
    } catch (error) {
      this.logger.warn(
        `Couldn’t connect socket for user ${userId}: ${error instanceof Error ? error.message : error}`,
      );
      client.disconnect(true);
    }
  }

  private async admit(client: Socket, userId: number, issuedAt?: number) {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: sessionFields,
    });
    if (account && (isSuspended(account) || sessionEnded(account, issuedAt))) {
      client.disconnect(true);
      return;
    }

    if (!client.connected) return;

    client.data.userId = userId;
    client.data.platform = deviceFrom(client.handshake.auth?.platform);
    client.data.idle = client.handshake.auth?.idle === true;
    client.data.lastActiveAt = client.data.idle ? 0 : Date.now();
    await client.join(room(userId));

    const first = !this.isOnline(userId);
    await this.broadcastIfChanged(userId, () => {
      this.connections.set(
        userId,
        (this.connections.get(userId) ?? new Set<Socket>()).add(client),
      );
    });
    if (first) this.cameOnline.next(userId);
  }

  disconnectUser(userId: number) {
    this.server.in(room(userId)).disconnectSockets(true);
  }

  async handleDisconnect(client: Socket) {
    const userId: number | undefined = client.data.userId;
    if (userId === undefined) return;

    await this.broadcastIfChanged(userId, () => {
      const sockets = this.connections.get(userId);
      sockets?.delete(client);
      if (!sockets?.size) this.connections.delete(userId);
    }).catch((error) =>
      this.logger.warn(
        `Couldn’t share presence after user ${userId} disconnected: ${error instanceof Error ? error.message : error}`,
      ),
    );
  }

  @SubscribeMessage('idle')
  async setIdle(
    @ConnectedSocket() client: Socket,
    @MessageBody() idle: unknown,
  ) {
    const userId: number | undefined = client.data.userId;
    if (userId === undefined) return;

    const next = idle === true;
    await this.broadcastIfChanged(userId, () => {
      if (!next) client.data.lastActiveAt = Date.now();
      client.data.idle = next;
    });
  }

  async markActive(client: Socket) {
    const userId: number | undefined = client.data.userId;
    if (userId === undefined) return;

    await this.broadcastIfChanged(userId, () => {
      client.data.lastActiveAt = Date.now();
    });
  }

  isOnline(userId: number) {
    return this.connections.has(userId);
  }

  isIdle(userId: number) {
    const sockets = [...(this.connections.get(userId) ?? [])];
    return sockets.length > 0 && sockets.every((socket) => socket.data.idle);
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

  deviceOf(
    userId: number,
    { appearOffline }: { appearOffline: boolean },
  ): Device | null {
    return appearOffline ? null : this.activeDevice(userId);
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

  private activeDevice(userId: number): Device | null {
    const [latest] = [...(this.connections.get(userId) ?? [])].sort(
      (a, b) =>
        Number(Boolean(a.data.idle)) - Number(Boolean(b.data.idle)) ||
        b.data.lastActiveAt - a.data.lastActiveAt,
    );
    return latest?.data.platform ?? null;
  }

  private async broadcastIfChanged(userId: number, change: () => void) {
    const idle = this.isIdle(userId);
    const device = this.activeDevice(userId);
    change();
    if (this.isIdle(userId) !== idle || this.activeDevice(userId) !== device) {
      await this.broadcastPresence(userId);
    }
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
          user: notBlockedWith(userId),
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
      device: this.deviceOf(userId, user),
      playing: this.playingOf(userId, user),
      twitchLogin: this.twitchOf(userId, user),
    });
  }
}
