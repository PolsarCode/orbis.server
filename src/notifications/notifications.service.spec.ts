import { NewNotification, NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma.service';
import { PresenceGateway } from '../friends/presence.gateway';

describe('NotificationsService.notify', () => {
  const date = new Date('2026-10-24T12:00:00Z');
  const row = (id: number, userId: number) => ({
    id,
    userId,
    type: 'friend_request',
    message: 'sent you a friend request',
    link: '/',
    readAt: null,
    createdAt: date,
    actor: { id: 9, username: 'admin', name: 'Admin', avatarUrl: null },
  });
  const createManyAndReturn = jest.fn();
  const block = { findMany: jest.fn().mockResolvedValue([]) };
  const mute = { findMany: jest.fn().mockResolvedValue([]) };
  const prisma = { notification: { createManyAndReturn }, block, mute };
  const presence = { notify: jest.fn() };
  const service = new NotificationsService(
    prisma as unknown as PrismaService,
    presence as unknown as PresenceGateway,
  );

  const input = (userId: number, actorId: number | null = 9) => ({
    userId,
    actorId,
    type: 'friend_request' as const,
    message: 'sent you a friend request',
    link: '/',
  });

  beforeEach(() => jest.clearAllMocks());

  it('sends each recipient only their own new notifications', async () => {
    createManyAndReturn.mockResolvedValue([row(1, 4), row(2, 5), row(3, 4)]);

    await service.notify([input(4), input(5)]);

    expect(presence.notify).toHaveBeenCalledTimes(2);
    expect(presence.notify).toHaveBeenCalledWith([4], 'notifications:changed', {
      notifications: [
        expect.objectContaining({ id: 1, actor: expect.any(Object) }),
        expect.objectContaining({ id: 3 }),
      ],
    });
    const [, , payload] = presence.notify.mock.calls[1];
    expect(payload.notifications.map(({ id }: { id: number }) => id)).toEqual([
      2,
    ]);
    expect(payload.notifications[0]).not.toHaveProperty('userId');
  });

  it('skips notifications about yourself and sends nothing when none remain', async () => {
    await service.notify([input(9, 9)]);

    expect(createManyAndReturn).not.toHaveBeenCalled();
    expect(presence.notify).not.toHaveBeenCalled();
  });
});

describe('Notifications across blocks and mutes', () => {
  const createManyAndReturn = jest.fn(({ data }) =>
    data.map((item: { userId: number }, index: number) => ({
      id: index + 1,
      ...item,
    })),
  );
  const block = { findMany: jest.fn() };
  const mute = { findMany: jest.fn() };
  const prisma = { notification: { createManyAndReturn }, block, mute };
  const presence = { notify: jest.fn() };
  const service = new NotificationsService(
    prisma as unknown as PrismaService,
    presence as unknown as PresenceGateway,
  );

  const note = (
    userId: number,
    actorId: number,
    type: NewNotification['type'] = 'post_comment',
  ): NewNotification => ({
    userId,
    actorId,
    type,
    message: 'commented on your post',
    link: '/',
  });

  function created() {
    return createManyAndReturn.mock.calls.flatMap(([{ data }]) =>
      data.map(({ userId, actorId, type }: NewNotification) => ({
        userId,
        actorId,
        type,
      })),
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    block.findMany.mockResolvedValue([]);
    mute.findMany.mockResolvedValue([]);
  });

  it('drops notifications between people blocked either way', async () => {
    block.findMany.mockResolvedValue([
      { blockerId: 4, blockedId: 9 },
      { blockerId: 8, blockedId: 5 },
    ]);

    await service.notify([
      note(4, 9),
      note(5, 8, 'mention'),
      note(6, 9, 'comment_reply'),
      note(4, 8, 'friend_request'),
    ]);

    expect(block.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { blockerId: { in: [4, 5, 6] }, blockedId: { in: [9, 8] } },
          { blockerId: { in: [9, 8] }, blockedId: { in: [4, 5, 6] } },
        ],
      },
      select: { blockerId: true, blockedId: true },
    });
    expect(created()).toEqual([
      { userId: 6, actorId: 9, type: 'comment_reply' },
      { userId: 4, actorId: 8, type: 'friend_request' },
    ]);
  });

  it('drops friend requests across a block too', async () => {
    block.findMany.mockResolvedValue([{ blockerId: 4, blockedId: 9 }]);

    await service.notify([
      note(4, 9, 'friend_request'),
      note(9, 4, 'friend_accepted'),
    ]);

    expect(createManyAndReturn).not.toHaveBeenCalled();
    expect(presence.notify).not.toHaveBeenCalled();
  });

  it('drops notifications from muted people except friend requests', async () => {
    mute.findMany.mockResolvedValue([{ muterId: 4, mutedId: 9 }]);

    await service.notify([
      note(4, 9),
      note(4, 9, 'mention'),
      note(4, 9, 'forum_reply'),
      note(4, 9, 'friend_request'),
      note(4, 9, 'friend_accepted'),
      note(5, 9, 'mention'),
    ]);

    expect(mute.findMany).toHaveBeenCalledWith({
      where: { muterId: { in: [4, 5] }, mutedId: { in: [9] } },
      select: { muterId: true, mutedId: true },
    });
    expect(created()).toEqual([
      { userId: 4, actorId: 9, type: 'friend_request' },
      { userId: 4, actorId: 9, type: 'friend_accepted' },
      { userId: 5, actorId: 9, type: 'mention' },
    ]);
  });

  it('never drops ticket updates, even from someone blocked or muted', async () => {
    block.findMany.mockResolvedValue([{ blockerId: 4, blockedId: 9 }]);
    mute.findMany.mockResolvedValue([{ muterId: 5, mutedId: 9 }]);

    await service.notify([
      note(4, 9, 'report_status'),
      note(5, 9, 'report_comment'),
      note(5, 9, 'report_assigned'),
    ]);

    expect(block.findMany).not.toHaveBeenCalled();
    expect(mute.findMany).not.toHaveBeenCalled();
    expect(created()).toHaveLength(3);
  });

  it('keeps notifications without an actor', async () => {
    await service.notify([{ ...note(4, 9, 'report_status'), actorId: null }]);

    expect(block.findMany).not.toHaveBeenCalled();
    expect(created()).toEqual([
      { userId: 4, actorId: null, type: 'report_status' },
    ]);
  });
});

describe('Listing notifications across blocks', () => {
  const findMany = jest.fn().mockResolvedValue([]);
  const prisma = { notification: { findMany } };
  const service = new NotificationsService(
    prisma as unknown as PrismaService,
    {} as PresenceGateway,
  );
  const visibleActor = {
    OR: [
      { actorId: null },
      {
        type: {
          in: ['report_status', 'report_assigned', 'report_comment'],
        },
      },
      {
        actor: {
          blocksMade: { none: { blockedId: 4 } },
          blocksReceived: { none: { blockerId: 4 } },
        },
      },
    ],
  };

  beforeEach(() => findMany.mockClear());

  it('leaves out notifications from someone blocked either way, but keeps ticket updates', async () => {
    await service.list(4, {});

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 4, AND: [visibleActor] },
      }),
    );
  });

  it('leaves them out of notification search too', async () => {
    await service.list(4, { q: 'naruto', filter: 'comments' });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 4,
          AND: [visibleActor],
          OR: expect.arrayContaining([
            {
              actor: { username: { contains: 'naruto', mode: 'insensitive' } },
            },
          ]),
        }),
      }),
    );
  });
});
