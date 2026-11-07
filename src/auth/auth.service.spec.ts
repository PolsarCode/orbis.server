import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { EmailConfirmationService } from './email-confirmation.service';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma.service';
import { sendInBackground } from '../common/email';

jest.mock('../common/email', () => ({ sendInBackground: jest.fn() }));

describe('Logging in to a suspended account', () => {
  const users = { findByEmail: jest.fn(), findByUsername: jest.fn() };
  const prisma = { user: { findUnique: jest.fn() } };
  const jwt = { sign: jest.fn(() => 'signed-token') };
  const service = new AuthService(
    users as unknown as UsersService,
    jwt as unknown as JwtService,
    {} as EmailConfirmationService,
    prisma as unknown as PrismaService,
  );

  beforeAll(async () => {
    users.findByUsername.mockResolvedValue({
      id: 7,
      email: 'naruto@anime.test',
      password: await bcrypt.hash('password', 4),
    });
  });

  beforeEach(() => {
    prisma.user.findUnique.mockReset();
    jwt.sign.mockClear();
  });

  it('refuses the right password while the account is suspended', async () => {
    prisma.user.findUnique.mockResolvedValue({
      suspendedAt: new Date(),
      suspendedUntil: null,
      suspensionReason: null,
    });

    const refusal = service.login('naruto', 'password');

    await expect(refusal).rejects.toThrow(ForbiddenException);
    await expect(refusal).rejects.toMatchObject({
      response: { code: 'account_suspended' },
    });
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('doesn’t reveal a suspension to someone with the wrong password', async () => {
    await expect(service.login('naruto', 'wrong')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('logs in an account that isn’t suspended', async () => {
    prisma.user.findUnique.mockResolvedValue({
      suspendedAt: null,
      suspendedUntil: null,
      suspensionReason: null,
    });

    await expect(service.login('naruto', 'password')).resolves.toEqual({
      access_token: 'signed-token',
    });
  });
});

describe('Logging in with two-factor sign-in on', () => {
  const realJwt = process.env.JWT_SECRET;
  const jwt = new JwtService({ secret: 'login-secret' });
  const users = { findByEmail: jest.fn(), findByUsername: jest.fn() };
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        suspendedAt: null,
        suspendedUntil: null,
        suspensionReason: null,
      }),
    },
  };
  const service = new AuthService(
    users as unknown as UsersService,
    jwt,
    {} as EmailConfirmationService,
    prisma as unknown as PrismaService,
  );

  beforeAll(async () => {
    process.env.JWT_SECRET = 'login-secret';
    users.findByUsername.mockResolvedValue({
      id: 7,
      email: 'naruto@anime.test',
      password: await bcrypt.hash('password', 4),
      twoFactorEnabledAt: new Date(),
    });
  });

  afterAll(() => {
    if (realJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = realJwt;
  });

  it('asks for a code instead of logging in', async () => {
    const result = await service.login('naruto', 'password');

    expect(result).not.toHaveProperty('access_token');
    expect(result).toHaveProperty('two_factor_ticket');
  });

  it('gives a ticket that can’t be used to sign requests', async () => {
    const { two_factor_ticket } = (await service.login(
      'naruto',
      'password',
    )) as { two_factor_ticket: string };

    expect(() => jwt.verify(two_factor_ticket)).toThrow();
  });
});

describe('Signing in while the account is scheduled for deletion', () => {
  const now = new Date('2026-11-07T12:00:00Z');
  const users = { findByEmail: jest.fn(), findByUsername: jest.fn() };
  const prisma = { user: { findUnique: jest.fn(), updateMany: jest.fn() } };
  const jwt = { sign: jest.fn(() => 'signed-token') };
  const service = new AuthService(
    users as unknown as UsersService,
    jwt as unknown as JwtService,
    {} as EmailConfirmationService,
    prisma as unknown as PrismaService,
  );

  function account(deleteAt: Date | null, emailVerifiedAt: Date | null = now) {
    prisma.user.findUnique.mockResolvedValue({
      suspendedAt: null,
      suspendedUntil: null,
      suspensionReason: null,
      email: 'naruto@anime.test',
      emailVerifiedAt,
      deleteAt,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now, doNotFake: ['nextTick', 'setImmediate'] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('cancels the deletion, says so and emails the person', async () => {
    account(new Date('2026-12-01T00:00:00Z'));
    prisma.user.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.generateToken(7, 'naruto@anime.test'),
    ).resolves.toEqual({ access_token: 'signed-token', restored: true });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 7, deleteAt: { gt: now } },
      data: { deleteAt: null },
    });
    expect(sendInBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'naruto@anime.test',
        subject: 'Your Orbis account deletion was cancelled',
      }),
    );
  });

  it('leaves an account without a scheduled deletion alone', async () => {
    account(null);

    await expect(
      service.generateToken(7, 'naruto@anime.test'),
    ).resolves.toEqual({ access_token: 'signed-token' });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(sendInBackground).not.toHaveBeenCalled();
  });

  it('doesn’t email an address that was never confirmed', async () => {
    account(new Date('2026-12-01T00:00:00Z'), null);
    prisma.user.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.generateToken(7, 'naruto@anime.test'),
    ).resolves.toEqual({ access_token: 'signed-token', restored: true });
    expect(sendInBackground).not.toHaveBeenCalled();
  });

  it('lets a second login at the same moment through once the first cancelled it', async () => {
    account(new Date('2026-12-01T00:00:00Z'));
    prisma.user.updateMany.mockResolvedValue({ count: 0 });
    prisma.user.findUnique
      .mockResolvedValueOnce({
        suspendedAt: null,
        suspendedUntil: null,
        suspensionReason: null,
      })
      .mockResolvedValueOnce({
        email: 'naruto@anime.test',
        emailVerifiedAt: now,
        deleteAt: new Date('2026-12-01T00:00:00Z'),
      })
      .mockResolvedValueOnce({ deleteAt: null });

    await expect(
      service.generateToken(7, 'naruto@anime.test'),
    ).resolves.toEqual({ access_token: 'signed-token' });
    expect(sendInBackground).not.toHaveBeenCalled();
  });

  it('says the account has been deleted once its grace period is over', async () => {
    account(new Date('2026-11-07T11:00:00Z'));
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    const refusal = service.generateToken(7, 'naruto@anime.test');

    await expect(refusal).rejects.toThrow(ForbiddenException);
    await expect(refusal).rejects.toThrow('This account has been deleted');
    expect(jwt.sign).not.toHaveBeenCalled();
    expect(sendInBackground).not.toHaveBeenCalled();
  });
});
