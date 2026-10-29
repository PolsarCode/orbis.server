import { ForbiddenException } from '@nestjs/common';
import { isSuspended, suspendedException } from './suspension';

describe('Account suspensions', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  const suspended = (until: string | null, reason: string | null = null) => ({
    suspendedAt: new Date('2026-10-29T12:00:00Z'),
    suspendedUntil: until ? new Date(until) : null,
    suspensionReason: reason,
  });

  it('counts an account as suspended until the suspension ends', () => {
    expect(isSuspended(suspended('2026-11-05T12:00:00Z'), now)).toBe(true);
    expect(isSuspended(suspended('2026-10-30T11:59:59Z'), now)).toBe(false);
  });

  it('keeps a ban in place with no end date', () => {
    expect(isSuspended(suspended(null), now)).toBe(true);
  });

  it('treats an account that was never suspended as active', () => {
    expect(isSuspended({ suspendedAt: null, suspendedUntil: null }, now)).toBe(
      false,
    );
  });

  it('tells a suspended person when they can come back and why', () => {
    const error = suspendedException(
      suspended('2026-11-05T12:30:00Z', 'Spamming invites.'),
    );

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse()).toMatchObject({
      code: 'account_suspended',
      message:
        'This account is suspended until Nov 5, 2026, 12:30 PM UTC. Reason: Spamming invites',
    });
  });

  it('tells a banned person the ban is permanent', () => {
    expect(suspendedException(suspended(null)).getResponse()).toMatchObject({
      code: 'account_suspended',
      message: 'This account has been banned',
    });
  });
});
