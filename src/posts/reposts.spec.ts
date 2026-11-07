import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePostDto } from './dto/create-post.dto';
import { RepostDto } from './dto/repost.dto';
import { PostsService, viewablePost } from './posts.service';
import { visibleThreads } from '../forum/forum-helpers';
import {
  availableOriginals,
  shareableActivities,
  shareableIds,
  shareablePosts,
  shareType,
  visibleReposters,
  visibleReposts,
} from './shareable';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LikesService } from '../likes/likes.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';
import { publicPost, publicPosts } from '../tags/public-content';
import { GUEST_USER_ID } from '../auth/allow-guest';
import { viewableProfiles } from './wall-access';

jest.mock('../common/rich-text', () => ({
  sanitizeRichText: jest.fn((html: string) => ({ html, empty: false })),
}));

const date = new Date('2026-11-07T12:00:00Z');
const minutes = (count: number) => new Date(date.getTime() - count * 60_000);
const person = (id: number, username: string) => ({
  id,
  username,
  name: null,
  avatarUrl: null,
});
const me = person(1, 'naruto');
const sasuke = person(2, 'sasuke');
const goku = person(3, 'goku');
const luffy = person(4, 'luffy');

const post = (id: number, fields: object = {}) => ({
  id,
  createdAt: date,
  commentCount: 0,
  likeCount: 0,
  content: '<p>Post</p>',
  linkUrl: null,
  spoiler: null,
  authorId: 2,
  author: sasuke,
  communityId: 5,
  community: { id: 5, name: 'Seasonal Anime Club', iconUrl: null },
  wallUserId: null,
  wallUser: null,
  mediaType: null,
  mediaSourceId: null,
  pinnedAt: null,
  isQuote: false,
  quotePostId: null,
  quoteActivityId: null,
  ...fields,
});

const activity = (id: number, fields: object = {}) => ({
  id,
  createdAt: date,
  commentCount: 0,
  likeCount: 0,
  status: 'current',
  progressFrom: null,
  progressTo: null,
  entry: {
    mediaType: 'anime',
    sourceId: '1',
    title: 'Frieren',
    coverImage: null,
    isAdult: false,
    year: 2023,
    steamAppId: null,
    user: sasuke,
  },
  ...fields,
});

const viewer = {
  id: 1,
  reported: { post: [], comment: [], forum_post: [] },
  siteAdmin: false,
  manages: [],
};

type Args = {
  where?: object;
  select?: Record<string, unknown>;
  include?: object;
};

const isShareable = (args: Args) =>
  args.select !== undefined && Object.keys(args.select).join() === 'id';
const isQuoted = (args: Args) => args.select?.content === true;
const isLoad = (args: Args) =>
  args.include !== undefined && Object.keys(args.where ?? {}).join() === 'id';

beforeEach(() =>
  jest.useFakeTimers({
    now: date,
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
  }),
);
afterEach(() => jest.useRealTimers());

function setup() {
  const prisma = {
    block: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    mute: { findMany: jest.fn().mockResolvedValue([]) },
    keywordFilter: { findMany: jest.fn().mockResolvedValue([]) },
    contentReport: { findMany: jest.fn().mockResolvedValue([]) },
    user: {
      findUnique: jest.fn().mockResolvedValue({ showNsfw: false }),
      findFirst: jest.fn().mockResolvedValue({ id: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    community: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) },
    notification: { findFirst: jest.fn().mockResolvedValue(null) },
    friendship: { findFirst: jest.fn().mockResolvedValue(null) },
    membership: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ userId: 1 }),
    },
    bookmark: { findMany: jest.fn().mockResolvedValue([]) },
    comment: { findMany: jest.fn().mockResolvedValue([]) },
    libraryEntry: { findMany: jest.fn().mockResolvedValue([]) },
    post: {
      findFirst: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({ authorId: 2 }),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
    },
    libraryActivity: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    repost: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const notifications = { notify: jest.fn() };
  const likes = { likedBy: jest.fn().mockResolvedValue(new Set()) };
  const discordChannel = { postCreated: jest.fn() };
  const service = new PostsService(
    prisma as unknown as PrismaService,
    notifications as unknown as NotificationsService,
    likes as unknown as LikesService,
    discordChannel as unknown as DiscordChannelService,
  );
  return { prisma, notifications, service };
}

type Prisma = ReturnType<typeof setup>['prisma'];

function routePosts(
  prisma: Prisma,
  {
    listed = [],
    loaded = listed,
    shareable = [],
    quoted = [],
  }: {
    listed?: object[];
    loaded?: object[];
    shareable?: number[];
    quoted?: object[];
  },
) {
  prisma.post.findMany.mockImplementation((args: Args) =>
    Promise.resolve(
      isShareable(args)
        ? shareable.map((id) => ({ id }))
        : isQuoted(args)
          ? quoted
          : isLoad(args)
            ? loaded
            : listed,
    ),
  );
}

