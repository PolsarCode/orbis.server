import { BadRequestException } from '@nestjs/common';
import { AccountDeletionService } from './account-deletion.service';
import { PrismaService } from '../prisma.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { sendInBackground } from '../common/email';
import { ADMINISTRATOR } from '../communities/permissions';

jest.mock('../common/email', () => ({ sendInBackground: jest.fn() }));

describe('Deleting your own account', () => {
  const now = new Date('2026-11-07T12:00:00Z');
  const prisma = {
    user: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
    community: { findMany: jest.fn() },
    membership: { findMany: jest.fn() },
  };
  const presence = { disconnectUser: jest.fn() };
  const service = new AccountDeletionService(
    prisma as unknown as PrismaService,
    presence as unknown as PresenceGateway,
  );

  function challenge(
    code: string | null,
    expiresAt: Date | null,
    emailVerifiedAt: Date | null = now,
  ) {
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      email: 'naruto@anime.test',
      emailVerifiedAt,
      deletionCode: code,
      deletionCodeExpiresAt: expiresAt,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now, doNotFake: ['nextTick', 'setImmediate'] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('the confirmation code', () => {
    it('hands out a fresh 6-digit code that lasts 60 seconds, replacing the last one', async () => {
      const { code, expiresIn } = await service.issueCode(7);

      expect(code).toMatch(/^\d{6}$/);
      expect(expiresIn).toBe(60);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: {
          deletionCode: code,
          deletionCodeExpiresAt: new Date('2026-11-07T12:01:00Z'),
        },
      });
    });

    it('asks for the 6-digit code when it’s missing or malformed', async () => {
      for (const code of [undefined, '', '12345', '1234567', 'abcdef']) {
        await expect(service.schedule(7, code)).rejects.toThrow(
          new BadRequestException('Enter the 6-digit code'),
        );
      }
      expect(prisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('asks to start again when no code was handed out', async () => {
      challenge(null, null);

      await expect(service.schedule(7, '123456')).rejects.toThrow(
        new BadRequestException('Start the deletion again'),
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses an expired code and clears it', async () => {
      challenge('123456', new Date('2026-11-07T11:59:59Z'));

      await expect(service.schedule(7, '123456')).rejects.toThrow(
        new BadRequestException('The code expired. Start over'),
      );
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { deletionCode: null, deletionCodeExpiresAt: null },
      });
      expect(presence.disconnectUser).not.toHaveBeenCalled();
    });

    it('refuses a wrong code without scheduling anything', async () => {
      challenge('123456', new Date('2026-11-07T12:00:30Z'));

      await expect(service.schedule(7, '654321')).rejects.toThrow(
        new BadRequestException('That code isn’t correct'),
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(presence.disconnectUser).not.toHaveBeenCalled();
    });
  });

  it('schedules the deletion 30 days out, signs out everywhere and emails the date', async () => {
    challenge('123456', new Date('2026-11-07T12:00:30Z'));

    await expect(service.schedule(7, ' 123456 ')).resolves.toEqual({
      deleteAt: '2026-12-07T12:00:00.000Z',
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: {
        deletionCode: null,
        deletionCodeExpiresAt: null,
        deleteAt: new Date('2026-12-07T12:00:00Z'),
        sessionsRevokedAt: now,
      },
    });
    expect(presence.disconnectUser).toHaveBeenCalledWith(7);
    expect(sendInBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'naruto@anime.test',
        subject: 'Your Orbis account is scheduled for deletion',
        text: expect.stringContaining('December 7, 2026'),
      }),
    );
  });

  it('doesn’t email an address that was never confirmed', async () => {
    challenge('123456', new Date('2026-11-07T12:00:30Z'), null);

    await service.schedule(7, '123456');

    expect(presence.disconnectUser).toHaveBeenCalledWith(7);
    expect(sendInBackground).not.toHaveBeenCalled();
  });

  it('shows which owned communities pass to their longest-serving admin, preferring one who isn’t leaving too, and which are deleted', async () => {
    prisma.community.findMany.mockResolvedValue([
      { id: 3, name: 'Hidden Leaf' },
      { id: 4, name: 'Ramen Club' },
    ]);
    const admin = { role: { permissions: ADMINISTRATOR } };
    const member = { role: { permissions: BigInt(0) } };
    prisma.membership.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.communityId === 3
          ? [
              {
                user: {
                  id: 8,
                  username: 'sakura',
                  name: 'Sakura',
                  deleteAt: null,
                },
                roles: [member],
              },
              {
                user: {
                  id: 9,
                  username: 'kakashi',
                  name: null,
                  deleteAt: new Date('2026-12-01T00:00:00Z'),
                },
                roles: [admin],
              },
              {
                user: {
                  id: 10,
                  username: 'sasuke',
                  name: null,
                  deleteAt: null,
                },
                roles: [admin],
              },
            ]
          : [],
      ),
    );

    await expect(service.preview(7)).resolves.toEqual({
      ownedCommunities: [
        {
          id: 3,
          name: 'Hidden Leaf',
          successor: { username: 'sasuke', name: null },
        },
        { id: 4, name: 'Ramen Club', successor: null },
      ],
    });
    prisma.membership.findMany.mockResolvedValueOnce([
      {
        user: {
          id: 9,
          username: 'kakashi',
          name: null,
          deleteAt: new Date('2026-12-01T00:00:00Z'),
        },
        roles: [admin],
      },
    ]);
    prisma.community.findMany.mockResolvedValueOnce([
      { id: 3, name: 'Hidden Leaf' },
    ]);
    await expect(service.preview(7)).resolves.toEqual({
      ownedCommunities: [
        {
          id: 3,
          name: 'Hidden Leaf',
          successor: { username: 'kakashi', name: null },
        },
      ],
    });
    expect(prisma.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { communityId: 3, userId: { not: 7 }, roles: { some: {} } },
        orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
      }),
    );
  });
});
