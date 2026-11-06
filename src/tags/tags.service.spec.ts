import { BadRequestException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { TagsService } from './tags.service';
import { TagsController } from './tags.controller';
import { publicUsages } from './public-content';
import { PrismaService } from '../prisma.service';
import { PostsService } from '../posts/posts.service';
import { CommentsService } from '../comments/comments.service';
import { ForumService } from '../forum/forum.service';
import { visibleThreads } from '../forum/forum-helpers';

jest.mock('../common/rich-text', () => ({ sanitizeRichText: jest.fn() }));

const now = new Date('2026-11-05T12:00:00Z');
const hoursAgo = (hours: number) =>
  new Date(now.getTime() - hours * 60 * 60 * 1000);

beforeEach(() => jest.useFakeTimers({ now }));
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
    contentReport: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ targetType: 'comment', targetId: 66 }]),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ showNsfw: false }) },
    membership: { findMany: jest.fn().mockResolvedValue([]) },
    hashtag: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({ id: 4 }),
    },
    hashtagUsage: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    hashtagFollow: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const posts = { findByIds: jest.fn().mockResolvedValue([]) };
  const comments = { findForTags: jest.fn().mockResolvedValue([]) };
  const forum = { findForTags: jest.fn().mockResolvedValue([]) };
  const service = new TagsService(
    prisma as unknown as PrismaService,
    posts as unknown as PostsService,
    comments as unknown as CommentsService,
    forum as unknown as ForumService,
  );
  return { prisma, posts, comments, forum, service };
}

type GroupByArgs = {
  by: string[];
  where: { AND: [unknown, { createdAt?: { gte: Date } }] };
};

function people(
  prisma: ReturnType<typeof setup>['prisma'],
  { day, week }: { day: object[]; week: object[] },
) {
  prisma.hashtagUsage.groupBy.mockImplementation(({ where }: GroupByArgs) => {
    const since = where.AND[1].createdAt?.gte;
    return Promise.resolve(
      since && since.getTime() >= hoursAgo(24).getTime() ? day : week,
    );
  });
}

const uses = (hashtagId: number, ...authorIds: number[]) =>
  authorIds.map((authorId) => ({ hashtagId, authorId }));