const notBlocked = (userId: number) => ({
  blocksMade: { none: { blockedId: userId } },
  blocksReceived: { none: { blockerId: userId } },
});

describe('Who can repost or quote', () => {
  it('only shares public posts that aren’t hidden or from a suspended author', () => {
    expect(shareablePosts(viewer, false)).toEqual({
      AND: [
        publicPost(viewer, false),
        {
          hiddenAt: null,
          author: {
            OR: [{ suspendedAt: null }, { suspendedUntil: { lte: date } }],
          },
        },
      ],
    });
    expect(JSON.stringify(publicPosts(viewer, false))).toContain(
      '"isAdult":false',
    );
    expect(JSON.stringify(shareablePosts(viewer, true))).not.toContain(
      '"isAdult":false',
    );
  });

  it('applies blocks both ways even for site admins and community managers', () => {
    expect(
      shareablePosts({ ...viewer, siteAdmin: true, manages: [5] }, false),
    ).toEqual(shareablePosts(viewer, false));
    expect(JSON.stringify(shareablePosts(viewer, false))).toContain(
      JSON.stringify({
        blocksMade: { none: { blockedId: 1 } },
        blocksReceived: { none: { blockerId: 1 } },
      }),
    );
  });

  it('only shares library updates that are public on a public profile', () => {
    expect(shareableActivities(viewer, false)).toEqual({
      entry: {
        isPublic: true,
        isAdult: false,
        user: {
          isPublic: true,
          OR: [{ suspendedAt: null }, { suspendedUntil: { lte: date } }],
          blocksMade: { none: { blockedId: 1 } },
          blocksReceived: { none: { blockerId: 1 } },
        },
      },
    });
  });

  it('only counts profile reposts by people whose profile the viewer can see', () => {
    expect(visibleReposts(1)).toEqual({
      AND: [
        visibleReposters(1),
        {
          OR: [
            { communityId: null, user: viewableProfiles(1) },
            {
              community: {
                OR: [
                  { isPublic: true },
                  { memberships: { some: { userId: 1 } } },
                ],
              },
            },
          ],
        },
      ],
    });
  });

  it('checks a batch at once and never lets guests share', async () => {
    const { prisma } = setup();
    prisma.post.findMany.mockResolvedValue([{ id: 7 }]);

    const ids = await shareableIds(
      prisma as unknown as PrismaService,
      viewer,
      false,
      'post',
      [7, 8],
    );

    expect([...ids]).toEqual([7]);
    expect(prisma.post.findMany).toHaveBeenCalledWith({
      where: { AND: [{ id: { in: [7, 8] } }, shareablePosts(viewer, false)] },
      select: { id: true },
    });

    prisma.post.findMany.mockClear();
    const guest = { ...viewer, id: GUEST_USER_ID };
    expect(
      await shareableIds(
        prisma as unknown as PrismaService,
        guest,
        false,
        'post',
        [7],
      ),
    ).toEqual(new Set());
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });
});

