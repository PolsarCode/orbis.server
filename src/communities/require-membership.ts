import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '../../prisma/generated/client';
import { PrismaService } from '../prisma.service';

export function visibleCommunity(userId: number) {
  return {
    OR: [{ isPublic: true }, { memberships: { some: { userId } } }],
  } satisfies Prisma.CommunityWhereInput;
}

export async function requireMembership(
  prisma: PrismaService,
  userId: number,
  communityId: number,
) {
  const membership = await prisma.membership.findUnique({
    where: { userId_communityId: { userId, communityId } },
    select: { userId: true },
  });

  if (!membership) {
    throw new ForbiddenException('You are not a member of this community');
  }
}

export async function requireViewAccess(
  prisma: PrismaService,
  userId: number,
  communityId: number,
) {
  const community = await prisma.community.findUnique({
    where: { id: communityId },
    select: {
      isPublic: true,
      memberships: { where: { userId }, select: { userId: true } },
    },
  });

  if (!community?.isPublic && !community?.memberships.length) {
    throw new ForbiddenException('You are not a member of this community');
  }
}
