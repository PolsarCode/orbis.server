import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PostsService, viewablePosts } from './posts.service';
import { BookmarkDto } from './dto/bookmark.dto';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LikesService } from '../likes/likes.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';

jest.mock('../common/rich-text', () => ({ sanitizeRichText: jest.fn() }));

const date = new Date('2026-11-04T12:00:00Z');
const person = { id: 2, username: 'frieren', name: null, avatarUrl: null };
const post = (id: number, fields: object = {}) => ({
  id,
  createdAt: date,
  commentCount: 0,
  content: 'Post',
  spoiler: null,
  author: person,
  communityId: null,
  wallUserId: 2,
  pinnedAt: null,
  ...fields,
});
const savedAt = (minutes: number) =>
  new Date(date.getTime() + minutes * 60 * 1000);
const row = (id: number, minutes: number) => ({
  bookmarkableId: id,
  createdAt: savedAt(minutes),
});

beforeEach(() => jest.useFakeTimers({ now: date }));
afterEach(() => jest.useRealTimers());

function setup() {
  const prisma = {
    block: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    mute: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    keywordFilter: { findMany: jest.fn().mockResolvedValue([]) },
    post: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    libraryActivity: { findMany: jest.fn().mockResolvedValue([]) },
    repost: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    bookmark: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    contentReport: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn().mockResolvedValue({ showNsfw: false }) },
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

function savedRows(
  prisma: ReturnType<typeof setup>['prisma'],
  ...batches: ReturnType<typeof row>[][]
) {
  const saved = batches.flat().map(({ bookmarkableId }) => ({
    bookmarkableId,
  }));
  prisma.bookmark.findMany.mockImplementation(({ select }) =>
    Promise.resolve('createdAt' in select ? (batches.shift() ?? []) : saved),
  );
}

const viewerOf = (reported: number[]) => ({
  id: 1,
  reported: { post: reported, comment: [], forum_post: [] },
  siteAdmin: false,
  manages: [],
});

describe('Who can see a saved post', () => {
  const where = viewablePosts(viewerOf([9])) as {
    AND: [{ OR: object[] }, object];
  };

  it('follows where the post lives', () => {
    expect(where.AND[0].OR).toEqual([
      {
        community: {
          OR: [{ isPublic: true }, { memberships: { some: { userId: 1 } } }],
        },
      },
      {
        wallUser: {
          OR: [{ isPublic: true }, { id: 1 }, expect.any(Object)],
        },
      },
      {
        communityId: null,
        mediaType: null,
        author: { OR: [{ isPublic: true }, { id: 1 }, expect.any(Object)] },
      },
      { mediaType: { not: null } },
    ]);
  });

  it('leaves out hidden posts, suspended authors and posts the viewer reported', () => {
    expect(where.AND[1]).toEqual({
      AND: [
        { OR: [{ hiddenAt: null }, { authorId: 1 }] },
        {
          OR: [
            {
              author: {
                deleteAt: null,
                OR: [
                  { suspendedAt: null },
                  { suspendedUntil: { lte: expect.any(Date) } },
                ],
              },
            },
            { authorId: 1 },
          ],
        },
        {
          OR: [
            {
              author: {
                blocksMade: { none: { blockedId: 1 } },
                blocksReceived: { none: { blockerId: 1 } },
              },
            },
            { authorId: 1 },
          ],
        },
        { id: { notIn: [9] } },
      ],
    });
  });
});

describe('What a save request accepts', () => {
  const invalid = async (body: object) =>
    (
      await validate(plainToInstance(BookmarkDto, body), { whitelist: true })
    ).map(({ property }) => property);

  it('accepts saving and unsaving a post', async () => {
    await expect(
      invalid({ type: 'post', id: 7, bookmarked: true }),
    ).resolves.toEqual([]);
    await expect(
      invalid({ type: 'post', id: 2147483647, bookmarked: false }),
    ).resolves.toEqual([]);
  });

  it('rejects anything that isn’t a post, a real id, or a yes or no', async () => {
    await expect(
      invalid({ type: 'comment', id: 7, bookmarked: true }),
    ).resolves.toEqual(['type']);
    await expect(
      invalid({ type: 'post', id: 0, bookmarked: true }),
    ).resolves.toEqual(['id']);
    await expect(
      invalid({ type: 'post', id: 2147483648, bookmarked: true }),
    ).resolves.toEqual(['id']);
    await expect(
      invalid({ type: 'post', id: 1.5, bookmarked: true }),
    ).resolves.toEqual(['id']);
    await expect(
      invalid({ type: 'post', id: 7, bookmarked: 'true' }),
    ).resolves.toEqual(['bookmarked']);
    await expect(invalid({})).resolves.toEqual(['type', 'id', 'bookmarked']);
  });
});

describe('Saving posts', () => {
  const key = { userId: 1, bookmarkableType: 'post', bookmarkableId: 7 };

  it('saves a post the viewer can see', async () => {
    const { prisma, service } = setup();
    prisma.contentReport.findMany.mockResolvedValue([
      { targetType: 'post', targetId: 9 },
    ]);
    prisma.post.findFirst.mockResolvedValue({ id: 7 });

    await expect(
      service.setBookmark(1, { type: 'post', id: 7, bookmarked: true }),
    ).resolves.toEqual({ bookmarked: true });

    expect(prisma.post.findFirst).toHaveBeenCalledWith({
      where: { AND: [{ id: 7 }, viewablePosts(viewerOf([9]))] },
      select: { id: true },
    });
    expect(prisma.bookmark.upsert).toHaveBeenCalledWith({
      where: { userId_bookmarkableType_bookmarkableId: key },
      create: key,
      update: {},
    });
  });

  it('unsaves a post, even one the viewer can no longer see', async () => {
    const { prisma, service } = setup();
    prisma.post.findFirst.mockResolvedValue(null);

    await expect(
      service.setBookmark(1, { type: 'post', id: 7, bookmarked: false }),
    ).resolves.toEqual({ bookmarked: false });

    expect(prisma.bookmark.deleteMany).toHaveBeenCalledWith({ where: key });
    expect(prisma.bookmark.upsert).not.toHaveBeenCalled();
  });

  it('treats a post the viewer can’t see as missing', async () => {
    const { prisma, service } = setup();
    prisma.post.findFirst.mockResolvedValue(null);

    await expect(
      service.setBookmark(1, { type: 'post', id: 7, bookmarked: true }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.bookmark.upsert).not.toHaveBeenCalled();
    expect(prisma.bookmark.deleteMany).not.toHaveBeenCalled();
  });
});

describe('Listing saved posts', () => {
  it('lists newest saved first and skips posts the viewer can no longer see', async () => {
    const { prisma, service } = setup();
    savedRows(prisma, [row(3, 30), row(5, 20), row(4, 10)]);
    prisma.post.findMany.mockResolvedValue([post(4), post(3)]);

    const page = await service.findBookmarks(1);

    expect(page.items).toEqual([
      expect.objectContaining({ type: 'post', id: 3, bookmarked: true }),
      expect.objectContaining({ type: 'post', id: 4, bookmarked: true }),
    ]);
    expect(page.nextCursor).toBeNull();
    expect(prisma.bookmark.findMany.mock.calls[0][0]).toEqual({
      where: { userId: 1, bookmarkableType: 'post' },
      orderBy: [{ createdAt: 'desc' }, { bookmarkableId: 'desc' }],
      take: 11,
      select: { bookmarkableId: true, createdAt: true },
    });
    expect(prisma.post.findMany).toHaveBeenCalledWith({
      where: {
        AND: [{ id: { in: [3, 5, 4] } }, {}, viewablePosts(viewerOf([]))],
      },
      include: expect.any(Object),
    });
  });

  it('keeps looking until the page is full', async () => {
    const { prisma, service } = setup();
    const first = Array.from({ length: 11 }, (_, index) =>
      row(100 - index, 100 - index),
    );
    const second = Array.from({ length: 11 }, (_, index) =>
      row(80 - index, 80 - index),
    );
    savedRows(prisma, first, second);
    prisma.post.findMany
      .mockResolvedValue([])
      .mockResolvedValueOnce(
        first.slice(0, 5).map(({ bookmarkableId }) => post(bookmarkableId)),
      )
      .mockResolvedValueOnce(
        second.map(({ bookmarkableId }) => post(bookmarkableId)),
      );

    const page = await service.findBookmarks(1);

    expect(page.items.map(({ id }) => id)).toEqual([
      100, 99, 98, 97, 96, 80, 79, 78, 77, 76,
    ]);
    expect(page.nextCursor).toBe(`${savedAt(76).getTime()}_76`);
    expect(prisma.bookmark.findMany.mock.calls[1][0].where).toEqual({
      userId: 1,
      bookmarkableType: 'post',
      OR: [
        { createdAt: { lt: savedAt(90) } },
        { createdAt: savedAt(90), bookmarkableId: { lt: 90 } },
      ],
    });
  });

  it('picks up after the cursor', async () => {
    const { prisma, service } = setup();
    savedRows(prisma, [row(2, 5)]);
    prisma.post.findMany.mockResolvedValue([post(2)]);

    const page = await service.findBookmarks(1, `${savedAt(10).getTime()}_4`);

    expect(page).toMatchObject({ items: [{ id: 2 }], nextCursor: null });
    expect(prisma.bookmark.findMany.mock.calls[0][0].where).toEqual({
      userId: 1,
      bookmarkableType: 'post',
      OR: [
        { createdAt: { lt: savedAt(10) } },
        { createdAt: savedAt(10), bookmarkableId: { lt: 4 } },
      ],
    });
  });

  it('rejects a malformed cursor', async () => {
    const { prisma, service } = setup();

    await expect(service.findBookmarks(1, 'nope')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.findBookmarks(1, `${date.getTime()}_0`),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.bookmark.findMany).not.toHaveBeenCalled();
  });

  it('ends quietly when nothing is saved', async () => {
    const { prisma, service } = setup();

    expect(await service.findBookmarks(1)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });
});

describe('Searching saved posts', () => {
  const contains = { contains: 'frieren', mode: 'insensitive' };

  it('matches text and spoiler notes among saved posts the viewer can see', async () => {
    const { prisma, service } = setup();
    prisma.contentReport.findMany.mockResolvedValue([
      { targetType: 'post', targetId: 9 },
    ]);
    savedRows(prisma, [row(3, 30), row(5, 20)]);
    prisma.post.findMany.mockResolvedValue([post(5), post(3)]);

    const items = await service.searchBookmarks(1, '  frieren ');

    expect(items.map(({ id }) => id)).toEqual([3, 5]);
    expect(prisma.bookmark.findMany.mock.calls[0][0]).toMatchObject({
      where: { userId: 1, bookmarkableType: 'post' },
      take: 100,
    });
    expect(prisma.post.findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { id: { in: [3, 5] } },
          { OR: [{ content: contains }, { spoiler: contains }] },
          viewablePosts(viewerOf([9])),
        ],
      },
      include: expect.any(Object),
    });
  });

  it('returns at most eight results', async () => {
    const { prisma, service } = setup();
    const rows = Array.from({ length: 20 }, (_, index) =>
      row(20 - index, 20 - index),
    );
    savedRows(prisma, rows);
    prisma.post.findMany.mockResolvedValue(
      rows.map(({ bookmarkableId }) => post(bookmarkableId)),
    );

    const items = await service.searchBookmarks(1, 'frieren');

    expect(items.map(({ id }) => id)).toEqual([20, 19, 18, 17, 16, 15, 14, 13]);
  });

  it('waits for at least two characters', async () => {
    const { prisma, service } = setup();

    expect(await service.searchBookmarks(1, ' a ')).toEqual([]);
    expect(prisma.bookmark.findMany).not.toHaveBeenCalled();
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });
});

describe('Saved posts in feeds', () => {
  it('marks the posts the viewer saved', async () => {
    const { prisma, service } = setup();
    prisma.post.findMany.mockResolvedValue([post(2), post(1)]);
    prisma.bookmark.findMany.mockResolvedValue([{ bookmarkableId: 2 }]);

    const { items } = await service.findForMember(1, undefined, 'activity');

    expect(
      items.map((item) => item.type === 'post' && [item.id, item.bookmarked]),
    ).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(prisma.bookmark.findMany).toHaveBeenCalledWith({
      where: {
        userId: 1,
        bookmarkableType: 'post',
        bookmarkableId: { in: [2, 1] },
      },
      select: { bookmarkableId: true },
    });
  });
});