describe('Reposting', () => {
  const visiblePost = {
    authorId: 2,
    communityId: 5,
    mediaType: null,
    mediaSourceId: null,
    wallUser: null,
  };

  it('reposts a public post to your profile and tells the author', async () => {
    const { prisma, notifications, service } = setup();
    prisma.post.findFirst.mockResolvedValue(visiblePost);
    routePosts(prisma, { shareable: [7] });
    prisma.repost.groupBy.mockResolvedValue([
      { postId: 7, activityId: null, _count: { _all: 2 } },
    ]);
    prisma.post.groupBy.mockResolvedValue([
      { quotePostId: 7, quoteActivityId: null, _count: { _all: 1 } },
    ]);

    const result = await service.setRepost(1, { type: 'post', id: 7 }, null);

    expect(result).toEqual({ reposted: true, repostCount: 3 });
    expect(prisma.repost.createMany).toHaveBeenCalledWith({
      data: [{ userId: 1, communityId: null, postId: 7 }],
      skipDuplicates: true,
    });
    expect(prisma.membership.findUnique).not.toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith([
      {
        userId: 2,
        actorId: 1,
        type: 'repost',
        message: 'reposted your post',
        link: '/communities/5?post=7',
      },
    ]);
  });

  it('doesn’t tell the author again about the same person sharing the same thing', async () => {
    const { prisma, notifications, service } = setup();
    prisma.post.findFirst.mockResolvedValue(visiblePost);
    routePosts(prisma, { shareable: [7] });
    prisma.notification.findFirst.mockResolvedValue({ id: 12 });

    await service.setRepost(1, { type: 'post', id: 7 }, null);

    expect(prisma.notification.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 2,
        actorId: 1,
        type: { in: ['repost', 'quote'] },
        link: '/communities/5?post=7',
      },
      select: { id: true },
    });
    expect(prisma.repost.createMany).toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('doesn’t tell the author about a repost somewhere they can’t see', async () => {
    const { prisma, notifications, service } = setup();
    prisma.post.findFirst.mockResolvedValue(visiblePost);
    routePosts(prisma, { shareable: [7] });
    prisma.community.findFirst.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue(null);

    await service.setRepost(1, { type: 'post', id: 7 }, 9);
    await service.setRepost(1, { type: 'post', id: 7 }, null);

    expect(prisma.community.findFirst).toHaveBeenCalledWith({
      where: {
        id: 9,
        OR: [{ isPublic: true }, { memberships: { some: { userId: 2 } } }],
      },
      select: { id: true },
    });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: 1, ...viewableProfiles(2) },
      select: { id: true },
    });
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('refuses to repost your own post', async () => {
    const { prisma, service } = setup();
    prisma.post.findFirst.mockResolvedValue({ ...visiblePost, authorId: 1 });
    routePosts(prisma, { shareable: [7] });

    await expect(
      service.setRepost(1, { type: 'post', id: 7 }, null),
    ).rejects.toThrow(new ForbiddenException('You can’t repost this'));
    expect(prisma.repost.createMany).not.toHaveBeenCalled();
  });

  it('refuses posts that aren’t public, hidden or 18+ for the viewer', async () => {
    const { prisma, service } = setup();
    prisma.post.findFirst.mockResolvedValue(visiblePost);
    routePosts(prisma, { shareable: [] });

    await expect(
      service.setRepost(1, { type: 'post', id: 7 }, null),
    ).rejects.toThrow(new ForbiddenException('You can’t repost this'));
    expect(prisma.repost.createMany).not.toHaveBeenCalled();
  });

  it('treats a post the viewer can’t see as missing', async () => {
    const { prisma, service } = setup();
    prisma.post.findFirst.mockResolvedValue(null);

    await expect(
      service.setRepost(1, { type: 'post', id: 7 }, null),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.setRepost(1, { type: 'post', id: 2147483648 }, null),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.repost.createMany).not.toHaveBeenCalled();
  });

  it('only reposts into communities you can post in', async () => {
    const { prisma, service } = setup();
    prisma.post.findFirst.mockResolvedValue(visiblePost);
    routePosts(prisma, { shareable: [7] });
    prisma.membership.findUnique.mockResolvedValue(null);

    await expect(
      service.setRepost(1, { type: 'post', id: 7 }, 9),
    ).rejects.toThrow(new ForbiddenException('You can’t post there'));
    expect(prisma.membership.findUnique).toHaveBeenCalledWith({
      where: { userId_communityId: { userId: 1, communityId: 9 } },
      select: { userId: true },
    });
    expect(prisma.repost.createMany).not.toHaveBeenCalled();
  });

  it('moves an existing repost to the new place without notifying again', async () => {
    const { prisma, notifications, service } = setup();
    prisma.post.findFirst.mockResolvedValue(visiblePost);
    routePosts(prisma, { shareable: [7] });
    prisma.repost.createMany.mockResolvedValue({ count: 0 });
    prisma.repost.findFirst.mockResolvedValue({ id: 3, communityId: null });

    await service.setRepost(1, { type: 'post', id: 7 }, 9);

    expect(prisma.repost.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { communityId: 9, createdAt: date },
    });
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('leaves a repost that’s already there alone', async () => {
    const { prisma, service } = setup();
    prisma.post.findFirst.mockResolvedValue(visiblePost);
    routePosts(prisma, { shareable: [7] });
    prisma.repost.createMany.mockResolvedValue({ count: 0 });
    prisma.repost.findFirst.mockResolvedValue({ id: 3, communityId: 9 });

    expect(await service.setRepost(1, { type: 'post', id: 7 }, 9)).toEqual({
      reposted: true,
      repostCount: 0,
    });
    expect(prisma.repost.update).not.toHaveBeenCalled();
  });

  it('reposts a library update and links the owner to it', async () => {
    const { prisma, notifications, service } = setup();
    prisma.libraryActivity.findFirst.mockResolvedValue({
      entry: { user: { id: 2, username: 'sasuke' } },
    });
    prisma.libraryActivity.findMany.mockResolvedValue([{ id: 4 }]);

    await service.setRepost(1, { type: 'activity', id: 4 }, null);

    expect(prisma.libraryActivity.findMany).toHaveBeenCalledWith({
      where: {
        AND: [{ id: { in: [4] } }, shareableActivities(viewer, false)],
      },
      select: { id: true },
    });
    expect(prisma.repost.createMany).toHaveBeenCalledWith({
      data: [{ userId: 1, communityId: null, activityId: 4 }],
      skipDuplicates: true,
    });
    expect(notifications.notify).toHaveBeenCalledWith([
      expect.objectContaining({
        userId: 2,
        type: 'repost',
        message: 'reposted your library update',
        link: '/users/sasuke?activity=4',
      }),
    ]);
  });

  it('undoes a repost', async () => {
    const { prisma, service } = setup();
    prisma.repost.groupBy.mockResolvedValue([
      { postId: 7, activityId: null, _count: { _all: 1 } },
    ]);

    expect(await service.removeRepost(1, { type: 'post', id: 7 })).toEqual({
      reposted: false,
      repostCount: 1,
    });
    expect(prisma.repost.deleteMany).toHaveBeenCalledWith({
      where: { userId: 1, postId: 7 },
    });
  });
});

