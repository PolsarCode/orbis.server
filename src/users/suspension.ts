import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '../../prisma/generated/client';
import type { PrismaService } from '../prisma.service';

export const ACCOUNT_SUSPENDED = 'account_suspended';

export const SUSPENSION_DAYS = { '1d': 1, '7d': 7, '30d': 30 } as const;

export type SuspensionDuration = keyof typeof SUSPENSION_DAYS | 'permanent';

export type Suspension = {
  suspendedAt: Date | null;
  suspendedUntil: Date | null;
  suspensionReason: string | null;
};

export const suspensionFields = {
  suspendedAt: true,
  suspendedUntil: true,
  suspensionReason: true,
} satisfies Prisma.UserSelect;

export function isSuspended(
  user: Pick<Suspension, 'suspendedAt' | 'suspendedUntil'>,
  now = new Date(),
) {
  return (
    user.suspendedAt !== null &&
    (user.suspendedUntil === null || user.suspendedUntil > now)
  );
}

export function notSuspended(now = new Date()) {
  return {
    OR: [{ suspendedAt: null }, { suspendedUntil: { lte: now } }],
  } satisfies Prisma.UserWhereInput;
}

export function activeSuspension(user: Suspension, now = new Date()) {
  if (!isSuspended(user, now)) return null;
  return {
    until: user.suspendedUntil?.toISOString() ?? null,
    reason: user.suspensionReason,
  };
}

const untilFormat = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

export function suspendedException(user: Suspension) {
  const reason = user.suspensionReason?.trim().replace(/[.\s]+$/, '');
  const status = user.suspendedUntil
    ? `This account is suspended until ${untilFormat.format(user.suspendedUntil)} UTC`
    : 'This account has been banned';
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: ACCOUNT_SUSPENDED,
    message: reason ? `${status}. Reason: ${reason}` : status,
  });
}

export async function ensureNotSuspended(
  prisma: PrismaService,
  userId: number,
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: suspensionFields,
  });
  if (user && isSuspended(user)) throw suspendedException(user);
}
