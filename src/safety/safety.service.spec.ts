import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SafetyService } from './safety.service';
import { SafetyController } from './safety.controller';
import { MessagesController } from '../messages/messages.controller';
import { PrismaService } from '../prisma.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { Prisma } from '../../prisma/generated/client';

const person = (id: number, username: string) => ({
  id,
  username,
  name: null,
  avatarUrl: null,
});

describe('SafetyService', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    block: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    mute: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    friendship: { deleteMany: jest.fn() },
    repost: { deleteMany: jest.fn() },
    keywordFilter: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn((steps: unknown[]) => Promise.all(steps)),
  };
  const presence = { notify: jest.fn() };
  const service = new SafetyService(
    prisma as unknown as PrismaService,
    presence as unknown as PresenceGateway,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ id: 2 });
    prisma.block.findUnique.mockResolvedValue(null);
    prisma.block.count.mockResolvedValue(0);
    prisma.block.upsert.mockResolvedValue({});
    prisma.friendship.deleteMany.mockResolvedValue({ count: 0 });
    prisma.mute.findUnique.mockResolvedValue(null);
    prisma.mute.count.mockResolvedValue(0);
    prisma.keywordFilter.findUnique.mockResolvedValue(null);
    prisma.keywordFilter.count.mockResolvedValue(0);
    prisma.keywordFilter.deleteMany.mockResolvedValue({ count: 0 });
  });

  describe('blocking', () => {
    it('blocks someone and ends any friendship or request both ways in one go', async () => {
      prisma.friendship.deleteMany.mockResolvedValue({ count: 1 });

      await expect(service.block(1, 'Zoro')).resolves.toEqual({
        blocked: true,
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { username: 'zoro' },
        select: { id: true },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.block.upsert).toHaveBeenCalledWith({
        where: { blockerId_blockedId: { blockerId: 1, blockedId: 2 } },
        create: { blockerId: 1, blockedId: 2 },
        update: {},
      });
      expect(prisma.friendship.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { requesterId: 1, addresseeId: 2 },
            { requesterId: 2, addresseeId: 1 },
          ],
        },
      });
      expect(presence.notify).toHaveBeenCalledWith([1, 2], 'friends:changed');
    });

    it('drops reposts between the two of them both ways in the same go', async () => {
      prisma.repost.deleteMany.mockReturnValueOnce('drop reposts');

      await service.block(1, 'zoro');

      expect(prisma.$transaction.mock.calls[0][0]).toContain('drop reposts');
      expect(prisma.repost.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            {
              userId: 1,
              OR: [
                { post: { authorId: 2 } },
                { activity: { entry: { userId: 2 } } },
              ],
            },
            {
              userId: 2,
              OR: [
                { post: { authorId: 1 } },
                { activity: { entry: { userId: 1 } } },
              ],
            },
          ],
        },
      });
    });

    it('sends no friend list update when they weren’t friends', async () => {
      await service.block(1, 'zoro');
      expect(presence.notify).not.toHaveBeenCalled();
    });

    it('refuses to block yourself or someone who doesn’t exist', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 1 });
      await expect(service.block(1, 'me')).rejects.toThrow(
        new BadRequestException('You can’t block yourself'),
      );

      prisma.user.findUnique.mockResolvedValueOnce(null);
      await expect(service.block(1, 'nobody')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.block.upsert).not.toHaveBeenCalled();
    });

    it('stops at 1,000 blocks, but blocking someone again still works', async () => {
      prisma.block.count.mockResolvedValue(1000);
      await expect(service.block(1, 'zoro')).rejects.toThrow(
        new BadRequestException('You can block up to 1,000 people'),
      );
      expect(prisma.block.upsert).not.toHaveBeenCalled();

      prisma.block.findUnique.mockResolvedValue({ blockerId: 1 });
      await expect(service.block(1, 'zoro')).resolves.toEqual({
        blocked: true,
      });
    });

    it('unblocks', async () => {
      await expect(service.unblock(1, 'zoro')).resolves.toEqual({
        blocked: false,
      });
      expect(prisma.block.deleteMany).toHaveBeenCalledWith({
        where: { blockerId: 1, blockedId: 2 },
      });
    });

    it('lists the people you blocked, newest first', async () => {
      const blockedAt = new Date('2026-11-01T00:00:00Z');
      prisma.block.findMany.mockResolvedValue([
        { createdAt: blockedAt, blocked: person(2, 'zoro') },
      ]);

      await expect(service.blocks(1)).resolves.toEqual({
        people: [{ ...person(2, 'zoro'), blockedAt }],
      });
      expect(prisma.block.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { blockerId: 1 },
          orderBy: { createdAt: 'desc' },
        }),
      );
    });
  });

  describe('muting', () => {
    it('mutes someone once', async () => {
      await expect(service.mute(1, 'zoro')).resolves.toEqual({ muted: true });
      expect(prisma.mute.create).toHaveBeenCalledWith({
        data: { muterId: 1, mutedId: 2 },
      });

      prisma.mute.findUnique.mockResolvedValue({ muterId: 1 });
      prisma.mute.create.mockClear();
      await expect(service.mute(1, 'zoro')).resolves.toEqual({ muted: true });
      expect(prisma.mute.create).not.toHaveBeenCalled();
    });

    it('refuses to mute yourself', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 1 });
      await expect(service.mute(1, 'me')).rejects.toThrow(
        new BadRequestException('You can’t mute yourself'),
      );
    });

    it('stops at 1,000 mutes', async () => {
      prisma.mute.count.mockResolvedValue(1000);
      await expect(service.mute(1, 'zoro')).rejects.toThrow(
        new BadRequestException('You can mute up to 1,000 people'),
      );
      expect(prisma.mute.create).not.toHaveBeenCalled();
    });

    it('unmutes and lists muted people', async () => {
      const mutedAt = new Date('2026-11-02T00:00:00Z');
      prisma.mute.findMany.mockResolvedValue([
        { createdAt: mutedAt, muted: person(2, 'zoro') },
      ]);

      await expect(service.unmute(1, 'zoro')).resolves.toEqual({
        muted: false,
      });
      expect(prisma.mute.deleteMany).toHaveBeenCalledWith({
        where: { muterId: 1, mutedId: 2 },
      });
      await expect(service.mutes(1)).resolves.toEqual({
        people: [{ ...person(2, 'zoro'), mutedAt }],
      });
    });
  });

  describe('keyword filters', () => {
    const filter = {
      id: 5,
      phrase: 'final arc',
      expiresAt: null,
      createdAt: new Date('2026-11-06T00:00:00Z'),
    };

    it('adds a filter, stored lowercased and trimmed', async () => {
      prisma.keywordFilter.create.mockResolvedValue(filter);

      await expect(
        service.addFilter(1, '  Final ARC ', 'forever'),
      ).resolves.toEqual(filter);
      expect(prisma.keywordFilter.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { userId: 1, phrase: 'final arc', expiresAt: null },
        }),
      );
    });

    it('sets an expiry for a limited filter', async () => {
      prisma.keywordFilter.create.mockResolvedValue(filter);

      await service.addFilter(1, 'spoilers', 'week');

      const { expiresAt } = prisma.keywordFilter.create.mock.calls[0][0].data;
      const days = (expiresAt.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.99);
      expect(days).toBeLessThanOrEqual(7);
    });

    it('needs 1 to 50 characters after trimming', async () => {
      await expect(service.addFilter(1, '   ', 'forever')).rejects.toThrow(
        new BadRequestException('Enter a word or phrase'),
      );
      await expect(
        service.addFilter(1, 'a'.repeat(51), 'forever'),
      ).rejects.toThrow(
        new BadRequestException('Keep it to 50 characters or fewer'),
      );
      prisma.keywordFilter.create.mockResolvedValue(filter);
      await expect(
        service.addFilter(1, ` ${'a'.repeat(50)} `, 'forever'),
      ).resolves.toEqual(filter);
    });

    it('refuses a duplicate', async () => {
      prisma.keywordFilter.findUnique.mockResolvedValue({ id: 5 });
      await expect(
        service.addFilter(1, 'Final arc', 'forever'),
      ).rejects.toThrow(new ConflictException('You already filter that'));
      expect(prisma.keywordFilter.findUnique).toHaveBeenCalledWith({
        where: { userId_phrase: { userId: 1, phrase: 'final arc' } },
        select: { id: true },
      });
    });

    it('refuses a duplicate added at the same moment', async () => {
      prisma.keywordFilter.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expect(
        service.addFilter(1, 'Final arc', 'forever'),
      ).rejects.toThrow(new ConflictException('You already filter that'));
    });

    it('passes other database errors through', async () => {
      const failure = new Error('Database is down');
      prisma.keywordFilter.create.mockRejectedValueOnce(failure);
      await expect(service.addFilter(1, 'zoro', 'forever')).rejects.toBe(
        failure,
      );
    });

    it('stops at 100 filters, after clearing expired ones', async () => {
      prisma.keywordFilter.count.mockResolvedValue(100);
      await expect(service.addFilter(1, 'zoro', 'day')).rejects.toThrow(
        new BadRequestException('You can have up to 100 keyword filters'),
      );
      expect(prisma.keywordFilter.deleteMany).toHaveBeenCalledWith({
        where: { userId: 1, expiresAt: { lte: expect.any(Date) } },
      });
      expect(
        prisma.keywordFilter.deleteMany.mock.invocationCallOrder[0],
      ).toBeLessThan(prisma.keywordFilter.count.mock.invocationCallOrder[0]);
    });

    it('lists only unexpired filters, deleting expired ones first', async () => {
      prisma.keywordFilter.findMany.mockResolvedValue([filter]);

      await expect(service.filters(1)).resolves.toEqual({ filters: [filter] });
      expect(prisma.keywordFilter.deleteMany).toHaveBeenCalledWith({
        where: { userId: 1, expiresAt: { lte: expect.any(Date) } },
      });
      expect(
        prisma.keywordFilter.deleteMany.mock.invocationCallOrder[0],
      ).toBeLessThan(prisma.keywordFilter.findMany.mock.invocationCallOrder[0]);
    });

    it('removes only your own filter', async () => {
      prisma.keywordFilter.deleteMany.mockResolvedValue({ count: 1 });
      await expect(service.removeFilter(1, 5)).resolves.toBeUndefined();
      expect(prisma.keywordFilter.deleteMany).toHaveBeenCalledWith({
        where: { id: 5, userId: 1 },
      });

      prisma.keywordFilter.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.removeFilter(1, 6)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

describe('Safety routes for unconfirmed emails', () => {
  const reflector = new Reflector();
  const allowed = <T extends object>(controller: T, handler: keyof T) =>
    reflector.getAllAndOverride<boolean>('allowUnconfirmed', [
      controller[handler] as () => unknown,
      controller.constructor as () => unknown,
    ]);

  it('lets people manage blocks, mutes and filters before confirming', () => {
    const routes = [
      'block',
      'unblock',
      'mute',
      'unmute',
      'addFilter',
      'removeFilter',
    ] as const;
    for (const route of routes) {
      expect(allowed(SafetyController.prototype, route)).toBe(true);
    }
  });

  it('lets people mute a conversation before confirming, but not send', () => {
    const messages = MessagesController.prototype;
    expect(allowed(messages, 'mute')).toBe(true);
    expect(allowed(messages, 'unmute')).toBe(true);
    expect(allowed(messages, 'send')).toBeUndefined();
  });
});
