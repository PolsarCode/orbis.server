import type { Prisma } from '../../prisma/generated/client';
import type { PrismaService } from '../prisma.service';
import { isSiteAdmin } from '../users/head-admin';

export function notBlockedWith(userId: number) {
  return {
    blocksMade: { none: { blockedId: userId } },
    blocksReceived: { none: { blockerId: userId } },
  } satisfies Prisma.UserWhereInput;
}

export function notBlockedBy(userId: number) {
  return {
    blocksReceived: { none: { blockerId: userId } },
  } satisfies Prisma.UserWhereInput;
}

export function notMutedBy(userId: number) {
  return {
    mutesReceived: { none: { muterId: userId } },
  } satisfies Prisma.UserWhereInput;
}

export function blockBetween(a: number, b: number) {
  return {
    OR: [
      { blockerId: a, blockedId: b },
      { blockerId: b, blockedId: a },
    ],
  } satisfies Prisma.BlockWhereInput;
}

export async function isBlocked(prisma: PrismaService, a: number, b: number) {
  if (a === b) return false;
  return (await prisma.block.count({ where: blockBetween(a, b) })) > 0;
}

export async function blockedWith(
  prisma: PrismaService,
  userId: number,
  others?: number[],
): Promise<Set<number>> {
  if (others?.length === 0) return new Set();
  const among = others && { in: others };
  const blocks = await prisma.block.findMany({
    where: {
      OR: [
        { blockerId: userId, ...(among && { blockedId: among }) },
        { blockedId: userId, ...(among && { blockerId: among }) },
      ],
    },
    select: { blockerId: true, blockedId: true },
  });
  return new Set(
    blocks.map(({ blockerId, blockedId }) =>
      blockerId === userId ? blockedId : blockerId,
    ),
  );
}

export async function blockedPairs(
  prisma: PrismaService,
  some: number[],
  others: number[],
) {
  const among = (ids: number[]) => ({ in: [...new Set(ids)] });
  const blocks =
    some.length === 0 || others.length === 0
      ? []
      : await prisma.block.findMany({
          where: {
            OR: [
              { blockerId: among(some), blockedId: among(others) },
              { blockerId: among(others), blockedId: among(some) },
            ],
          },
          select: { blockerId: true, blockedId: true },
        });
  const pairs = new Set(
    blocks.flatMap(({ blockerId, blockedId }) => [
      `${blockerId}:${blockedId}`,
      `${blockedId}:${blockerId}`,
    ]),
  );
  return (a: number, b: number) => pairs.has(`${a}:${b}`);
}

export async function blockedWithAny(
  prisma: PrismaService,
  userId: number,
  others: (number | null | undefined)[],
  { theirs = true } = {},
) {
  const among = {
    in: others.filter(
      (id): id is number => typeof id === 'number' && id !== userId,
    ),
  };
  if (among.in.length === 0) return false;
  const count = await prisma.block.count({
    where: {
      OR: [
        { blockerId: userId, blockedId: among },
        ...(theirs ? [{ blockedId: userId, blockerId: among }] : []),
      ],
    },
  });
  return count > 0;
}

export async function blockState(
  prisma: PrismaService,
  viewerId: number,
  otherId: number,
) {
  const blocks =
    viewerId === otherId
      ? []
      : await prisma.block.findMany({
          where: blockBetween(viewerId, otherId),
          select: { blockerId: true },
        });
  return {
    blocking: blocks.some(({ blockerId }) => blockerId === viewerId),
    blockedBy:
      blocks.some(({ blockerId }) => blockerId === otherId) &&
      !(await isSiteAdmin(prisma, viewerId)),
  };
}
