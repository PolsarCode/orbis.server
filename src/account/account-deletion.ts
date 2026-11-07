import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { sendInBackground } from '../common/email';
import { deletionCancelledEmail } from './deletion-emails';

export const DELETION_GRACE_DAYS = 30;
export const DELETION_CODE_SECONDS = 60;

export const accountDeleted = () =>
  new ForbiddenException('This account has been deleted');

export async function cancelDeletion(prisma: PrismaService, userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerifiedAt: true, deleteAt: true },
  });
  if (!user?.deleteAt) return false;

  const { count } = await prisma.user.updateMany({
    where: { id: userId, deleteAt: { gt: new Date() } },
    data: { deleteAt: null },
  });
  if (count === 0) {
    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { deleteAt: true },
    });
    if (current?.deleteAt && current.deleteAt <= new Date()) {
      throw accountDeleted();
    }
    return false;
  }
  if (user.emailVerifiedAt) {
    sendInBackground({ to: user.email, ...deletionCancelledEmail() });
  }
  return true;
}
