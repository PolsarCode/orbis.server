import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SuspendedAccountGuard } from './suspended-account.guard';
import { PrismaService } from '../prisma.service';

describe('SuspendedAccountGuard', () => {
  process.env.JWT_SECRET = 'test-secret';
  const prisma = { user: { findUnique: jest.fn() } };
  const guard = new SuspendedAccountGuard(prisma as unknown as PrismaService);
  const token = new JwtService({ secret: 'test-secret' }).sign({ sub: 7 });

  function context(method: string, authorization?: string) {
    return {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ method, headers: { authorization } }),
      }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('refuses every request from a suspended account, reading included', async () => {
    prisma.user.findUnique.mockResolvedValue({
      suspendedAt: new Date('2026-10-29T00:00:00Z'),
      suspendedUntil: null,
      suspensionReason: null,
    });

    const refusal = guard.canActivate(context('GET', `Bearer ${token}`));

    await expect(refusal).rejects.toThrow(ForbiddenException);
    await expect(refusal).rejects.toMatchObject({
      response: { code: 'account_suspended' },
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 } }),
    );
  });

  it('lets an account back in once its suspension has ended', async () => {
    prisma.user.findUnique.mockResolvedValue({
      suspendedAt: new Date('2026-10-01T00:00:00Z'),
      suspendedUntil: new Date('2026-10-02T00:00:00Z'),
      suspensionReason: null,
    });

    await expect(
      guard.canActivate(context('POST', `Bearer ${token}`)),
    ).resolves.toBe(true);
  });

  it('leaves guests and invalid tokens to the other guards', async () => {
    await expect(guard.canActivate(context('GET'))).resolves.toBe(true);
    await expect(
      guard.canActivate(context('GET', 'Bearer not-a-token')),
    ).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
