import { PrismaService } from '../prisma.service';
import { memberRole } from './communities.service';
import { CommunityRole } from './permissions';

export type AuthorModeration = { remove: boolean; ban: boolean };

export function canActOn(
  actorRole: CommunityRole | null,
  targetRole: CommunityRole | null,
) {
  if (actorRole !== 'owner' && actorRole !== 'admin') return false;
  if (targetRole === 'owner') return false;
  return targetRole !== 'admin' || actorRole === 'owner';
}

export async function authorModeration(
  prisma: PrismaService,
  viewerId: number,
  authors: { communityId: number; authorId: number }[],
) {
  const others = authors.filter(({ authorId }) => authorId !== viewerId);
  const communityIds = [
    ...new Set(others.map(({ communityId }) => communityId)),
  ];
  if (communityIds.length === 0) return () => null;

  const userIds = [
    viewerId,
    ...new Set(others.map(({ authorId }) => authorId)),
  ];
  const where = { communityId: { in: communityIds }, userId: { in: userIds } };
  const [memberships, bans] = await Promise.all([
    prisma.membership.findMany({
      where,
      select: {
        userId: true,
        communityId: true,
        community: { select: { ownerId: true } },
        roles: { select: { role: { select: { permissions: true } } } },
      },
    }),
    prisma.communityBan.findMany({
      where,
      select: { userId: true, communityId: true },
    }),
  ]);
  const roles = new Map(
    memberships.map(({ userId, communityId, community, roles: granted }) => [
      `${communityId}:${userId}`,
      memberRole(userId, community.ownerId, granted),
    ]),
  );
  const banned = new Set(
    bans.map(({ userId, communityId }) => `${communityId}:${userId}`),
  );

  return (communityId: number, authorId: number): AuthorModeration | null => {
    if (authorId === viewerId) return null;
    const targetRole = roles.get(`${communityId}:${authorId}`) ?? null;
    if (
      !canActOn(roles.get(`${communityId}:${viewerId}`) ?? null, targetRole)
    ) {
      return null;
    }
    const remove = targetRole !== null;
    const ban = !banned.has(`${communityId}:${authorId}`);
    return remove || ban ? { remove, ban } : null;
  };
}
