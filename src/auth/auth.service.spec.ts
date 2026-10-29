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
