import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AddFriendDto } from './dto/add-friend.dto';
import { PresenceGateway, PresenceStatus } from './presence.gateway';
import { normalizeUsername } from '../users/username';
import { NotificationsService } from '../notifications/notifications.service';

const MAX_INT = 2147483647;

export type FriendUser = {
  userId: number;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
};

export type Friend = FriendUser & {
  online: boolean;
  status: PresenceStatus;
  playing: string | null;
};

export type FriendList = {
  friends: Friend[];
  incoming: FriendUser[];
  outgoing: FriendUser[];
};

const person = {
  select: {
    id: true,
    username: true,
    name: true,
    avatarUrl: true,
    isVerified: true,
    appearOffline: true,
    status: true,
  },
} as const;

function between(userId: number, otherId: number) {
  return {
    OR: [
      { requesterId: userId, addresseeId: otherId },
      { requesterId: otherId, addresseeId: userId },
    ],
  };
}

@Injectable()
export class FriendsService {
  constructor(
    private prisma: PrismaService,
    private presence: PresenceGateway,
    private notifications: NotificationsService,
  ) {}

  async list(userId: number): Promise<FriendList> {
    const friendships = await this.prisma.friendship.findMany({
      where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
      orderBy: { createdAt: 'desc' },
      include: { requester: person, addressee: person },
    });
    const list: FriendList = { friends: [], incoming: [], outgoing: [] };

    for (const friendship of friendships) {
      const other =
        friendship.requesterId === userId
          ? friendship.addressee
          : friendship.requester;
      const user = {
        userId: other.id,
        username: other.username,
        name: other.name,
        avatarUrl: other.avatarUrl,
        isVerified: other.isVerified,
      };

      if (friendship.status === 'accepted') {
        const status = this.presence.statusOf(other.id, other);
        list.friends.push({
          ...user,
          online: status !== 'offline',
          status,
          playing: this.presence.playingOf(other.id, other),
        });
      } else if (friendship.addresseeId === userId) {
        list.incoming.push(user);
      } else {
        list.outgoing.push(user);
      }
    }

    list.friends.sort((a, b) =>
      (a.name ?? a.username).localeCompare(b.name ?? b.username),
    );
    return list;
  }

  async search(userId: number, query: string): Promise<FriendUser[]> {
    const q = query.trim().replace(/^@/, '');
    if (q.length < 2) return [];

    const users = await this.prisma.user.findMany({
      where: {
        id: { not: userId },
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 50,
      select: {
        id: true,
        username: true,
        name: true,
        avatarUrl: true,
        isVerified: true,
      },
    });

    const needle = q.toLowerCase();
    const rank = ({
      username,
      name,
    }: {
      username: string;
      name: string | null;
    }) =>
      username === needle
        ? 0
        : username.startsWith(needle) || name?.toLowerCase().startsWith(needle)
          ? 1
          : 2;

    return users
      .sort((a, b) => rank(a) - rank(b) || a.username.localeCompare(b.username))
      .slice(0, 8)
      .map(({ id, ...user }) => ({ userId: id, ...user }));
  }

  async add(userId: number, { userId: targetId, username }: AddFriendDto) {
    const target = await this.prisma.user.findUnique({
      where:
        targetId !== undefined
          ? { id: targetId }
          : { username: normalizeUsername(username!) },
      select: { id: true },
    });

    if (!target) throw new NotFoundException('User not found');
    if (target.id === userId) {
      throw new BadRequestException('You cannot add yourself');
    }

    const existing = await this.prisma.friendship.findFirst({
      where: between(userId, target.id),
    });

    if (existing?.status === 'accepted') {
      throw new ConflictException('You are already friends');
    }
    if (existing?.requesterId === userId) {
      throw new ConflictException('Friend request already sent');
    }

    if (existing) {
      await this.prisma.friendship.update({
        where: {
          requesterId_addresseeId: {
            requesterId: target.id,
            addresseeId: userId,
          },
        },
        data: { status: 'accepted' },
      });
      const me = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { username: true },
      });
      await this.notifications.notify([
        {
          userId: target.id,
          actorId: userId,
          type: 'friend_accepted',
          message: 'accepted your friend request',
          link: `/users/${me.username}`,
        },
      ]);
    } else {
      await this.prisma.friendship.create({
        data: { requesterId: userId, addresseeId: target.id },
      });
      await this.notifications.notify([
        {
          userId: target.id,
          actorId: userId,
          type: 'friend_request',
          message: 'sent you a friend request',
          link: '/requests',
        },
      ]);
    }

    this.presence.notify([userId, target.id], 'friends:changed');
  }

  async remove(userId: number, otherId: number) {
    const { count } =
      otherId >= 1 && otherId <= MAX_INT
        ? await this.prisma.friendship.deleteMany({
            where: between(userId, otherId),
          })
        : { count: 0 };

    if (count === 0) throw new NotFoundException('Friend not found');
    this.presence.notify([userId, otherId], 'friends:changed');
  }
}
