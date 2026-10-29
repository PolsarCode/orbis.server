import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  ACCOUNT_TOO_NEW,
  containsLink,
  newAccountTimeLeft,
  requireEstablishedAccount,
} from './new-account';

const HOUR = 60 * 60 * 1000;
const now = Date.parse('2026-10-29T12:00:00Z');
const account = (
  ageHours: number,
  extra: Partial<{ isAdmin: boolean; email: string }> = {},
) => ({
  createdAt: new Date(now - ageHours * HOUR),
  isAdmin: false,
  email: 'fan@anime.test',
  ...extra,
});

describe('New accounts', () => {
  const originalHeadAdmin = process.env.HEAD_ADMIN;

  beforeEach(() => {
    process.env.HEAD_ADMIN = 'boss@orbis.test';
  });

  afterAll(() => {
    process.env.HEAD_ADMIN = originalHeadAdmin;
  });

  it('counts the first 24 hours after sign-up', () => {
    expect(newAccountTimeLeft(account(19), now)).toBe(5 * HOUR);
    expect(newAccountTimeLeft(account(24), now)).toBe(0);
    expect(newAccountTimeLeft(account(72), now)).toBe(0);
  });

  it('never treats site admins as new', () => {
    expect(newAccountTimeLeft(account(1, { isAdmin: true }), now)).toBe(0);
    expect(
      newAccountTimeLeft(account(1, { email: 'Boss@Orbis.test' }), now),
    ).toBe(0);
  });

  it('finds web links in content and link previews', () => {
    expect(containsLink('<p><a href="https://spam.test">deal</a></p>')).toBe(
      true,
    );
    expect(containsLink('<p>visit http://spam.test now</p>')).toBe(true);
    expect(containsLink('<p>visit www.spam.test now</p>')).toBe(true);
    expect(containsLink('<p><a href="mailto:me@spam.test">mail</a></p>')).toBe(
      true,
    );
    expect(containsLink('<p><a href="//spam.test">deal</a></p>')).toBe(true);
    expect(containsLink('<p>hi</p>', 'https://youtube.com/watch?v=1')).toBe(
      true,
    );
  });

  it('ignores mentions and plain text', () => {
    expect(
      containsLink(
        '<p>hi <a href="/users/naruto" class="mention">@naruto</a></p>',
      ),
    ).toBe(false);
    expect(containsLink('<p>Episode 3 was great, 10/10</p>', null)).toBe(false);
  });

  it('refuses new accounts with a code and the time left', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(account(19)) },
    };
    jest.spyOn(Date, 'now').mockReturnValue(now);

    const refusal = requireEstablishedAccount(
      prisma as unknown as PrismaService,
      7,
      'post links',
    );

    await expect(refusal).rejects.toThrow(ForbiddenException);
    await expect(refusal).rejects.toMatchObject({
      response: {
        code: ACCOUNT_TOO_NEW,
        message:
          'New accounts can post links after their first day. Try again in about 5 hours',
      },
    });
    jest.restoreAllMocks();
  });

  it('lets older accounts through', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(account(30)) },
    };
    jest.spyOn(Date, 'now').mockReturnValue(now);

    await expect(
      requireEstablishedAccount(
        prisma as unknown as PrismaService,
        7,
        'post links',
      ),
    ).resolves.toBeUndefined();
    jest.restoreAllMocks();
  });
});
