import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { EmailConfirmationService } from './email-confirmation.service';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma.service';

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
