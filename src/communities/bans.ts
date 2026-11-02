import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export const BANNED_MESSAGE = 'You can’t join this community';

export async function isBanned(
  prisma: PrismaService,
  userId: number,
  communityId: number,
) {
  const ban = await prisma.communityBan.findUnique({
    where: { communityId_userId: { communityId, userId } },
    select: { userId: true },
  });
  return ban !== null;
}

export async function requireNotBanned(
  prisma: PrismaService,
  userId: number,
  communityId: number,
) {
  if (await isBanned(prisma, userId, communityId)) {
    throw new ForbiddenException(BANNED_MESSAGE);
  }
}
