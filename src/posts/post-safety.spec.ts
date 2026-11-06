import { NotFoundException } from '@nestjs/common';
import { PostsService } from './posts.service';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LikesService } from '../likes/likes.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';

jest.mock('../common/rich-text', () => ({ sanitizeRichText: jest.fn() }));

const date = new Date('2026-10-24T12:00:00Z');
const person = (id: number, username: string) => ({
  id,
  username,
  name: null,
  avatarUrl: null,
});
const me = person(1, 'reader');
const muted = person(7, 'vegeta');
const other = person(3, 'nami');

const post = (
  id: number,
  author: ReturnType<typeof person>,
  content = '<p>Post</p>',
  extra: object = {},
) => ({
  id,
  createdAt: new Date(date.getTime() - id * 1000),
  commentCount: 0,
  content,
  spoiler: null,
  communityId: null,
  wallUserId: null,
  pinnedAt: null,
  author,
  ...extra,
});

const activity = (title: string) => ({
  id: 3,
  createdAt: new Date(date.getTime() - 60_000),
  commentCount: 0,
  progressTo: null,
  status: 'current',
  entry: {
    mediaType: 'anime',
    sourceId: '1',
    title,
    coverImage: null,
    year: null,
    user: other,
  },
});

const notBlocked = {
  OR: [
    {
      author: {
        blocksMade: { none: { blockedId: 1 } },
        blocksReceived: { none: { blockerId: 1 } },
      },
    },
    { authorId: 1 },
  ],
};
const unmuted = { author: { mutesReceived: { none: { muterId: 1 } } } };
const hidesBlocked = expect.objectContaining({
  AND: expect.arrayContaining([notBlocked]),
});

const isPinnedQuery = (where: object) => {
  const text = JSON.stringify(where);
  return text.includes('"pinnedAt":{"not":null}') && !text.includes('"NOT"');
};

