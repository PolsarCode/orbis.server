import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { isHeadAdmin } from '../users/head-admin';

const HOUR = 60 * 60 * 1000;

export const NEW_ACCOUNT_PERIOD = 24 * HOUR;
export const ACCOUNT_TOO_NEW = 'account_too_new';

const LINK = /(?:https?:\/\/|mailto:|\bwww\.)[^\s"<]|href="\/\//i;

type Account = { createdAt: Date; isAdmin: boolean; email: string };

export function newAccountTimeLeft(account: Account, now = Date.now()) {
  if (account.isAdmin || isHeadAdmin(account.email)) return 0;
  return Math.max(0, account.createdAt.getTime() + NEW_ACCOUNT_PERIOD - now);
}

export async function accountTimeLeft(prisma: PrismaService, userId: number) {
  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: { createdAt: true, isAdmin: true, email: true },
  });
  return account ? newAccountTimeLeft(account) : 0;
}

export function containsLink(html: string, linkUrl?: string | null) {
  return Boolean(linkUrl) || LINK.test(html);
}

function waitText(timeLeft: number) {
  const hours = Math.ceil(timeLeft / HOUR);
  return hours <= 1 ? 'in about an hour' : `in about ${hours} hours`;
}

export async function requireEstablishedAccount(
  prisma: PrismaService,
  userId: number,
  action: string,
) {
  const timeLeft = await accountTimeLeft(prisma, userId);
  if (timeLeft > 0) {
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: ACCOUNT_TOO_NEW,
      message: `New accounts can ${action} after their first day. Try again ${waitText(timeLeft)}`,
    });
  }
}
