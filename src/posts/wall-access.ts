import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { MediaType, Prisma } from '../../prisma/generated/client';
import { requireMembership } from '../communities/require-membership';
import { blockState } from '../safety/blocks';
import { friendshipBetween } from '../friends/friend-ids';

export function friendsOf(userId: number): Prisma.UserWhereInput {
  return {
    OR: [
      {
        sentFriendships: { some: { addresseeId: userId, status: 'accepted' } },
      },
      {
        receivedFriendships: {
          some: { requesterId: userId, status: 'accepted' },
        },
      },
    ],
  };
}

export function viewableProfiles(viewerId: number): Prisma.UserWhereInput {
  return { OR: [{ isPublic: true }, { id: viewerId }, friendsOf(viewerId)] };
}

async function areFriends(
  prisma: PrismaService,
  userId: number,
  otherId: number,
) {
  const friendship = await prisma.friendship.findFirst({
    where: { status: 'accepted', ...friendshipBetween(userId, otherId) },
    select: { requesterId: true },
  });
  return friendship !== null;
}

export async function requireWallAccess(
  prisma: PrismaService,
  userId: number,
  wallUserId: number,
) {
  if (userId === wallUserId) return;

  if (!(await areFriends(prisma, userId, wallUserId))) {
    throw new ForbiddenException('Only friends can join in on this wall');
  }
}

export async function canViewProfile(
  prisma: PrismaService,
  viewerId: number,
  owner: { id: number; isPublic: boolean },
) {
  if (owner.id === viewerId) return true;
  const { blocking, blockedBy } = await blockState(prisma, viewerId, owner.id);
  if (blocking || blockedBy) return false;
  if (owner.isPublic) return true;

  return areFriends(prisma, viewerId, owner.id);
}

export async function requireProfileView(
  prisma: PrismaService,
  viewerId: number,
  ownerId: number,
) {
  const owner = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { id: true, isPublic: true },
  });

  if (!owner || !(await canViewProfile(prisma, viewerId, owner))) {
    throw new ForbiddenException('This profile is private');
  }
}

export async function requirePostAccess(
  prisma: PrismaService,
  userId: number,
  {
    communityId,
    wallUserId,
    mediaType = null,
  }: {
    communityId: number | null;
    wallUserId: number | null;
    mediaType?: MediaType | null;
  },
) {
  if (communityId !== null) {
    await requireMembership(prisma, userId, communityId);
  } else if (wallUserId !== null) {
    await requireWallAccess(prisma, userId, wallUserId);
  } else if (mediaType === null) {
    throw new NotFoundException('Not found');
  }
}

export type EngagementType = 'post' | 'activity' | 'chart';

export type EngagementTarget = {
  type: EngagementType;
  id: number;
  communityId: number | null;
  wallUserId: number | null;
  mediaType: MediaType | null;
  mediaSourceId: string | null;
  ownerId: number | null;
};

export async function targetOf(
  prisma: PrismaService,
  viewerId: number,
  type: EngagementType,
  id: number,
): Promise<EngagementTarget> {
  if (id < 1 || id > 2147483647) throw new NotFoundException('Not found');

  if (type === 'post') {
    const post = await prisma.post.findUnique({
      where: { id },
      select: {
        communityId: true,
        wallUserId: true,
        mediaType: true,
        mediaSourceId: true,
        authorId: true,
      },
    });
    if (!post) throw new NotFoundException('Not found');
    return { type, id, ...post, ownerId: post.authorId };
  }

  const unowned = {
    type,
    id,
    communityId: null,
    wallUserId: null,
    mediaType: null,
    mediaSourceId: null,
  };

  if (type === 'chart') {
    const chart = await prisma.chartDiscussion.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!chart) throw new NotFoundException('Not found');
    return { ...unowned, ownerId: null };
  }

  const activity = await prisma.libraryActivity.findUnique({
    where: { id },
    select: { entry: { select: { userId: true, isPublic: true } } },
  });
  if (
    !activity ||
    (!activity.entry.isPublic && activity.entry.userId !== viewerId)
  ) {
    throw new NotFoundException('Not found');
  }
  return { ...unowned, ownerId: activity.entry.userId };
}

export async function requireTargetAccess(
  prisma: PrismaService,
  userId: number,
  target: EngagementTarget,
) {
  if (target.type !== 'post') return;
  await requirePostAccess(prisma, userId, target);
}