describe('Blocked and muted people in post lists', () => {
  const prisma = {
    block: {
      count: jest.fn(),
      findMany: jest.fn(),
    },
    mute: { findMany: jest.fn() },
    keywordFilter: { findMany: jest.fn() },
    post: { findMany: jest.fn() },
    comment: { findMany: jest.fn() },
    libraryActivity: { findMany: jest.fn() },
    contentReport: { findMany: jest.fn() },
    user: { findUnique: jest.fn() },
    friendship: { findFirst: jest.fn() },
    membership: { findMany: jest.fn() },
    bookmark: { findMany: jest.fn() },
  };
  const likes = { likedBy: jest.fn() };
  const service = new PostsService(
    prisma as unknown as PrismaService,
    {} as NotificationsService,
    likes as unknown as LikesService,
    {} as DiscordChannelService,
  );
  let posts: object[];

  const postWhere = () =>
    prisma.post.findMany.mock.calls
      .map(([args]) => args.where)
      .find((where) => !isPinnedQuery(where));

  beforeEach(() => {
    jest.clearAllMocks();
    posts = [post(1, other)];
    prisma.post.findMany.mockImplementation(({ where }) =>
      Promise.resolve(isPinnedQuery(where) ? [] : posts),
    );
    prisma.libraryActivity.findMany.mockResolvedValue([]);
    prisma.comment.findMany.mockResolvedValue([]);
    prisma.contentReport.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue({ id: 2, isPublic: true });
    prisma.friendship.findFirst.mockResolvedValue(null);
    prisma.membership.findMany.mockResolvedValue([]);
    prisma.bookmark.findMany.mockResolvedValue([]);
    prisma.block.count.mockResolvedValue(0);
    prisma.block.findMany.mockResolvedValue([]);
    prisma.mute.findMany.mockResolvedValue([]);
    prisma.keywordFilter.findMany.mockResolvedValue([]);
    likes.likedBy.mockResolvedValue(new Set());
  });

  it('hides blocked people both ways and removes muted people from the home feed', async () => {
    await service.findForMember(1);

    expect(postWhere().AND).toEqual(
      expect.arrayContaining([hidesBlocked, unmuted]),
    );
    expect(
      prisma.libraryActivity.findMany.mock.calls[0][0].where.entry.user,
    ).toMatchObject({
      blocksMade: { none: { blockedId: 1 } },
      blocksReceived: { none: { blockerId: 1 } },
      mutesReceived: { none: { muterId: 1 } },
    });
  });

  it('hides blocked people and removes muted people from a community’s feed, pinned posts included', async () => {
    await service.findForCommunity(1, 9);

    const [pinned, latest] = prisma.post.findMany.mock.calls.map(
      ([args]) => args.where,
    );
    for (const where of [pinned, latest]) {
      expect(where.AND).toEqual(
        expect.arrayContaining([hidesBlocked, unmuted]),
      );
    }
    expect(
      prisma.libraryActivity.findMany.mock.calls[0][0].where.entry.user,
    ).toMatchObject({ mutesReceived: { none: { muterId: 1 } } });
  });

  it('hides blocked people but keeps muted people on profiles and in search', async () => {
    await service.findForProfile(1, 'vegeta');
    const profileWhere = postWhere();
    const profileActivities =
      prisma.libraryActivity.findMany.mock.calls[0][0].where;

    jest.clearAllMocks();
    await service.searchFeed(1, 'Post');
    const searchWhere = postWhere();

    for (const where of [profileWhere, searchWhere]) {
      expect(where.AND).toEqual(expect.arrayContaining([hidesBlocked]));
      expect(JSON.stringify(where)).not.toContain('mutesReceived');
    }
    expect(JSON.stringify(profileActivities)).not.toContain('mutesReceived');
  });

  it('collapses a muted person’s posts on a profile, but never the viewer’s own', async () => {
    prisma.mute.findMany.mockResolvedValue([{ mutedId: 7 }]);
    prisma.keywordFilter.findMany.mockResolvedValue([{ phrase: 'post' }]);
    posts = [post(1, muted), post(2, me)];

    const { items } = await service.findForProfile(1, 'vegeta');

    expect(items.map((item) => item.hiddenBecause)).toEqual([
      { kind: 'muted' },
      null,
    ]);
  });

  it('collapses posts and preview comments that mention a filtered phrase', async () => {
    prisma.keywordFilter.findMany.mockResolvedValue([{ phrase: 'frieren' }]);
    posts = [
      post(1, other, '<p>Frieren&#39;s finale!</p>', { commentCount: 2 }),
      post(2, other, '<p>Episode 12</p>', { spoiler: 'Frieren ending' }),
      post(3, other, '<p>Friereniscool</p>'),
    ];
    prisma.comment.findMany.mockResolvedValue([
      {
        id: 40,
        content: '<p>#frieren</p>',
        linkUrl: null,
        spoiler: null,
        createdAt: date,
        author: other,
      },
      {
        id: 41,
        content: '<p>Frieren again</p>',
        linkUrl: null,
        spoiler: null,
        createdAt: date,
        author: me,
      },
    ]);

    const { items } = await service.findForMember(1, undefined, 'activity');

    const filtered = { kind: 'filtered', phrase: 'frieren' };
    expect(items.map((item) => item.hiddenBecause)).toEqual([
      filtered,
      filtered,
      null,
    ]);
    expect(
      items[0].previewComments.map((comment) => comment.hiddenBecause),
    ).toEqual([null, filtered]);
  });

  it('collapses library updates for a filtered title', async () => {
    prisma.keywordFilter.findMany.mockResolvedValue([{ phrase: 'frieren' }]);
    prisma.libraryActivity.findMany.mockResolvedValue([
      activity('Frieren: Beyond Journey’s End'),
    ]);

    const { items } = await service.findForMember(1, undefined, 'post');

    expect(items).toEqual([
      expect.objectContaining({
        type: 'activity',
        hiddenBecause: { kind: 'filtered', phrase: 'frieren' },
      }),
    ]);
  });

  it('doesn’t collapse muted people in search, but still applies filters', async () => {
    prisma.mute.findMany.mockResolvedValue([{ mutedId: 7 }]);
    prisma.keywordFilter.findMany.mockResolvedValue([{ phrase: 'spoilers' }]);
    posts = [
      post(1, muted, '<p>Post</p>'),
      post(2, other, '<p>Post with spoilers</p>'),
    ];

    const items = await service.searchFeed(1, 'Post');

    expect(items.map((item) => item.hiddenBecause)).toEqual([
      null,
      { kind: 'filtered', phrase: 'spoilers' },
    ]);
  });

  it('shows a person you blocked an empty profile feed without loading it', async () => {
    prisma.block.findMany.mockResolvedValue([{ blockerId: 1 }]);

    await expect(service.findForProfile(1, 'vegeta')).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(service.searchProfile(1, 'vegeta', 'Post')).resolves.toEqual(
      [],
    );
    expect(prisma.post.findMany).not.toHaveBeenCalled();
    expect(prisma.libraryActivity.findMany).not.toHaveBeenCalled();
    expect(prisma.block.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { blockerId: 1, blockedId: 2 },
          { blockerId: 2, blockedId: 1 },
        ],
      },
      select: { blockerId: true },
    });
  });

  it('still shows a site admin the profile feed of someone who blocked them', async () => {
    prisma.block.findMany.mockResolvedValue([{ blockerId: 2 }]);
    prisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(
        'username' in where
          ? { id: 2, isPublic: true }
          : { isAdmin: true, email: 'admin@anime.test' },
      ),
    );

    const { items } = await service.findForProfile(1, 'vegeta');

    expect(items).toHaveLength(1);
    expect(JSON.stringify(postWhere())).toContain(
      JSON.stringify({
        OR: [
          { author: { blocksReceived: { none: { blockerId: 1 } } } },
          { authorId: 1 },
        ],
      }),
    );
  });

  it('treats a profile whose owner blocked you as unavailable', async () => {
    prisma.block.findMany.mockResolvedValue([{ blockerId: 2 }]);

    await expect(service.findForProfile(1, 'vegeta')).rejects.toThrow(
      new NotFoundException('This profile isn’t available'),
    );
    await expect(service.searchProfile(1, 'vegeta', 'Post')).rejects.toThrow(
      new NotFoundException('This profile isn’t available'),
    );
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });
});