describe('Which content counts on tag pages', () => {
  const viewer = {
    id: 1,
    reported: { post: [11], comment: [22], forum_post: [33] },
    siteAdmin: false,
    manages: [],
  };
  jest.useFakeTimers({ now: new Date('2026-11-05T12:00:00Z') });
  const where = publicUsages(viewer, false) as {
    OR: [
      { post: { AND: [{ AND: object[] }, object] } },
      { AND: [{ comment: object }, { OR: [object, object] }] },
      { forumPost: { AND: object[] } },
    ];
  };
  jest.useRealTimers();
  const [posts, comments, forumPosts] = where.OR;
  const visible = (ids: number[]) => ({
    AND: [
      { OR: [{ hiddenAt: null }, { authorId: 1 }] },
      {
        OR: [
          {
            author: {
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
      { id: { notIn: ids } },
    ],
  });

  it('only shows posts in public communities, on public profiles, or on title pages', () => {
    expect(posts.post.AND[0].AND[0]).toEqual({
      OR: [
        { community: { isPublic: true } },
        { wallUser: { isPublic: true } },
        { mediaType: { not: null } },
      ],
    });
  });

  it('leaves out posts on 18+ titles unless the viewer has 18+ on', () => {
    expect(posts.post.AND[0].AND).toContainEqual({ isAdult: false });
    const shown = publicUsages(viewer, true) as typeof where;
    expect(shown.OR[0].post.AND[0].AND).not.toContainEqual({ isAdult: false });
  });

  it('only shows a thread’s feed copy while the thread itself is visible', () => {
    jest.useFakeTimers({ now: new Date('2026-11-05T12:00:00Z') });
    try {
      const fresh = publicUsages(viewer, false) as typeof where;
      expect(fresh.OR[0].post.AND[0].AND).toContainEqual({
        OR: [{ forumThreadId: null }, { forumThread: visibleThreads(viewer) }],
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves out posts on the wall of someone blocked either way', () => {
    expect(posts.post.AND[0].AND).toContainEqual({
      OR: [
        { wallUserId: null },
        {
          wallUser: {
            blocksMade: { none: { blockedId: 1 } },
            blocksReceived: { none: { blockerId: 1 } },
          },
        },
      ],
    });
    const admin = publicUsages({ ...viewer, siteAdmin: true }, false) as {
      OR: [{ post: { AND: [{ AND: object[] }] } }];
    };
    expect(admin.OR[0].post.AND[0].AND).toContainEqual({
      OR: [
        { wallUserId: null },
        { wallUser: { blocksReceived: { none: { blockerId: 1 } } } },
      ],
    });
  });

  it('leaves out hidden posts, suspended authors and posts the viewer reported', () => {
    expect(posts.post.AND[1]).toEqual(visible([11]));
  });

  it('only shows comments that aren’t deleted, hidden or reported, on public posts or public library updates', () => {
    const [comment, target] = comments.AND;
    expect(comment).toEqual({ comment: { deletedAt: null, ...visible([22]) } });
    expect(target.OR[0]).toEqual({ targetPost: posts.post });
    expect(target.OR[1]).toEqual({
      targetActivity: {
        entry: {
          isPublic: true,
          isAdult: false,
          user: {
            isPublic: true,
            OR: [
              { suspendedAt: null },
              { suspendedUntil: { lte: expect.any(Date) } },
            ],
            blocksMade: { none: { blockedId: 1 } },
            blocksReceived: { none: { blockerId: 1 } },
          },
        },
      },
    });
  });

  it('shows 18+ library updates’ comments only to people who turned 18+ on', () => {
    const allowed = publicUsages(viewer, true) as typeof where;
    expect(JSON.stringify(allowed.OR[1])).not.toContain('isAdult');
  });

  it('only shows forum posts in public communities, in visible threads, skipping openings already shared to the feed', () => {
    expect(forumPosts.forumPost.AND).toEqual([
      { community: { isPublic: true } },
      {
        thread: {
          posts: { some: { opening: true, ...visible([33]) } },
        },
      },
      { OR: [{ opening: false }, { thread: { feedPost: { is: null } } }] },
      visible([33]),
    ]);
  });

  it('doesn’t make an exception for members of private communities', () => {
    expect(JSON.stringify(where)).not.toContain('memberships');
    expect(JSON.stringify(where)).not.toContain('friendships');
  });
});

describe('Tag pages', () => {
  const tagRow = { id: 4, display: 'Frieren', follows: [{ userId: 1 }] };

  it('refuses names that aren’t tags, and bad cursors', async () => {
    const { prisma, service } = setup();

    for (const name of ['1', 'two words', 'a'.repeat(51), '#frieren']) {
      await expect(service.findOne(1, name)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    await expect(service.findOne(1, 'frieren', 'nope')).rejects.toThrow(
      'Invalid cursor',
    );
    expect(prisma.hashtagUsage.findMany).not.toHaveBeenCalled();
  });

  it('shows a tag nobody used yet with its name and no items', async () => {
    const { prisma, service } = setup();
    prisma.hashtag.findUnique.mockResolvedValue(null);

    await expect(service.findOne(1, 'Frieren')).resolves.toEqual({
      tag: {
        name: 'frieren',
        display: 'frieren',
        following: false,
        people: 0,
        window: 'week',
      },
      items: [],
      nextCursor: null,
    });
  });

  it('leaves out content from people the viewer muted', async () => {
    const { prisma, service } = setup();
    prisma.hashtag.findUnique.mockResolvedValue(tagRow);

    await service.findOne(1, 'frieren');

    const [{ where }] = prisma.hashtagUsage.findMany.mock.calls[0];
    expect(where.AND[2]).toEqual({
      author: { mutesReceived: { none: { muterId: 1 } } },
    });
  });

  it('uses the name instead of the saved casing when no public content uses it', async () => {
    const { prisma, service } = setup();
    prisma.hashtag.findUnique.mockResolvedValue(tagRow);

    const { tag } = await service.findOne(1, 'frieren');

    expect(tag).toMatchObject({ display: 'frieren', following: true });
  });

  it('lists posts, comments and forum posts newest first, with a cursor for the next page', async () => {
    const { prisma, posts, comments, forum, service } = setup();
    prisma.hashtag.findUnique.mockResolvedValue(tagRow);
    const usage = (id: number, kind: object) => ({
      id,
      createdAt: hoursAgo(id),
      postId: null,
      commentId: null,
      forumPostId: null,
      ...kind,
    });
    prisma.hashtagUsage.findMany.mockResolvedValue([
      usage(1, { postId: 10 }),
      usage(2, { commentId: 20 }),
      usage(3, { forumPostId: 30 }),
      usage(4, { postId: 99 }),
      ...Array.from({ length: 7 }, (_, index) =>
        usage(5 + index, { postId: 100 + index }),
      ),
    ]);
    const post = { id: 10, createdAt: hoursAgo(1) };
    const comment = { comment: { id: 20, createdAt: hoursAgo(2) }, target: {} };
    const forumPost = {
      forumPost: { id: 30, createdAt: hoursAgo(3) },
      thread: { id: 9 },
    };
    posts.findByIds.mockResolvedValue([post]);
    comments.findForTags.mockResolvedValue([comment]);
    forum.findForTags.mockResolvedValue([forumPost]);
    people(prisma, { day: uses(4, 1, 2), week: [] });

    const page = await service.findOne(
      1,
      'frieren',
      `${hoursAgo(0).getTime()}_50`,
    );

    const [{ where, orderBy, take }] =
      prisma.hashtagUsage.findMany.mock.calls[0];
    expect(where.AND[0].AND[0]).toEqual({ hashtagId: 4 });
    expect(where.AND[1]).toEqual({
      OR: [{ createdAt: { lt: now } }, { createdAt: now, id: { lt: 50 } }],
    });
    expect(orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(take).toBe(11);
    expect(posts.findByIds).toHaveBeenCalledWith(
      1,
      [10, 99, 100, 101, 102, 103, 104, 105],
    );
    expect(comments.findForTags).toHaveBeenCalledWith(1, [20]);
    expect(forum.findForTags).toHaveBeenCalledWith(1, [30]);
    expect(page.items).toEqual([
      { kind: 'post', createdAt: post.createdAt, post },
      { kind: 'comment', createdAt: comment.comment.createdAt, ...comment },
      {
        kind: 'forum_post',
        createdAt: forumPost.forumPost.createdAt,
        ...forumPost,
      },
    ]);
    expect(page.tag).toEqual({
      name: 'frieren',
      display: 'Frieren',
      following: true,
      people: 0,
      window: 'day',
    });
    expect(prisma.hashtagUsage.groupBy).not.toHaveBeenCalled();
    expect(page.nextCursor).toBe(`${hoursAgo(10).getTime()}_10`);
  });

  it('counts this week’s people when trending fell back to the week', async () => {
    const { prisma, service } = setup();
    prisma.hashtag.findUnique.mockResolvedValue(tagRow);
    people(prisma, { day: uses(4, 1), week: uses(4, 1, 2, 3) });

    const { tag, nextCursor } = await service.findOne(1, 'frieren');

    expect(tag).toMatchObject({ people: 3, window: 'week' });
    expect(nextCursor).toBeNull();
  });
});

describe('Trending tags', () => {
  it('ranks tags by how many different people used them today, with at least two', async () => {
    const { prisma, service } = setup();
    people(prisma, {
      day: [
        ...uses(1, 1, 2),
        ...uses(2, 1, 2, 3),
        ...uses(3, 4),
        ...uses(4, 5, 6),
      ],
      week: [],
    });
    prisma.hashtag.findMany.mockResolvedValue([
      { id: 1, name: 'frieren', display: 'Frieren' },
      { id: 2, name: 'fern', display: 'Fern' },
      { id: 4, name: 'himmel', display: 'Himmel' },
    ]);

    await expect(service.trending(1)).resolves.toEqual({
      window: 'day',
      tags: [
        { name: 'fern', display: 'Fern', people: 3 },
        { name: 'frieren', display: 'Frieren', people: 2 },
        { name: 'himmel', display: 'Himmel', people: 2 },
      ],
    });
    expect(prisma.hashtag.findMany).toHaveBeenCalledWith({
      where: { id: { in: [1, 2, 4] } },
      select: { id: true, name: true, display: true },
    });
    const [{ by, where }] = prisma.hashtagUsage.groupBy.mock.calls[0];
    expect(by).toEqual(['hashtagId', 'authorId']);
    expect(where.AND[1]).toEqual({ createdAt: { gte: hoursAgo(24) } });
  });

  it('falls back to the last 7 days when nothing reaches two people today', async () => {
    const { prisma, service } = setup();
    people(prisma, { day: uses(1, 1), week: uses(1, 1, 2) });
    prisma.hashtag.findMany.mockResolvedValue([
      { id: 1, name: 'frieren', display: 'Frieren' },
    ]);

    const trending = await service.trending(1);

    expect(trending).toEqual({
      window: 'week',
      tags: [{ name: 'frieren', display: 'Frieren', people: 2 }],
    });
    expect(prisma.hashtagUsage.groupBy.mock.calls[1][0].where.AND[1]).toEqual({
      createdAt: { gte: hoursAgo(24 * 7) },
    });
  });

  it('lists nothing when no tag qualifies, and shows at most 20', async () => {
    const { prisma, service } = setup();
    people(prisma, { day: [], week: uses(1, 1) });

    await expect(service.trending(1)).resolves.toEqual({
      window: 'week',
      tags: [],
    });
    expect(prisma.hashtag.findMany).not.toHaveBeenCalled();

    const many = Array.from({ length: 25 }, (_, index) => index + 1);
    people(prisma, { day: many.flatMap((id) => uses(id, 1, 2)), week: [] });
    prisma.hashtag.findMany.mockResolvedValue(
      many.map((id) => ({ id, name: `tag${id}`, display: `Tag${id}` })),
    );
    expect((await service.trending(1)).tags).toHaveLength(20);
  });

  it('counts with the same public-only rules as tag pages', async () => {
    const { prisma, service } = setup();

    await service.trending(1);

    expect(prisma.hashtagUsage.groupBy.mock.calls[0][0].where.AND[0]).toEqual(
      publicUsages(
        {
          id: 1,
          reported: { post: [], comment: [66], forum_post: [] },
          siteAdmin: false,
          manages: [],
        },
        false,
      ),
    );
  });
});

describe('Following tags', () => {
  it('follows a tag, creating it if nobody used it yet', async () => {
    const { prisma, service } = setup();

    await expect(service.follow(1, 'Frieren')).resolves.toEqual({
      following: true,
    });
    expect(prisma.hashtag.upsert).toHaveBeenCalledWith({
      where: { name: 'frieren' },
      create: { name: 'frieren', display: 'Frieren' },
      update: {},
      select: { id: true },
    });
    expect(prisma.hashtagFollow.upsert).toHaveBeenCalledWith({
      where: { userId_hashtagId: { userId: 1, hashtagId: 4 } },
      create: { userId: 1, hashtagId: 4 },
      update: {},
    });
  });

  it('unfollows a tag', async () => {
    const { prisma, service } = setup();

    await expect(service.unfollow(1, 'Frieren')).resolves.toEqual({
      following: false,
    });
    expect(prisma.hashtagFollow.deleteMany).toHaveBeenCalledWith({
      where: { userId: 1, hashtag: { name: 'frieren' } },
    });
  });

  it('refuses names that aren’t tags', async () => {
    const { prisma, service } = setup();

    await expect(service.follow(1, '2026')).rejects.toThrow(
      'That isn’t a valid tag',
    );
    await expect(service.unfollow(1, 'a b')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.hashtag.upsert).not.toHaveBeenCalled();
    expect(prisma.hashtagFollow.deleteMany).not.toHaveBeenCalled();
  });

  it('lists followed tags, newest first', async () => {
    const { prisma, service } = setup();
    prisma.hashtagFollow.findMany.mockResolvedValue([
      { hashtag: { name: 'fern', display: 'Fern' } },
      { hashtag: { name: 'frieren', display: 'Frieren' } },
    ]);

    await expect(service.following(1)).resolves.toEqual({
      tags: [
        { name: 'fern', display: 'Fern' },
        { name: 'frieren', display: 'Frieren' },
      ],
    });
    expect(prisma.hashtagFollow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 1 },
        orderBy: [{ createdAt: 'desc' }, { hashtagId: 'desc' }],
      }),
    );
  });
});

describe('Searching tags', () => {
  it('waits for at least two characters without querying', async () => {
    const { prisma, service } = setup();

    await expect(service.search(1, ' #f ')).resolves.toEqual({ tags: [] });
    expect(prisma.hashtagUsage.groupBy).not.toHaveBeenCalled();
  });

  it('matches the start of names, without the #, by public uses', async () => {
    const { prisma, service } = setup();
    prisma.hashtagUsage.groupBy.mockResolvedValue([
      { hashtagId: 2, _count: { hashtagId: 5 } },
      { hashtagId: 1, _count: { hashtagId: 2 } },
    ]);
    prisma.hashtag.findMany.mockResolvedValue([
      { id: 1, name: 'frieren', display: 'Frieren' },
      { id: 2, name: 'fern', display: 'Fern' },
    ]);

    await expect(service.search(1, '  #FE')).resolves.toEqual({
      tags: [
        { name: 'fern', display: 'Fern', uses: 5 },
        { name: 'frieren', display: 'Frieren', uses: 2 },
      ],
    });
    const [args] = prisma.hashtagUsage.groupBy.mock.calls[0];
    expect(args.where.AND).toEqual([
      { hashtag: { name: { startsWith: 'fe' } } },
      publicUsages(
        {
          id: 1,
          reported: { post: [], comment: [66], forum_post: [] },
          siteAdmin: false,
          manages: [],
        },
        false,
      ),
    ]);
    expect(args.take).toBe(8);
    expect(args.orderBy).toEqual([
      { _count: { hashtagId: 'desc' } },
      { hashtagId: 'asc' },
    ]);
  });
});

describe('Tag routes', () => {
  it('keeps the tag page off the fixed routes so tags named like them still open', () => {
    const paths = Object.getOwnPropertyNames(TagsController.prototype)
      .filter((key) => key !== 'constructor')
      .map((key) =>
        Reflect.getMetadata(
          PATH_METADATA,
          TagsController.prototype[key as keyof TagsController],
        ),
      );
    expect(paths).toEqual(
      expect.arrayContaining([
        'trending',
        'following',
        'search',
        ':name/items',
        ':name/follow',
      ]),
    );
    expect(paths).not.toContain(':name');
  });
});
