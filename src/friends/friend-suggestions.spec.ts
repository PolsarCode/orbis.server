import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FriendsService } from './friends.service';
import { PrismaService } from '../prisma.service';
import { PresenceGateway } from './presence.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import {
  availableSlots,
  rankCandidates,
  spendSlot,
  titleReason,
} from './suggestions';

const person = (id: number) => ({
  id,
  username: `user${id}`,
  name: `User ${id}`,
  avatarUrl: null,
  isVerified: false,
});

const SUSPENDED = 9;
const HOUR = 60 * 60 * 1000;
const fullSlots = { suggestionSlots: 10, suggestionSlotsAt: null };

function prismaFor(slots: object = fullSlots) {
  return {
    suggestionDismissal: {
      findMany: jest.fn((): { dismissedUserId: number }[] => []),
    },
    friendship: {
      findMany: jest.fn(({ where }) =>
        where.status === 'accepted'
          ? [
              { requesterId: 2, addresseeId: 6 },
              { requesterId: 6, addresseeId: 3 },
              { requesterId: 2, addresseeId: 7 },
            ]
          : [
              { requesterId: 1, addresseeId: 2, status: 'accepted' },
              { requesterId: 3, addresseeId: 1, status: 'accepted' },
              { requesterId: 1, addresseeId: 4, status: 'pending' },
              { requesterId: 5, addresseeId: 1, status: 'pending' },
            ],
      ),
    },
    membership: {
      findMany: jest.fn(({ where }) =>
        typeof where.userId === 'number'
          ? [{ communityId: 20 }]
          : [{ userId: 8, community: { name: 'Seasonal Anime Club' } }],
      ),
      groupBy: jest.fn(() => [
        { userId: 8, _count: { userId: 2 } },
        { userId: 7, _count: { userId: 1 } },
        { userId: SUSPENDED, _count: { userId: 1 } },
      ]),
    },
    libraryEntry: {
      findMany: jest.fn(({ where }) =>
        typeof where.userId === 'number'
          ? [{ mediaId: 'anime:1' }, { mediaId: 'anime:2' }]
          : [
              {
                userId: 10,
                title: 'Sousou no Frieren',
                mediaType: 'anime',
                status: 'completed',
              },
              {
                userId: 10,
                title: 'Steins;Gate',
                mediaType: 'anime',
                status: 'current',
              },
            ],
      ),
      groupBy: jest.fn(() => [
        { userId: 10, _count: { userId: 1 } },
        { userId: SUSPENDED, _count: { userId: 3 } },
      ]),
    },
    user: {
      findUnique: jest.fn(({ select }) =>
        select.showNsfw ? { showNsfw: false } : slots,
      ),
      findUniqueOrThrow: jest.fn(() => slots),
      update: jest.fn(),
      findMany: jest.fn(({ where }) =>
        where.id.in
          .filter((id: number) => !(where.OR && id === SUSPENDED))
          .map(person),
      ),
    },
  };
}

function serviceWith(prisma: ReturnType<typeof prismaFor>) {
  return new FriendsService(
    prisma as unknown as PrismaService,
    {} as PresenceGateway,
    {} as NotificationsService,
  );
}

describe('Friend suggestions', () => {
  it('ranks mutual friends above shared communities and titles', () => {
    expect(
      rankCandidates({
        mutual: new Map([[6, [2, 3]]]),
        communities: new Map([
          [7, 1],
          [8, 2],
        ]),
        titles: new Map([
          [7, 1],
          [10, 1],
        ]),
      }),
    ).toEqual([6, 8, 7, 10]);
  });

  it('describes a shared title by what they’re doing with it', () => {
    expect(
      titleReason({ title: 'Berserk', mediaType: 'manga', status: 'current' }),
    ).toBe('Also reading Berserk');
    expect(
      titleReason({ title: 'Hades', mediaType: 'game', status: 'completed' }),
    ).toBe('Also finished Hades');
  });

  it('suggests people with a reason each, best match first', async () => {
    const suggestions = await serviceWith(prismaFor()).suggestions(1);

    expect(
      suggestions.map(({ userId, reason }) => ({ userId, reason })),
    ).toEqual([
      { userId: 6, reason: '2 mutual friends' },
      { userId: 7, reason: '1 mutual friend' },
      { userId: 8, reason: 'In Seasonal Anime Club' },
      { userId: 10, reason: 'Also watching Steins;Gate' },
    ]);
    expect(suggestions[0].mutualFriends.map(({ userId }) => userId)).toEqual([
      2, 3,
    ]);
  });

  it('leaves out the viewer, friends, pending requests, and suspended accounts', async () => {
    const prisma = prismaFor();
    const suggestions = await serviceWith(prisma).suggestions(1);

    const excluded = [1, 2, 3, 4, 5];
    expect(prisma.membership.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: { notIn: expect.arrayContaining(excluded) },
        }),
      }),
    );
    expect(prisma.libraryEntry.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: { notIn: expect.arrayContaining(excluded) },
          isPublic: true,
          isAdult: false,
        }),
      }),
    );
    expect(suggestions.map(({ userId }) => userId)).not.toContain(SUSPENDED);
  });

  it('suggests nobody when there is nothing in common', async () => {
    const prisma = prismaFor();
    prisma.friendship.findMany.mockReturnValue([]);
    prisma.membership.findMany.mockReturnValue([]);
    prisma.libraryEntry.findMany.mockReturnValue([]);

    await expect(serviceWith(prisma).suggestions(1)).resolves.toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('leaves out people removed in the last month', async () => {
    const prisma = prismaFor();
    prisma.suggestionDismissal.findMany.mockReturnValue([
      { dismissedUserId: 8 },
    ]);
    await serviceWith(prisma).suggestions(1);

    const [[query]] = prisma.suggestionDismissal.findMany.mock
      .calls as unknown as [[{ where: { dismissedAt: { gt: Date } } }]];
    const since = query.where.dismissedAt.gt;
    const days = (Date.now() - since.getTime()) / (24 * HOUR);
    expect(Math.round(days)).toBe(30);
    expect(prisma.membership.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: { notIn: expect.arrayContaining([1, 2, 3, 4, 5, 8]) },
        }),
      }),
    );
  });

  it('shows fewer people once suggestion slots are used up', async () => {
    const limited = await serviceWith(
      prismaFor({ suggestionSlots: 2, suggestionSlotsAt: new Date() }),
    ).suggestions(1);
    expect(limited.map(({ userId }) => userId)).toEqual([6, 7]);

    const prisma = prismaFor({
      suggestionSlots: 0,
      suggestionSlotsAt: new Date(),
    });
    await expect(serviceWith(prisma).suggestions(1)).resolves.toEqual([]);
    expect(prisma.friendship.findMany).not.toHaveBeenCalled();
  });
});

