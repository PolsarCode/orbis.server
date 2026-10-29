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
import type { Prisma } from '../../prisma/generated/client';
import { nsfwEntries, showsNsfw } from '../users/nsfw';
import { notSuspended } from '../users/suspension';
import {
  MUTUAL_PREVIEW,
  SHARED_STATUSES,
  availableSlots,
  communityReason,
  mutualReason,
  rankCandidates,
  slotFields,
  spendSlot,
  titleReason,
} from './suggestions';

const MAX_INT = 2147483647;
const CANDIDATE_LIMIT = 50;

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
  twitchLogin: string | null;
};

export type FriendSuggestion = FriendUser & {
  reason: string;
  mutualFriends: FriendUser[];
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

const publicPerson = {
  id: true,
  username: true,
  name: true,
  avatarUrl: true,
  isVerified: true,
} satisfies Prisma.UserSelect;

function toFriendUser({
  id,
  ...user
}: Prisma.UserGetPayload<{ select: typeof publicPerson }>): FriendUser {
  return { userId: id, ...user };
}

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
          twitchLogin: this.presence.twitchOf(other.id, other),
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

  async suggestions(userId: number): Promise<FriendSuggestion[]> {
    const slots = await this.prisma.user.findUnique({
      where: { id: userId },
      select: slotFields,
    });
    const limit = slots ? availableSlots(slots) : 0;
    if (limit === 0) return [];

    const [friendships, memberships, library, showNsfw] = await Promise.all([
      this.prisma.friendship.findMany({
        where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
        select: { requesterId: true, addresseeId: true, status: true },
      }),
      this.prisma.membership.findMany({
        where: { userId },
        select: { communityId: true },
      }),
      this.prisma.libraryEntry.findMany({
        where: { userId },
        select: { mediaId: true },
      }),
      showsNsfw(this.prisma, userId),
    ]);

    const friendIds: number[] = [];
    const known = new Set([userId]);
    for (const { requesterId, addresseeId, status } of friendships) {
      const other = requesterId === userId ? addresseeId : requesterId;
      known.add(other);
      if (status === 'accepted') friendIds.push(other);
    }
    const excluded = [...known];
    const communityIds = memberships.map(({ communityId }) => communityId);
    const sharedTitle = {
      mediaId: { in: library.map(({ mediaId }) => mediaId) },
      isPublic: true,
      status: { in: SHARED_STATUSES },
      ...nsfwEntries(showNsfw),
      user: {
        OR: [
          { isPublic: true },
          { memberships: { some: { communityId: { in: communityIds } } } },
        ],
      },
    } satisfies Prisma.LibraryEntryWhereInput;

    const [friendsOfFriends, communityCounts, titleCounts] = await Promise.all([
      friendIds.length === 0
        ? []
        : this.prisma.friendship.findMany({
            where: {
              status: 'accepted',
              OR: [
                {
                  requesterId: { in: friendIds },
                  addresseeId: { notIn: excluded },
                },
                {
                  addresseeId: { in: friendIds },
                  requesterId: { notIn: excluded },
                },
              ],
            },
            select: { requesterId: true, addresseeId: true },
          }),
      communityIds.length === 0
        ? []
        : this.prisma.membership.groupBy({
            by: ['userId'],
            where: {
              communityId: { in: communityIds },
              userId: { notIn: excluded },
            },
            _count: { userId: true },
            orderBy: { _count: { userId: 'desc' } },
            take: CANDIDATE_LIMIT,
          }),
      library.length === 0
        ? []
        : this.prisma.libraryEntry.groupBy({
            by: ['userId'],
            where: { ...sharedTitle, userId: { notIn: excluded } },
            _count: { userId: true },
            orderBy: { _count: { userId: 'desc' } },
            take: CANDIDATE_LIMIT,
          }),
    ]);

    const mutual = new Map<number, number[]>();
    for (const { requesterId, addresseeId } of friendsOfFriends) {
      const [friend, candidate] = known.has(requesterId)
        ? [requesterId, addresseeId]
        : [addresseeId, requesterId];
      mutual.set(candidate, [...(mutual.get(candidate) ?? []), friend]);
    }
    const counts = (rows: { userId: number; _count: { userId: number } }[]) =>
      new Map(rows.map(({ userId: id, _count }) => [id, _count.userId]));
    const ranked = rankCandidates({
      mutual,
      communities: counts(communityCounts),
      titles: counts(titleCounts),
    }).slice(0, CANDIDATE_LIMIT * 2);
    if (ranked.length === 0) return [];

    const candidates = await this.prisma.user.findMany({
      where: { id: { in: ranked }, ...notSuspended() },
      select: publicPerson,
    });
    const byId = new Map(candidates.map((user) => [user.id, user]));
    const chosen = ranked.filter((id) => byId.has(id)).slice(0, limit);

    const needsCommunity = chosen.filter((id) => !mutual.has(id));
    const previewIds = [
      ...new Set(
        chosen.flatMap((id) => (mutual.get(id) ?? []).slice(0, MUTUAL_PREVIEW)),
      ),
    ];
    const [previews, sharedCommunities, sharedTitles] = await Promise.all([
      previewIds.length === 0
        ? []
        : this.prisma.user.findMany({
            where: { id: { in: previewIds } },
            select: publicPerson,
          }),
      needsCommunity.length === 0 || communityIds.length === 0
        ? []
        : this.prisma.membership.findMany({
            where: {
              userId: { in: needsCommunity },
              communityId: { in: communityIds },
            },
            orderBy: { joinedAt: 'asc' },
            select: { userId: true, community: { select: { name: true } } },
          }),
      needsCommunity.length === 0 || library.length === 0
        ? []
        : this.prisma.libraryEntry.findMany({
            where: { ...sharedTitle, userId: { in: needsCommunity } },
            orderBy: { updatedAt: 'desc' },
            select: {
              userId: true,
              title: true,
              mediaType: true,
              status: true,
            },
          }),
    ]);

    const previewById = new Map(
      previews.map((user) => [user.id, user] as const),
    );
    const communityOf = new Map<number, string>();
    for (const { userId: id, community } of sharedCommunities) {
      if (!communityOf.has(id)) communityOf.set(id, community.name);
    }
    const titleOf = new Map<number, (typeof sharedTitles)[number]>();
    for (const entry of sharedTitles) {
      const current = titleOf.get(entry.userId);
      if (
        !current ||
        (current.status !== 'current' && entry.status === 'current')
      ) {
        titleOf.set(entry.userId, entry);
      }
    }

    return chosen.map((id) => {
      const mutualIds = mutual.get(id) ?? [];
      const community = communityOf.get(id);
      const title = titleOf.get(id);
      return {
        ...toFriendUser(byId.get(id)!),
        reason:
          mutualIds.length > 0
            ? mutualReason(mutualIds.length)
            : community
              ? communityReason(community)
              : title
                ? titleReason(title)
                : '',
        mutualFriends: mutualIds
          .slice(0, MUTUAL_PREVIEW)
          .flatMap((friendId) => {
            const friend = previewById.get(friendId);
            return friend ? [toFriendUser(friend)] : [];
          }),
      };
    });
  }

  async add(
    userId: number,
    { userId: targetId, username, fromSuggestion }: AddFriendDto,
  ) {
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

    if (fromSuggestion) await this.spendSuggestionSlot(userId);
    this.presence.notify([userId, target.id], 'friends:changed');
  }

  private async spendSuggestionSlot(userId: number) {
    const slots = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: slotFields,
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: spendSlot(slots),
    });
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
