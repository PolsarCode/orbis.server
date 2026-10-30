import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TwoFactorService } from './two-factor.service';
import { PrismaService } from '../../prisma.service';
import { AuthService } from '../auth.service';
import { hashRecoveryCode } from './recovery-codes';
import { TWO_FACTOR_PURPOSE, ticketSecret } from './ticket';
import { timeStep, totpCode } from './totp';

type FakeUser = {
  id: number;
  username: string;
  email: string;
  password: string | null;
  isAdmin: boolean;
  twoFactorSecret: string | null;
  twoFactorEnabledAt: Date | null;
  twoFactorCodes: string[];
  twoFactorLastStep: number | null;
};

function makeUser(fields: Partial<FakeUser> & { id: number }): FakeUser {
  return {
    username: `user${fields.id}`,
    email: `user${fields.id}@example.test`,
    password: 'hash',
    isAdmin: false,
    twoFactorSecret: null,
    twoFactorEnabledAt: null,
    twoFactorCodes: [],
    twoFactorLastStep: null,
    ...fields,
  };
}

function fakePrisma(users: FakeUser[]) {
  const find = ({ where }: { where: { id?: number; username?: string } }) =>
    users.find((user) =>
      where.id !== undefined
        ? user.id === where.id
        : user.username === where.username,
    ) ?? null;
  return {
    user: {
      findUnique: jest.fn(async (args) => find(args)),
      findUniqueOrThrow: jest.fn(async (args) => {
        const user = find(args);
        if (!user) throw new Error('missing');
        return user;
      }),
      update: jest.fn(async ({ where, data }) =>
        Object.assign(find({ where })!, data),
      ),
      updateMany: jest.fn(async ({ where, data }) => {
        const user = find({ where });
        if (!user) return { count: 0 };
        if (where.OR) {
          const step = where.OR[1].twoFactorLastStep.lt;
          if (
            user.twoFactorLastStep !== null &&
            user.twoFactorLastStep >= step
          ) {
            return { count: 0 };
          }
        }
        if (
          where.twoFactorCodes &&
          !user.twoFactorCodes.includes(where.twoFactorCodes.has)
        ) {
          return { count: 0 };
        }
        Object.assign(user, data);
        return { count: 1 };
      }),
    },
  };
}