describe('Quoting', () => {
  const original = post(7);

  function quoting(prisma: Prisma, shareable = [7]) {
    prisma.post.findFirst.mockResolvedValue({
      authorId: 2,
      communityId: 5,
      mediaType: null,
      mediaSourceId: null,
      wallUser: null,
    });
    routePosts(prisma, { shareable, quoted: [original] });
    prisma.post.create.mockImplementation(({ data }) =>
      Promise.resolve(post(9, { ...data, author: me })),
    );
  }

  it('posts a quote in a community with the original embedded', async () => {
    const { prisma, notifications, service } = setup();
    quoting(prisma);

    const created = await service.create(5, 1, {
      content: '<p>Look at this</p>',
      quote: { type: 'post', id: 7 },
    });

    expect(prisma.post.create.mock.calls[0][0].data).toMatchObject({
      communityId: 5,
      authorId: 1,
      content: '<p>Look at this</p>',
      isQuote: true,
      quotePostId: 7,
      quoteActivityId: null,
    });
    expect(notifications.notify).toHaveBeenCalledWith([
      {
        userId: 2,
        actorId: 1,
        type: 'quote',
        message: 'quoted your post',
        link: '/communities/5?post=7',
      },
    ]);
    expect(created).toMatchObject({
      repostCount: 0,
      reposted: false,
      canRepost: false,
      repostedBy: null,
      quote: {
        available: true,
        type: 'post',
        post: {
          id: 7,
          author: { username: 'sasuke' },
          community: { id: 5 },
          wallUser: null,
          media: null,
          hiddenBecause: null,
        },
      },
    });
  });

  it('refuses to quote something that can’t be shared', async () => {
    const { prisma, notifications, service } = setup();
    quoting(prisma, []);

    await expect(
      service.create(5, 1, {
        content: '<p>Look</p>',
        quote: { type: 'post', id: 7 },
      }),
    ).rejects.toThrow(new ForbiddenException('You can’t quote this'));
    expect(prisma.post.create).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('only posts quotes on your own profile', async () => {
    const { prisma, service } = setup();
    quoting(prisma);
    prisma.user.findUnique.mockResolvedValueOnce({ id: 2, username: 'sasuke' });
    prisma.friendship.findFirst.mockResolvedValue({ requesterId: 1 });

    await expect(
      service.createOnWall('sasuke', 1, {
        content: '<p>Look</p>',
        quote: { type: 'post', id: 7 },
      }),
    ).rejects.toThrow(new ForbiddenException('You can’t post there'));
    expect(prisma.post.create).not.toHaveBeenCalled();
  });

  it('refuses a quote on a title page or in an edit', async () => {
    const { prisma, service } = setup();
    const body = { content: '<p>Look</p>', quote: { type: 'post', id: 7 } };

    await expect(
      service.createOnMedia('anime', '42', 1, body as CreatePostDto),
    ).rejects.toThrow(new BadRequestException('You can’t quote here'));
    await expect(service.update(1, 9, body as CreatePostDto)).rejects.toThrow(
      new BadRequestException('You can’t quote here'),
    );
    expect(prisma.post.create).not.toHaveBeenCalled();
    expect(prisma.post.findUnique).not.toHaveBeenCalled();
  });

  it('posts a quote on your own profile', async () => {
    const { prisma, notifications, service } = setup();
    quoting(prisma);
    prisma.user.findUnique.mockResolvedValueOnce({ id: 1, username: 'naruto' });

    const created = await service.createOnWall('naruto', 1, {
      content: '<p>Look</p>',
      quote: { type: 'post', id: 7 },
    });

    expect(prisma.post.create.mock.calls[0][0].data).toMatchObject({
      wallUserId: 1,
      authorId: 1,
      isQuote: true,
      quotePostId: 7,
    });
    expect(notifications.notify).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 2, type: 'quote' }),
    ]);
    expect(created.quote).toMatchObject({ available: true, type: 'post' });
  });
});