describe('Suggestion slots', () => {
  const start = new Date('2026-10-30T00:00:00Z');
  const later = (hours: number) => new Date(start.getTime() + hours * HOUR);

  it('starts full and gives one back every hour, up to ten', () => {
    expect(availableSlots(fullSlots, start)).toBe(10);
    const used = { suggestionSlots: 6, suggestionSlotsAt: start };
    expect(availableSlots(used, later(0.5))).toBe(6);
    expect(availableSlots(used, later(1))).toBe(7);
    expect(availableSlots(used, later(4))).toBe(10);
    expect(availableSlots(used, later(30))).toBe(10);
  });

  it('keeps the progress toward the next slot when one is spent', () => {
    const first = spendSlot(fullSlots, start);
    expect(first).toEqual({ suggestionSlots: 9, suggestionSlotsAt: start });
    const second = spendSlot(first, start);
    expect(second).toEqual({ suggestionSlots: 8, suggestionSlotsAt: start });

    const third = spendSlot(second, later(1.5));
    expect(third).toEqual({ suggestionSlots: 8, suggestionSlotsAt: later(1) });
    expect(availableSlots(third, later(2))).toBe(9);
    expect(availableSlots(third, later(3))).toBe(10);
  });

  it('restarts the clock when a slot is spent from a full set', () => {
    const spent = spendSlot(
      { suggestionSlots: 9, suggestionSlotsAt: start },
      later(1.5),
    );
    expect(spent).toEqual({
      suggestionSlots: 9,
      suggestionSlotsAt: later(1.5),
    });
  });

  it('spends a slot only for friends added from a suggestion', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn(() => ({ id: 6 })),
        findUniqueOrThrow: jest.fn(() => fullSlots),
        update: jest.fn(),
      },
      friendship: { findFirst: jest.fn(() => null), create: jest.fn() },
    };
    const service = new FriendsService(
      prisma as unknown as PrismaService,
      { notify: jest.fn() } as unknown as PresenceGateway,
      { notify: jest.fn() } as unknown as NotificationsService,
    );

    await service.add(1, { userId: 6 });
    expect(prisma.user.update).not.toHaveBeenCalled();

    await service.add(1, { userId: 7, fromSuggestion: true });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({ suggestionSlots: 9 }),
    });
  });
});

describe('Removing a suggestion', () => {
  function setup(target: object | null = { id: 6 }) {
    const prisma = {
      user: {
        findUnique: jest.fn(() => target),
        findUniqueOrThrow: jest.fn(() => fullSlots),
        update: jest.fn(),
      },
      suggestionDismissal: { upsert: jest.fn() },
    };
    const service = new FriendsService(
      prisma as unknown as PrismaService,
      {} as PresenceGateway,
      {} as NotificationsService,
    );
    return { prisma, service };
  }

  it('remembers when they were removed and uses up a slot', async () => {
    const { prisma, service } = setup();

    await service.dismissSuggestion(1, 6);

    expect(prisma.suggestionDismissal.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_dismissedUserId: { userId: 1, dismissedUserId: 6 } },
        update: { dismissedAt: expect.any(Date) },
      }),
    );
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({ suggestionSlots: 9 }),
    });
  });

  it('refuses yourself and people who don’t exist', async () => {
    const { service } = setup(null);

    await expect(service.dismissSuggestion(1, 1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.dismissSuggestion(1, 99)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
