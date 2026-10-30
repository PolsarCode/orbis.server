import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PostsService } from './posts.service';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LikesService } from '../likes/likes.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';

jest.mock('../common/rich-text', () => ({ sanitizeRichText: jest.fn() }));

const date = new Date('2026-10-30T12:00:00Z');
const person = { id: 1, username: 'reader', name: null, avatarUrl: null };
const post = (fields: object) => ({
  id: 1,
  createdAt: date,
  commentCount: 0,
  content: 'Post',
  author: person,
  communityId: null,
  wallUserId: null,
  pinnedAt: null,
  ...fields,
});
const manager = (communityId: number, ownerId: number) => ({
  communityId,
  userId: 1,
  nickname: null,
  community: { ownerId },
  roles: [],
});

function setup() {
  const prisma = {
    post: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    libraryActivity: { findMany: jest.fn().mockResolvedValue([]) },
    contentReport: { findMany: jest.fn().mockResolvedValue([]) },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ ...person, isPublic: true, showNsfw: false }),
    },
    friendship: { findFirst: jest.fn().mockResolvedValue(null) },
    membership: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const likes = { likedBy: jest.fn().mockResolvedValue(new Set()) };
  const service = new PostsService(
    prisma as unknown as PrismaService,
    {} as NotificationsService,
    likes as unknown as LikesService,
    {} as DiscordChannelService,
  );
  return { prisma, service };
}

const pinnedQuery = (where: object) => {
  const text = JSON.stringify(where);
  return text.includes('"pinnedAt":{"not":null}') && !text.includes('"NOT"');
};

describe('Pinning posts', () => {
  it('lets community owners and admins pin a post', async () => {
    const { prisma, service } = setup();
    prisma.post.findUnique.mockResolvedValue(post({ communityId: 5 }));
    prisma.membership.findMany.mockResolvedValue([manager(5, 1)]);
    prisma.post.count.mockResolvedValue(0);

    await service.setPinned(1, 1, true);

    expect(prisma.post.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { pinnedAt: expect.any(Date) },
    });
  });

  it('stops members who don’t run the community', async () => {
    const { prisma, service } = setup();
    prisma.post.findUnique.mockResolvedValue(post({ communityId: 5 }));
    prisma.membership.findMany.mockResolvedValue([manager(5, 2)]);

    await expect(service.setPinned(1, 1, true)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it('allows one pinned post per community for now', async () => {
    const { prisma, service } = setup();
    prisma.post.findUnique.mockResolvedValue(post({ communityId: 5 }));
    prisma.membership.findMany.mockResolvedValue([manager(5, 1)]);
    prisma.post.count.mockResolvedValue(1);

    await expect(service.setPinned(1, 1, true)).rejects.toThrow(
      new ConflictException('Only 1 post can be pinned here. Unpin it first'),
    );
    expect(prisma.post.count).toHaveBeenCalledWith({
      where: { communityId: 5, pinnedAt: { not: null } },
    });
  });

  it('lets people pin up to 3 posts on their own wall', async () => {
    const { prisma, service } = setup();
    prisma.post.findUnique.mockResolvedValue(post({ wallUserId: 1 }));
    prisma.post.count.mockResolvedValueOnce(2).mockResolvedValueOnce(3);

    await service.setPinned(1, 1, true);
    expect(prisma.post.update).toHaveBeenCalledTimes(1);

    await expect(service.setPinned(1, 1, true)).rejects.toThrow(
      new ConflictException(
        'Up to 3 posts can be pinned here. Unpin one first',
      ),
    );
  });

  it('doesn’t let people pin on someone else’s wall', async () => {
    const { prisma, service } = setup();
    prisma.post.findUnique.mockResolvedValue(post({ wallUserId: 2 }));

    await expect(service.setPinned(1, 1, true)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('doesn’t pin posts on title pages', async () => {
    const { prisma, service } = setup();
    prisma.post.findUnique.mockResolvedValue(post({}));

    await expect(service.setPinned(1, 1, true)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('unpins, and ignores pinning something already pinned', async () => {
    const { prisma, service } = setup();
    prisma.post.findUnique.mockResolvedValue(
      post({ wallUserId: 1, pinnedAt: date }),
    );

    await service.setPinned(1, 1, true);
    expect(prisma.post.update).not.toHaveBeenCalled();
    expect(prisma.post.count).not.toHaveBeenCalled();

    await service.setPinned(1, 1, false);
    expect(prisma.post.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { pinnedAt: null },
    });
  });
});

describe('Pinned posts in feeds', () => {
  function communityFeed(prisma: ReturnType<typeof setup>['prisma']) {
    prisma.post.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        pinnedQuery(where)
          ? [post({ id: 7, communityId: 9, pinnedAt: date })]
          : [post({ id: 1, communityId: 9 })],
      ),
    );
  }

  it('shows a community’s pinned posts first, once, with Pin for admins', async () => {
    const { prisma, service } = setup();
    communityFeed(prisma);
    prisma.membership.findMany.mockResolvedValue([manager(9, 1)]);

    const { items } = await service.findForCommunity(1, 9);

    expect(
      items.map((item) =>
        item.type === 'post'
          ? { id: item.id, pinned: item.pinned, canPin: item.canPin }
          : item.type,
      ),
    ).toEqual([
      { id: 7, pinned: true, canPin: true },
      { id: 1, pinned: false, canPin: true },
    ]);
    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ communityId: 9, pinnedAt: null }),
      }),
    );
  });

  it('shows members pinned posts without letting them pin', async () => {
    const { prisma, service } = setup();
    communityFeed(prisma);

    const { items } = await service.findForCommunity(1, 9);

    expect(items.every((item) => item.type === 'post' && !item.canPin)).toBe(
      true,
    );
    expect(items[0]).toEqual(expect.objectContaining({ pinned: true }));
  });

  it('keeps pinned posts on the first page only', async () => {
    const { prisma, service } = setup();
    communityFeed(prisma);

    await service.findForCommunity(1, 9, `${date.getTime()}_0_2`);

    expect(prisma.post.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.post.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ pinnedAt: null }),
    );
  });

  it('pins only wall posts on a profile, and only the owner can pin', async () => {
    const { prisma, service } = setup();
    prisma.post.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        pinnedQuery(where)
          ? [post({ id: 7, wallUserId: 1, pinnedAt: date })]
          : [
              post({ id: 2, communityId: 5, pinnedAt: date }),
              post({ id: 1, wallUserId: 1 }),
            ],
      ),
    );

    const own = await service.findForProfile(1, 'reader');
    expect(
      own.items.map((item) =>
        item.type === 'post'
          ? { id: item.id, pinned: item.pinned, canPin: item.canPin }
          : item.type,
      ),
    ).toEqual([
      { id: 7, pinned: true, canPin: true },
      { id: 2, pinned: false, canPin: false },
      { id: 1, pinned: false, canPin: true },
    ]);

    const visitor = await service.findForProfile(2, 'reader');
    expect(
      visitor.items.some((item) => item.type === 'post' && item.canPin),
    ).toBe(false);
  });
});