describe('Quote embeds', () => {
  it('shows a post’s quote, with the title it was posted on', async () => {
    const { prisma, service } = setup();
    routePosts(prisma, {
      listed: [post(9, { isQuote: true, quotePostId: 7 })],
      quoted: [post(7, { mediaType: 'anime', mediaSourceId: '42' })],
    });
    prisma.libraryEntry.findMany.mockResolvedValue([
      { mediaType: 'anime', sourceId: '42', title: 'Frieren' },
    ]);

    const [item] = await service.findByIds(1, [9]);

    expect(item.quote).toMatchObject({
      available: true,
      type: 'post',
      post: {
        id: 7,
        media: { type: 'anime', sourceId: '42', title: 'Frieren' },
      },
    });
    const quotedQuery = prisma.post.findMany.mock.calls
      .map(([args]) => args)
      .find(isQuoted);
    expect(quotedQuery.where).toEqual({
      AND: [
        { id: { in: [7] } },
        publicPost({ ...viewer, blocked: new Set() } as never, false),
      ],
    });
  });

  it('says the original isn’t available once the viewer can’t see it or it’s gone', async () => {
    const { prisma, service } = setup();
    routePosts(prisma, {
      listed: [
        post(9, { isQuote: true, quotePostId: 7 }),
        post(10, { isQuote: true }),
        post(11),
      ],
      quoted: [],
    });

    const items = await service.findByIds(1, [9, 10, 11]);

    expect(items.map((item) => item.quote)).toEqual([
      { available: false },
      { available: false },
      null,
    ]);
  });

  it('says the original isn’t available when its author and the quoter blocked each other', async () => {
    const { prisma, service } = setup();
    routePosts(prisma, {
      listed: [
        post(9, { isQuote: true, quotePostId: 7, authorId: 3, author: goku }),
        post(10, { isQuote: true, quotePostId: 7, authorId: 4, author: luffy }),
      ],
      quoted: [post(7)],
    });
    prisma.block.findMany.mockImplementation(
      ({ where }: { where: { OR: { blockerId: unknown }[] } }) =>
        Promise.resolve(
          typeof where.OR[0].blockerId === 'object'
            ? [{ blockerId: 2, blockedId: 3 }]
            : [],
        ),
    );

    const items = await service.findByIds(1, [9, 10]);

    expect(items.map((item) => item.quote?.available)).toEqual([false, true]);
    expect(prisma.block.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { blockerId: { in: [3, 4] }, blockedId: { in: [2] } },
          { blockerId: { in: [2] }, blockedId: { in: [3, 4] } },
        ],
      },
      select: { blockerId: true, blockedId: true },
    });
  });

  it('embeds a quoted library update', async () => {
    const { prisma, service } = setup();
    routePosts(prisma, {
      listed: [post(9, { isQuote: true, quoteActivityId: 4 })],
    });
    prisma.libraryActivity.findMany.mockImplementation((args: Args) =>
      Promise.resolve(args.include ? [activity(4)] : []),
    );

    const [item] = await service.findByIds(1, [9]);

    expect(item.quote).toMatchObject({
      available: true,
      type: 'activity',
      activity: {
        type: 'activity',
        id: 4,
        author: { username: 'sasuke' },
        media: { title: 'Frieren' },
        liked: false,
      },
    });
  });
});

