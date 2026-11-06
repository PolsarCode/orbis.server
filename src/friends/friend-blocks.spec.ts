import { ForbiddenException } from '@nestjs/common';
import { FriendsService } from './friends.service';
import { PrismaService } from '../prisma.service';
import { PresenceGateway } from './presence.gateway';
import { NotificationsService } from '../notifications/notifications.service';

const person = (id: number) => ({
  id,
  username: `user${id}`,
  name: `User ${id}`,
  avatarUrl: null,
  isVerified: false,
});

const fullSlots = { suggestionSlots: 10, suggestionSlotsAt: null };

function setup() {
  const prisma = {
    block: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    suggestionDismissal: { findMany: jest.fn().mockResolvedValue([]) },
    friendship: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
    membership: {
      findMany: jest.fn(({ where }) =>
        typeof where.userId === 'number'
          ? [{ communityId: 20 }]
          : where.userId.in.map((userId: number) => ({
              userId,
              community: { name: 'Seasonal Anime Club' },
            })),
      ),
      groupBy: jest.fn(({ where }) =>
        [8, 11, 12]
          .filter((userId) => !where.userId.notIn.includes(userId))
          .map((userId) => ({ userId, _count: { userId: 1 } })),
      ),
    },
    libraryEntry: { findMany: jest.fn().mockResolvedValue([]) },
    user: {
      findUnique: jest.fn(({ select }) =>
        select.showNsfw
          ? { showNsfw: false }
          : select.suggestionSlots
            ? fullSlots
            : { id: 6 },
      ),
      findMany: jest.fn(({ where }) =>
        where.id.in ? where.id.in.map(person) : [person(6)],
      ),
    },
  };
  const presence = { notify: jest.fn() };
  const notifications = { notify: jest.fn() };
  const service = new FriendsService(
    prisma as unknown as PrismaService,
    presence as unknown as PresenceGateway,
    notifications as unknown as NotificationsService,
  );
  return { prisma, presence, notifications, service };
}

describe('Friends across a block', () => {
  it.each([
    ['you blocked them', { blockerId: 1, blockedId: 6 }],
    ['they blocked you', { blockerId: 6, blockedId: 1 }],
  ])('refuses a friend request when %s', async (_case, row) => {
    const { prisma, presence, notifications, service } = setup();
    prisma.block.count.mockImplementation(
      ({ where }) =>
        where.OR.filter(
          (clause: typeof row) =>
            clause.blockerId === row.blockerId &&
            clause.blockedId === row.blockedId,
        ).length,
    );

    await expect(service.add(1, { userId: 6 })).rejects.toThrow(
      new ForbiddenException('You can’t send this person a friend request'),
    );

    expect(prisma.block.count).toHaveBeenCalledWith({
      where: {
        OR: [
          { blockerId: 1, blockedId: 6 },
          { blockerId: 6, blockedId: 1 },
        ],
      },
    });
    expect(prisma.friendship.create).not.toHaveBeenCalled();
    expect(prisma.friendship.update).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(presence.notify).not.toHaveBeenCalled();
  });

  it('still sends a friend request when nobody is blocked', async () => {
    const { prisma, notifications, service } = setup();

    await service.add(1, { userId: 6 });

    expect(prisma.friendship.create).toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 6, type: 'friend_request' }),
    ]);
  });

  it('leaves people blocked either way out of people search', async () => {
    const { prisma, service } = setup();

    await service.search(1, 'user');

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: 1 },
          blocksMade: { none: { blockedId: 1 } },
          blocksReceived: { none: { blockerId: 1 } },
        }),
      }),
    );
  });

  it('never suggests people blocked either way', async () => {
    const { prisma, service } = setup();
    prisma.block.findMany.mockResolvedValue([
      { blockerId: 1, blockedId: 8 },
      { blockerId: 11, blockedId: 1 },
    ]);

    const suggestions = await service.suggestions(1);

    expect(prisma.block.findMany).toHaveBeenCalledWith({
      where: { OR: [{ blockerId: 1 }, { blockedId: 1 }] },
      select: { blockerId: true, blockedId: true },
    });
    expect(prisma.membership.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: { notIn: expect.arrayContaining([1, 8, 11]) },
        }),
      }),
    );
    expect(
      suggestions.map(({ userId, reason }) => ({ userId, reason })),
    ).toEqual([{ userId: 12, reason: 'In Seasonal Anime Club' }]);
  });
});
