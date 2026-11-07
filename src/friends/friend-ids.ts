import { PrismaService } from '../prisma.service';

export function friendshipBetween(userId: number, otherId: number) {
  return {
    OR: [
      { requesterId: userId, addresseeId: otherId },
      { requesterId: otherId, addresseeId: userId },
    ],
  };
}

export async function friendIdsAmong(
  prisma: PrismaService,
  userId: number,
  candidates: number[],
) {
  const friendships = await prisma.friendship.findMany({
    where: {
      status: 'accepted',
      OR: [
        { requesterId: userId, addresseeId: { in: candidates } },
        { addresseeId: userId, requesterId: { in: candidates } },
      ],
    },
    select: { requesterId: true, addresseeId: true },
  });
  return new Set(
    friendships.map(({ requesterId, addresseeId }) =>
      requesterId === userId ? addresseeId : requesterId,
    ),
  );
}
