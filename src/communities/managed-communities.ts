import { PrismaService } from '../prisma.service';
import { isAdministrator } from './permissions';

const managerSelect = {
  communityId: true,
  community: { select: { ownerId: true } },
  roles: { select: { role: { select: { permissions: true } } } },
} as const;

function managedBy(
  userId: number,
  memberships: {
    communityId: number;
    community: { ownerId: number };
    roles: { role: { permissions: bigint } }[];
  }[],
) {
  return memberships
    .filter(
      ({ community, roles }) =>
        community.ownerId === userId ||
        roles.some(({ role }) => isAdministrator(role.permissions)),
    )
    .map(({ communityId }) => communityId);
}

export async function managedCommunities(
  prisma: PrismaService,
  userId: number,
  communityIds: (number | null)[],
): Promise<Set<number>> {
  const ids = [
    ...new Set(communityIds.filter((id): id is number => id !== null)),
  ];
  if (ids.length === 0) return new Set();

  const memberships = await prisma.membership.findMany({
    where: { userId, communityId: { in: ids } },
    select: managerSelect,
  });
  return new Set(managedBy(userId, memberships));
}

export async function allManagedCommunities(
  prisma: PrismaService,
  userId: number,
): Promise<number[]> {
  const memberships = await prisma.membership.findMany({
    where: {
      userId,
      OR: [{ community: { ownerId: userId } }, { roles: { some: {} } }],
    },
    select: managerSelect,
  });
  return managedBy(userId, memberships);
}
