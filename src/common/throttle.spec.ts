import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerStorage } from '@nestjs/throttler';
import { PrismaService } from '../prisma.service';
import {
  AppThrottlerGuard,
  HOUR,
  RateLimit,
  rateLimitMessage,
  throttlerOptions,
} from './throttle';

class Routes {
  @RateLimit(20, HOUR, 5)
  sendFriendRequest() {}

  @RateLimit(20, HOUR)
  search() {}
}

describe('Rate limits for new accounts', () => {
  const originalSecret = process.env.JWT_SECRET;
  const prisma = { user: { findUnique: jest.fn() } };
  const storage = {
    increment: jest.fn().mockResolvedValue({
      totalHits: 1,
      timeToExpire: 1,
      isBlocked: false,
      timeToBlockExpire: 0,
    }),
  };
  const guard = new AppThrottlerGuard(
    throttlerOptions,
    storage as unknown as ThrottlerStorage,
    new Reflector(),
    prisma as unknown as PrismaService,
  );

  const context = (route: keyof Routes, userId?: number) => {
    const authorization =
      userId === undefined
        ? undefined
        : `Bearer ${new JwtService().sign({ sub: userId }, { secret: 'test' })}`;
    return {
      getType: () => 'http',
      getHandler: () => Routes.prototype[route],
      getClass: () => Routes,
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization }, ip: '127.0.0.1' }),
        getResponse: () => ({ header: jest.fn() }),
      }),
    } as unknown as ExecutionContext;
  };

  const limitUsed = () => storage.increment.mock.calls[0][2];

  beforeAll(async () => {
    process.env.JWT_SECRET = 'test';
    await guard.onModuleInit();
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalSecret;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the lower limit for accounts under a day old', async () => {
    prisma.user.findUnique.mockResolvedValue({
      createdAt: new Date(Date.now() - HOUR),
      isAdmin: false,
      email: 'new@anime.test',
    });
    await guard.canActivate(context('sendFriendRequest', 7));
    expect(limitUsed()).toBe(5);
  });

  it('keeps the normal limit for older accounts', async () => {
    prisma.user.findUnique.mockResolvedValue({
      createdAt: new Date(Date.now() - 48 * HOUR),
      isAdmin: false,
      email: 'old@anime.test',
    });
    await guard.canActivate(context('sendFriendRequest', 7));
    expect(limitUsed()).toBe(20);
  });

  it('keeps the normal limit when nobody is signed in', async () => {
    await guard.canActivate(context('sendFriendRequest'));
    expect(limitUsed()).toBe(20);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('skips the account lookup on routes without a new-account limit', async () => {
    await guard.canActivate(context('search', 7));
    expect(limitUsed()).toBe(20);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('says how long to wait once a limit is reached', async () => {
    storage.increment.mockResolvedValueOnce({
      totalHits: 21,
      timeToExpire: 2700,
      isBlocked: true,
      timeToBlockExpire: 2700,
    });
    await expect(guard.canActivate(context('search'))).rejects.toThrow(
      'You’re doing that too often. Try again in 45 minutes',
    );
  });
});

describe('Rate limit messages', () => {
  it.each([
    [20, 'a minute'],
    [60, 'a minute'],
    [61, '2 minutes'],
    [59 * 60, '59 minutes'],
    [60 * 60, 'about an hour'],
    [3 * 60 * 60 + 600, 'about 3 hours'],
  ])('after %i seconds says "%s"', (seconds, wait) => {
    expect(rateLimitMessage(seconds)).toBe(
      `You’re doing that too often. Try again in ${wait}`,
    );
  });
});