describe('Two-factor sign-in', () => {
  const realKey = process.env.TWO_FACTOR_KEY;
  const realJwt = process.env.JWT_SECRET;
  const jwt = new JwtService({ secret: 'jwt-secret' });
  const auth = {
    generateToken: jest.fn(async () => ({ access_token: 'token' })),
  };

  beforeAll(() => {
    process.env.TWO_FACTOR_KEY = 'two-factor-key';
    process.env.JWT_SECRET = 'jwt-secret';
  });

  afterAll(() => {
    if (realKey === undefined) delete process.env.TWO_FACTOR_KEY;
    else process.env.TWO_FACTOR_KEY = realKey;
    if (realJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = realJwt;
  });

  beforeEach(() => jest.clearAllMocks());

  function serviceFor(users: FakeUser[]) {
    const prisma = fakePrisma(users);
    const service = new TwoFactorService(
      prisma as unknown as PrismaService,
      jwt,
      auth as unknown as AuthService,
    );
    return { prisma, service };
  }

  async function turnOn(users: FakeUser[]) {
    const { service } = serviceFor(users);
    const { secret, qrCode } = await service.setup(1);
    const { recoveryCodes } = await service.enable(
      1,
      totpCode(secret, timeStep()),
    );
    return { service, secret, qrCode, recoveryCodes };
  }

  const ticketFor = (userId: number) =>
    jwt.sign(
      { sub: userId, purpose: TWO_FACTOR_PURPOSE },
      { secret: ticketSecret() },
    );

  it('sets up with a QR code and turns on with a correct code', async () => {
    const users = [makeUser({ id: 1 })];
    const { secret, qrCode, recoveryCodes } = await turnOn(users);

    expect(qrCode).toMatch(/^data:image\/png;base64,/);
    expect(users[0].twoFactorSecret).not.toContain(secret);
    expect(users[0].twoFactorEnabledAt).toBeInstanceOf(Date);
    expect(recoveryCodes).toHaveLength(10);
    expect(users[0].twoFactorCodes).toEqual(
      recoveryCodes.map(hashRecoveryCode),
    );
  });

  it('refuses a wrong code when turning on', async () => {
    const users = [makeUser({ id: 1 })];
    const { service } = serviceFor(users);
    await service.setup(1);

    await expect(service.enable(1, '000000')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(users[0].twoFactorEnabledAt).toBeNull();
  });

  it('isn’t offered to accounts without a password, or set up twice', async () => {
    const { service } = serviceFor([
      makeUser({ id: 1, password: null }),
      makeUser({ id: 2, twoFactorEnabledAt: new Date() }),
    ]);

    await expect(service.setup(1)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.setup(2)).rejects.toBeInstanceOf(ConflictException);
  });

  it('finishes logging in with a code, and never accepts the same code twice', async () => {
    const users = [makeUser({ id: 1 })];
    const { service, secret } = await turnOn(users);
    users[0].twoFactorLastStep = timeStep() - 2;
    const code = totpCode(secret, timeStep());

    await expect(service.completeLogin(ticketFor(1), code)).resolves.toEqual({
      access_token: 'token',
    });
    await expect(
      service.completeLogin(ticketFor(1), code),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts each recovery code once', async () => {
    const users = [makeUser({ id: 1 })];
    const { service, recoveryCodes } = await turnOn(users);

    await service.completeLogin(ticketFor(1), recoveryCodes[0].toUpperCase());
    expect(users[0].twoFactorCodes).toHaveLength(9);
    await expect(
      service.completeLogin(ticketFor(1), recoveryCodes[0]),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects login tokens and expired or forged tickets', async () => {
    const users = [makeUser({ id: 1 })];
    const { service, recoveryCodes } = await turnOn(users);
    const loginToken = jwt.sign({ sub: 1, email: users[0].email });
    const expired = jwt.sign(
      { sub: 1, purpose: TWO_FACTOR_PURPOSE },
      { secret: ticketSecret(), expiresIn: -10 },
    );

    for (const ticket of [loginToken, expired, 'nonsense']) {
      await expect(
        service.completeLogin(ticket, recoveryCodes[0]),
      ).rejects.toThrow('Your sign-in timed out. Log in again');
    }
    expect(auth.generateToken).not.toHaveBeenCalled();
  });

  it('turns off only with a valid code', async () => {
    const users = [makeUser({ id: 1 })];
    const { service, recoveryCodes } = await turnOn(users);

    await expect(service.disable(1, '000000')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await service.disable(1, recoveryCodes[3]);
    expect(users[0]).toEqual(
      expect.objectContaining({
        twoFactorSecret: null,
        twoFactorEnabledAt: null,
        twoFactorCodes: [],
      }),
    );
  });

  it('lets site admins remove someone’s two-factor sign-in, with the same limits as suspensions', async () => {
    const on = {
      twoFactorEnabledAt: new Date(),
      twoFactorSecret: 'x',
      twoFactorCodes: ['a'],
    };
    const users = [
      makeUser({ id: 1, isAdmin: true }),
      makeUser({ id: 2, ...on }),
      makeUser({ id: 3, isAdmin: true, ...on }),
      makeUser({ id: 4 }),
    ];
    const { service } = serviceFor(users);

    await expect(service.reset(1, 'user2')).resolves.toEqual({
      twoFactorEnabled: false,
    });
    expect(users[1].twoFactorEnabledAt).toBeNull();
    await expect(service.reset(1, 'user3')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.reset(1, 'user1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.reset(4, 'user2')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