describe('Repost counts', () => {
  it('counts reposts and quotes, and knows what the viewer may do', async () => {
    const { prisma, service } = setup();
    routePosts(prisma, {
      listed: [post(7), post(8, { author: me, authorId: 1 }), post(9)],
      shareable: [7, 8],
    });
    prisma.repost.groupBy.mockResolvedValue([
      { postId: 7, activityId: null, _count: { _all: 2 } },
    ]);
    prisma.post.groupBy.mockResolvedValue([
      { quotePostId: 7, quoteActivityId: null, _count: { _all: 1 } },
      { quotePostId: 8, quoteActivityId: null, _count: { _all: 4 } },
    ]);
    prisma.repost.findMany.mockResolvedValue([{ postId: 7, activityId: null }]);

    const items = await service.findByIds(1, [7, 8, 9]);

    expect(
      items.map(({ id, repostCount, reposted, canRepost, canQuote }) => ({
        id,
        repostCount,
        reposted,
        canRepost,
        canQuote,
      })),
    ).toEqual([
      {
        id: 7,
        repostCount: 3,
        reposted: true,
        canRepost: true,
        canQuote: true,
      },
      {
        id: 8,
        repostCount: 4,
        reposted: false,
        canRepost: false,
        canQuote: true,
      },
      {
        id: 9,
        repostCount: 0,
        reposted: false,
        canRepost: false,
        canQuote: false,
      },
    ]);
    expect(prisma.repost.groupBy).toHaveBeenCalledWith({
      by: ['postId', 'activityId'],
      where: {
        AND: [
          {
            OR: [{ postId: { in: [7, 8, 9] } }, { activityId: { in: [] } }],
          },
          visibleReposts(1),
        ],
      },
      _count: { _all: true },
    });
    expect(prisma.post.groupBy.mock.calls[0][0].where.AND[0]).toEqual({
      OR: [
        { quotePostId: 7, author: notBlocked(2) },
        { quotePostId: 8, author: notBlocked(1) },
        { quotePostId: 9, author: notBlocked(2) },
      ],
    });
    expect(items.every((item) => item.repostedBy === null)).toBe(true);
  });
});

