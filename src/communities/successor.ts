import { PrismaService } from '../prisma.service';
import { isAdministrator } from './permissions';

export async function communitySuccessor(
  prisma: PrismaService,
  communityId: number,
  ownerId: number,
) {
  const members = await prisma.membership.findMany({
    where: { communityId, userId: { not: ownerId }, roles: { some: {} } },
    orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
    select: {
      user: {
        select: { id: true, username: true, name: true, deleteAt: true },
      },
      roles: { select: { role: { select: { permissions: true } } } },
    },
  });
  const admins = members
    .filter(({ roles }) =>
      roles.some(({ role }) => isAdministrator(role.permissions)),
    )
    .map(({ user }) => user);
  const admin = admins.find(({ deleteAt }) => !deleteAt) ?? admins[0];
  return admin
    ? { id: admin.id, username: admin.username, name: admin.name }
    : null;
}
