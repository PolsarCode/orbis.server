import type { PrismaService } from '../prisma.service';

export function isHeadAdmin(email: string) {
  const headAdmin = process.env.HEAD_ADMIN?.trim().toLowerCase();
  return Boolean(headAdmin) && email.toLowerCase() === headAdmin;
}

export async function isSiteAdmin(prisma: PrismaService, userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAdmin: true, email: true },
  });
  return Boolean(user && (user.isAdmin || isHeadAdmin(user.email)));
}