describe('Reposts in lists', () => {
  const repost = (
    id: number,
    ago: number,
    target: { postId?: number; activityId?: number },
  ) => ({
    id,
    createdAt: minutes(ago),
    postId: target.postId ?? null,
    activityId: target.activityId ?? null,
  });

  it('shows a reposted original once, at its newest repost, with who reposted it', async () => {
    const { prisma, service } = setup();
    routePosts(prisma, {
      listed: [post(5, { createdAt: minutes(60) })],
      loaded: [post(8)],
    });
    const people: Record<number, object[]> = {
      5: [{ user: goku }, { user: luffy }],
      8: [{ user: goku }],
    };
    prisma.repost.findMany.mockImplementation(
      (args: Args & { where: { AND: { postId?: number }[] } }) =>
        Promise.resolve(
          args.select?.createdAt
            ? [
                repost(30, 1, { postId: 5 }),
                repost(29, 2, { postId: 8 }),
                repost(28, 3, { postId: 5 }),
              ]
            : (people[args.where.AND[1].postId ?? 0] ?? []),
        ),
    );
    prisma.repost.groupBy.mockResolvedValue([
      { postId: 5, activityId: null, _count: { _all: 2 } },
      { postId: 8, activityId: null, _count: { _all: 1 } },
    ]);

    const page = await service.findForMember(1);

    expect(page.items.map(({ type, id }) => `${type}:${id}`)).toEqual([
      'post:5',
      'post:8',
    ]);
    expect(page.items[0].repostedBy).toEqual({
      people: [goku, luffy],
      total: 2,
    });
    expect(page.items[1].repostedBy).toEqual({ people: [goku], total: 1 });
    expect(page.nextCursor).toBeNull();
    const loads = prisma.post.findMany.mock.calls
      .map(([args]) => args)
      .filter(isLoad);
    expect(loads.map(({ where }) => where)).toEqual([{ id: { in: [8] } }]);
    const previews = prisma.repost.findMany.mock.calls
      .map(([args]) => args)
      .filter((args: Args) => args.select?.user !== undefined);
    expect(
      previews.map(({ where, orderBy, take }) => ({
        original: where.AND[1],
        orderBy,
        take,
      })),
    ).toEqual([
      {
        original: { postId: 5, activityId: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
      },
      {
        original: { postId: 8, activityId: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
      },
    ]);
  });

  it('only follows reposts from the home feed’s places to originals the viewer can see', async () => {
    const { prisma, service } = setup();

    await service.findForMember(1);

    const { where, take } = prisma.repost.findMany.mock.calls[0][0];
    expect(take).toBe(30);
    expect(where.AND[0].OR).toEqual([
      { community: { memberships: { some: { userId: 1 } } } },
      { communityId: null, userId: 1 },
      { communityId: null, user: expect.any(Object) },
    ]);
    expect(where.AND[1]).toEqual(visibleReposters(1, { muted: true }));
    expect(where.AND[2]).toEqual(
      availableOriginals(viewer, false, { muted: true }),
    );
  });

  it('keeps the cursor on the last repost it showed', async () => {
    const { prisma, service } = setup();
    routePosts(prisma, {
      listed: Array.from({ length: 9 }, (_, index) =>
        post(index + 1, { createdAt: minutes(10 + index) }),
      ),
    });
    prisma.repost.findMany.mockImplementation((args: Args) =>
      Promise.resolve(
        args.select?.createdAt
          ? [repost(40, 19, { postId: 50 }), repost(41, 20, { postId: 51 })]
          : [],
      ),
    );

    const first = await service.findForMember(1);

    expect(first.items).toHaveLength(9);
    expect(first.nextCursor).toBe(`${minutes(19).getTime()}_1_40`);

    prisma.post.findMany.mockClear();
    prisma.repost.findMany.mockClear();
    prisma.libraryActivity.findMany.mockClear();
    await service.findForMember(1, first.nextCursor!);

    const at = minutes(19);
    expect(prisma.repost.findMany.mock.calls[0][0].where.AND[3]).toEqual({
      OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: 40 } }],
    });
    expect(prisma.post.findMany.mock.calls[0][0].where.AND[1]).toEqual({
      createdAt: { lte: at },
    });
    expect(
      prisma.libraryActivity.findMany.mock.calls[0][0].where,
    ).toMatchObject({ createdAt: { lt: at } });
  });

  it('never skips past the last repost it fetched', async () => {
    const { prisma, service } = setup();
    routePosts(prisma, {
      listed: [post(1, { createdAt: minutes(45) })],
      loaded: [post(50)],
    });
    prisma.repost.findMany.mockImplementation((args: Args) =>
      Promise.resolve(
        args.select?.createdAt
          ? Array.from({ length: 30 }, (_, index) =>
              repost(100 - index, index + 1, { postId: 50 }),
            )
          : [],
      ),
    );

    const page = await service.findForMember(1);

    expect(page.items.map(({ id }) => id)).toEqual([50]);
    expect(page.nextCursor).toBe(`${minutes(30).getTime()}_1_71`);
  });

  it('shows reposts placed in a community, without pinning other communities’ posts there', async () => {
    const { prisma, service } = setup();
    routePosts(prisma, {
      loaded: [post(8, { communityId: 6, pinnedAt: date })],
    });
    prisma.repost.findMany.mockImplementation((args: Args) =>
      Promise.resolve(
        args.select?.createdAt ? [repost(30, 1, { postId: 8 })] : [],
      ),
    );

    const { items } = await service.findForCommunity(1, 9);

    expect(items).toEqual([
      expect.objectContaining({ id: 8, pinned: false, canPin: false }),
    ]);
    expect(prisma.repost.findMany.mock.calls[0][0].where.AND[0]).toEqual({
      communityId: 9,
    });
  });

  it('shows the profile owner’s reposts on their profile, muted people included', async () => {
    const { prisma, service } = setup();
    prisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(
        'username' in where ? { id: 2, isPublic: true } : { showNsfw: false },
      ),
    );

    await service.findForProfile(1, 'sasuke');

    const { where } = prisma.repost.findMany.mock.calls[0][0];
    expect(where.AND[0]).toEqual({
      userId: 2,
      OR: [
        { communityId: null },
        {
          community: {
            OR: [{ isPublic: true }, { memberships: { some: { userId: 1 } } }],
          },
        },
      ],
    });
    expect(JSON.stringify(where)).not.toContain('mutesReceived');
  });

  it('leaves reposts out when the viewer hides that type', async () => {
    const { prisma, service } = setup();

    await service.findForMember(1, undefined, 'post,activity');
    expect(prisma.repost.findMany).not.toHaveBeenCalled();

    await service.findForMember(1, undefined, 'activity');
    expect(prisma.repost.findMany.mock.calls[0][0].where.AND[2]).toEqual(
      availableOriginals(viewer, false, {
        muted: true,
        excluded: new Set(['activity']),
      }),
    );
  });
});

describe('Who reposted and quoted', () => {
  it('lists people who reposted, newest first, with a cursor', async () => {
    const { prisma, service } = setup();
    prisma.post.findFirst.mockResolvedValue({
      authorId: 2,
      communityId: 5,
      mediaType: null,
      mediaSourceId: null,
      wallUser: null,
    });
    prisma.repost.findMany.mockResolvedValue(
      Array.from({ length: 11 }, (_, index) => ({
        id: 50 - index,
        createdAt: minutes(index),
        user: goku,
      })),
    );

    const page = await service.findReposters(1, { type: 'post', id: 7 });

    expect(page.items).toHaveLength(10);
    expect(page.items[0]).toEqual({ ...goku, repostedAt: minutes(0) });
    expect(page.nextCursor).toBe(`${minutes(9).getTime()}_41`);
    expect(prisma.repost.findMany.mock.calls[0][0].where).toEqual({
      AND: [{ postId: 7 }, visibleReposts(1), {}],
    });
  });

  it('says a post the viewer can’t see isn’t there', async () => {
    const { prisma, service } = setup();
    prisma.post.findFirst.mockResolvedValue(null);

    await expect(
      service.findReposters(1, { type: 'post', id: 7 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.findQuotes(1, { type: 'post', id: 7 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.repost.findMany).not.toHaveBeenCalled();
  });

  it('says a wall post across a block with the wall’s owner, or a forum opener the viewer can’t see, isn’t there', async () => {
    const { prisma, service } = setup();
    prisma.post.findFirst.mockResolvedValue(null);

    await expect(
      service.findReposters(1, { type: 'post', id: 7 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.findQuotes(1, { type: 'post', id: 7 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    for (const [{ where }] of prisma.post.findFirst.mock.calls) {
      expect(where).toEqual({ id: 7, ...viewablePost(viewer, false) });
      expect(where.AND).toEqual(
        expect.arrayContaining([
          {
            OR: [
              { forumThreadId: null },
              { forumThread: visibleThreads(viewer) },
            ],
          },
          { OR: [{ wallUserId: null }, { wallUser: notBlocked(1) }] },
        ]),
      );
    }
    expect(prisma.post.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.repost.findMany).not.toHaveBeenCalled();
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });

  it('only lists for library updates the viewer could open on the profile', async () => {
    const { prisma, service } = setup();
    prisma.libraryActivity.findFirst.mockResolvedValue(null);

    await expect(
      service.findReposters(1, { type: 'activity', id: 4 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.libraryActivity.findFirst.mock.calls[0][0].where).toEqual({
      id: 4,
      entry: {
        OR: [{ isPublic: true }, { userId: 1 }],
        isAdult: false,
        user: {
          AND: [
            { OR: [{ suspendedAt: null }, { suspendedUntil: { lte: date } }] },
            notBlocked(1),
            viewableProfiles(1),
          ],
        },
      },
    });
    expect(prisma.repost.findMany).not.toHaveBeenCalled();
  });

  it('leaves 18+ posts out unless the viewer shows them', async () => {
    const { prisma, service } = setup();
    prisma.post.findFirst.mockResolvedValue(null);

    await expect(
      service.findQuotes(1, { type: 'post', id: 7 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.post.findFirst.mock.calls[0][0].where.AND).toContainEqual({
      isAdult: false,
    });

    prisma.user.findUnique.mockResolvedValue({ showNsfw: true });
    await expect(
      service.findQuotes(1, { type: 'post', id: 7 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.post.findFirst.mock.calls[1][0].where.AND).not.toContainEqual(
      { isAdult: false },
    );
  });

  it('lists quotes of a library update as posts', async () => {
    const { prisma, service } = setup();
    prisma.libraryActivity.findFirst.mockResolvedValue({
      entry: { user: { id: 2, username: 'sasuke' } },
    });
    routePosts(prisma, {
      listed: [post(9, { isQuote: true, quoteActivityId: 4 })],
    });

    const page = await service.findQuotes(
      1,
      { type: 'activity', id: 4 },
      `${minutes(5).getTime()}_12`,
    );

    expect(page).toMatchObject({
      items: [{ type: 'post', id: 9 }],
      nextCursor: null,
    });
    const listed = prisma.post.findMany.mock.calls[0][0];
    expect(listed.where.AND[0]).toEqual({
      quoteActivityId: 4,
      author: notBlocked(2),
    });
    expect(listed.where.AND[2]).toEqual({
      OR: [
        { createdAt: { lt: minutes(5) } },
        { createdAt: minutes(5), id: { lt: 12 } },
      ],
    });
  });
});

describe('Repost and quote requests', () => {
  const errors = async <T extends object>(type: new () => T, body: object) =>
    (await validate(plainToInstance(type, body))).map(
      ({ property }) => property,
    );

  it('accepts a post or library update to quote', async () => {
    expect(
      await errors(CreatePostDto, {
        content: '<p>Look</p>',
        quote: { type: 'activity', id: 4 },
      }),
    ).toEqual([]);
    expect(
      await errors(CreatePostDto, {
        content: '<p>Look</p>',
        quote: { type: 'comment', id: 0 },
      }),
    ).toEqual(['quote']);
  });

  it('takes a community or your profile as the place to repost', async () => {
    expect(await errors(RepostDto, { communityId: null })).toEqual([]);
    expect(await errors(RepostDto, { communityId: 9 })).toEqual([]);
    expect(await errors(RepostDto, { communityId: 'nine' })).toEqual([
      'communityId',
    ]);
  });

  it('only reposts posts and library updates', () => {
    expect(shareType('post')).toBe('post');
    expect(shareType('activity')).toBe('activity');
    expect(() => shareType('comment')).toThrow(NotFoundException);
  });
});
