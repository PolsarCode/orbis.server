import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ForumService } from './forum.service';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LikesService } from '../likes/likes.service';
import { PostsService } from '../posts/posts.service';
import { isForumManager, isMember } from './forum-helpers';
import { notifyMentions } from '../common/mentions';
import { requireEstablishedAccount } from '../common/new-account';

jest.mock('./forum-helpers', () => ({
  ...jest.requireActual('./forum-helpers'),
  isForumManager: jest.fn(),
  isMember: jest.fn(),
}));
jest.mock('../communities/nicknames', () => ({
  loadNicknames: jest.fn(() => (_communityId: number, author: object) => ({
    ...author,
    nickname: null,
  })),
}));
jest.mock('../common/rich-text', () => ({
  sanitizeRichText: (html: string) => ({
    html,
    empty: !html.replace(/<[^>]+>/g, '').trim(),
  }),
}));
jest.mock('../common/new-account', () => ({
  ...jest.requireActual('../common/new-account'),
  requireEstablishedAccount: jest.fn(),
}));
jest.mock('../common/mentions', () => ({
  ...jest.requireActual('../common/mentions'),
  notifyMentions: jest.fn(),
}));

const author = { id: 2, username: 'naruto', name: null, avatarUrl: null };

function thread(id: number, extra: object = {}) {
  return {
    id,
    categoryId: 5,
    title: `Thread ${id}`,
    replyCount: 0,
    lastPostAt: new Date('2026-10-30T00:00:00Z'),
    pinnedAt: null,
    lockedAt: null,
    createdAt: new Date('2026-10-30T00:00:00Z'),
    author,
    ...extra,
  };
}

const createdThread = {
  id: 9,
  posts: [{ id: 30, createdAt: new Date('2026-11-01T00:00:00Z') }],
};

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
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(),
    },
    forumCategory: { findFirst: jest.fn() },
    forumThread: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    forumPost: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    like: { deleteMany: jest.fn() },
    notification: { deleteMany: jest.fn() },
    membership: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    communityBan: { findMany: jest.fn().mockResolvedValue([]) },
    hashtag: {
      upsert: jest.fn(({ where }: { where: { name: string } }) =>
        Promise.resolve({ id: where.name.length }),
      ),
    },
    hashtagUsage: { createMany: jest.fn(), deleteMany: jest.fn() },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((operations: unknown) =>
    typeof operations === 'function'
      ? (operations as (tx: typeof prisma) => unknown)(prisma)
      : Promise.all(operations as unknown[]),
  );
  const notifications = { notify: jest.fn() };
  const likes = { likedBy: jest.fn().mockResolvedValue(new Set()) };
  const posts = {
    shareThread: jest.fn(),
    threadChanged: jest.fn(),
    removeThreadPosts: jest.fn(),
  };
  const service = new ForumService(
    prisma as unknown as PrismaService,
    notifications as unknown as NotificationsService,
    likes as unknown as LikesService,
    posts as unknown as PostsService,
  );
  return { prisma, notifications, posts, service };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isForumManager).mockResolvedValue(false);
  jest.mocked(isMember).mockResolvedValue(true);
});

describe('Forum thread lists', () => {
  it('pages through threads by latest activity and shows pinned ones on page 1 only', async () => {
    const { prisma, service } = setup();
    prisma.forumCategory.findFirst.mockResolvedValue({
      id: 5,
      name: 'General',
      description: '',
    });
    prisma.forumThread.count.mockResolvedValue(45);
    prisma.forumThread.findMany.mockImplementation(
      ({ where }: { where: { pinnedAt: unknown } }) =>
        Promise.resolve(
          where.pinnedAt === null
            ? [thread(1)]
            : [thread(2, { pinnedAt: new Date() })],
        ),
    );

    const second = await service.threads(7, 3, 5, 2);

    expect(prisma.forumThread.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.forumThread.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          categoryId: 5,
          pinnedAt: null,
          posts: { some: expect.objectContaining({ opening: true }) },
        }),
        skip: 20,
        take: 20,
      }),
    );
    expect(second).toMatchObject({
      page: 2,
      pageSize: 20,
      total: 45,
      pinned: [],
    });

    const first = await service.threads(7, 3, 5);

    expect(first.pinned).toMatchObject([{ id: 2, pinned: true }]);
    expect(first.items).toMatchObject([{ id: 1, pinned: false }]);
  });

  it('only lists categories from the same community', async () => {
    const { prisma, service } = setup();
    prisma.forumCategory.findFirst.mockResolvedValue(null);

    await expect(service.threads(7, 3, 5)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.forumCategory.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5, communityId: 3 } }),
    );
  });
});

describe('Forum thread pages', () => {
  it('opens the page that holds a linked post', async () => {
    const { prisma, service } = setup();
    prisma.forumThread.findFirst.mockResolvedValue({
      ...thread(9),
      authorId: 2,
      category: { id: 5, name: 'General' },
    });
    prisma.forumPost.findFirst.mockResolvedValue({
      id: 50,
      createdAt: new Date(),
    });
    prisma.forumPost.count.mockResolvedValueOnce(25).mockResolvedValueOnce(30);

    const result = await service.thread(7, 3, 9, undefined, 50);

    expect(result.page).toBe(2);
    expect(prisma.forumPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 20 }),
    );
  });

  it('lets members reply, but not to locked threads unless they’re admins', async () => {
    const { prisma, service } = setup();
    prisma.forumThread.findFirst.mockResolvedValue({
      ...thread(9, { lockedAt: new Date() }),
      authorId: 2,
      category: { id: 5, name: 'General' },
    });

    const member = await service.thread(7, 3, 9);
    jest.mocked(isForumManager).mockResolvedValue(true);
    const admin = await service.thread(7, 3, 9);

    expect(member.thread).toMatchObject({ locked: true, canReply: false });
    expect(admin.thread).toMatchObject({ canReply: true, canModerate: true });
  });
});

describe('Moderating authors from a thread', () => {
  function post(id: number, authorId: number) {
    return {
      id,
      threadId: 9,
      opening: id === 40,
      content: '<p>Hi</p>',
      quoteId: null,
      likeCount: 0,
      hiddenAt: null,
      editedAt: null,
      createdAt: new Date(),
      author: { ...author, id: authorId },
    };
  }

  it('offers admins remove and ban on other people’s posts, and nobody else', async () => {
    const { prisma, service } = setup();
    prisma.forumThread.findFirst.mockResolvedValue({
      ...thread(9),
      authorId: 4,
      category: { id: 5, name: 'General', section: null },
    });
    prisma.forumPost.findMany.mockResolvedValue([post(40, 4), post(41, 7)]);
    prisma.membership.findMany.mockResolvedValue([
      { userId: 7, communityId: 3, community: { ownerId: 7 }, roles: [] },
      { userId: 4, communityId: 3, community: { ownerId: 7 }, roles: [] },
    ]);

    const member = await service.thread(7, 3, 9);
    expect(member.items.map(({ moderation }) => moderation)).toEqual([
      null,
      null,
    ]);
    expect(prisma.membership.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 7, OR: expect.any(Array) },
      }),
    );

    jest.mocked(isForumManager).mockResolvedValue(true);
    const owner = await service.thread(7, 3, 9);
    expect(owner.items.map(({ moderation }) => moderation)).toEqual([
      { remove: true, ban: true },
      null,
    ]);
  });
});

describe('Blocked and muted people in forum threads', () => {
  function post(id: number, authorId: number, extra: object = {}) {
    return {
      id,
      threadId: 9,
      opening: id === 40,
      content: '<p>Frieren is peak</p>',
      linkUrl: null,
      spoiler: null,
      quoteId: null,
      likeCount: 0,
      hiddenAt: null,
      editedAt: null,
      createdAt: new Date(),
      author: { ...author, id: authorId },
      ...extra,
    };
  }

  function threadSetup() {
    const context = setup();
    context.prisma.forumThread.findFirst.mockResolvedValue({
      ...thread(9),
      authorId: 4,
      category: { id: 5, name: 'General', section: null },
    });
    return context;
  }

  it('leaves out posts from people blocked either way', async () => {
    const { prisma, service } = threadSetup();

    await service.thread(1, 3, 9);

    const [{ where }] = prisma.forumPost.findMany.mock.calls[0];
    expect(where.AND).toContainEqual({
      OR: [
        {
          author: {
            blocksMade: { none: { blockedId: 1 } },
            blocksReceived: { none: { blockerId: 1 } },
          },
        },
        { authorId: 1 },
      ],
    });
  });

  it('collapses muted people and filtered phrases, but not the viewer’s own posts', async () => {
    const { prisma, service } = threadSetup();
    prisma.mute.findMany.mockResolvedValue([{ mutedId: 7 }]);
    prisma.keywordFilter.findMany.mockResolvedValue([{ phrase: 'frieren' }]);
    prisma.forumPost.findMany.mockResolvedValue([
      post(40, 7),
      post(41, 4),
      post(42, 4, { content: '<p>Episode 12</p>', spoiler: 'Frieren' }),
      post(43, 4, { content: '<p>Dungeon Meshi</p>' }),
      post(44, 1),
    ]);

    const { items } = await service.thread(1, 3, 9);

    const filtered = { kind: 'filtered', phrase: 'frieren' };
    expect(items.map(({ hiddenBecause }) => hiddenBecause)).toEqual([
      { kind: 'muted' },
      filtered,
      filtered,
      null,
      null,
    ]);
  });

  it('collapses quotes of muted people and filtered phrases like the posts themselves', async () => {
    const { prisma, service } = threadSetup();
    prisma.mute.findMany.mockResolvedValue([{ mutedId: 7 }]);
    prisma.keywordFilter.findMany.mockResolvedValue([{ phrase: 'frieren' }]);
    const quote = (id: number, authorId: number, content: string) => ({
      id,
      content,
      linkUrl: null,
      spoiler: null,
      createdAt: new Date(),
      author: { ...author, id: authorId },
    });
    prisma.forumPost.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        'threadId' in where
          ? [
              post(45, 4, { content: '<p>Agreed</p>', quoteId: 50 }),
              post(46, 4, { content: '<p>Agreed</p>', quoteId: 51 }),
              post(47, 4, { content: '<p>Agreed</p>', quoteId: 52 }),
              post(48, 4, { content: '<p>Agreed</p>', quoteId: 53 }),
            ]
          : [
              quote(50, 7, '<p>Dungeon Meshi</p>'),
              quote(51, 4, '<p>Frieren is peak</p>'),
              quote(52, 4, '<p>Dungeon Meshi</p>'),
            ],
      ),
    );

    const { items } = await service.thread(1, 3, 9);

    expect(items.map(({ quote }) => quote)).toEqual([
      expect.objectContaining({ id: 50, hiddenBecause: { kind: 'muted' } }),
      expect.objectContaining({
        id: 51,
        hiddenBecause: { kind: 'filtered', phrase: 'frieren' },
      }),
      expect.objectContaining({ id: 52, hiddenBecause: null }),
      { id: 53, available: false },
    ]);
  });

  it('shows community admins posts from people who blocked them in the communities they run', async () => {
    const { prisma, service } = threadSetup();
    prisma.membership.findMany.mockResolvedValue([
      { communityId: 3, community: { ownerId: 1 }, roles: [] },
    ]);

    await service.thread(1, 3, 9);

    const [{ where }] = prisma.forumPost.findMany.mock.calls[0];
    expect(where.AND).toContainEqual({
      OR: [
        {
          author: {
            blocksMade: { none: { blockedId: 1 } },
            blocksReceived: { none: { blockerId: 1 } },
          },
        },
        { authorId: 1 },
        {
          communityId: { in: [3] },
          author: { blocksReceived: { none: { blockerId: 1 } } },
        },
      ],
    });
  });

  it('shows site admins posts from people who blocked them', async () => {
    const { prisma, service } = threadSetup();
    prisma.user.findUnique.mockResolvedValue({
      isAdmin: true,
      email: 'admin@anime.test',
    });

    await service.thread(1, 3, 9);

    const [{ where }] = prisma.forumPost.findMany.mock.calls[0];
    expect(where.AND).toContainEqual({
      OR: [
        { author: { blocksReceived: { none: { blockerId: 1 } } } },
        { authorId: 1 },
      ],
    });
  });
});

describe('Starting threads', () => {
  it('saves a tidy title with the opening post', async () => {
    const { prisma, service } = setup();
    prisma.forumCategory.findFirst.mockResolvedValue({ id: 5 });
    prisma.forumThread.create.mockResolvedValue(createdThread);

    await service.createThread(7, 3, 5, {
      title: '  Best   arc?  ',
      content: '<p>Discuss</p>',
    });

    expect(prisma.forumThread.create).toHaveBeenCalledWith({
      data: {
        communityId: 3,
        categoryId: 5,
        authorId: 7,
        title: 'Best arc?',
        posts: {
          create: {
            communityId: 3,
            authorId: 7,
            opening: true,
            content: '<p>Discuss</p>',
            linkUrl: null,
            spoiler: null,
          },
        },
      },
      select: { id: true, posts: { select: { id: true, createdAt: true } } },
    });
  });

  it('also posts new threads to the community feed when the category is set to', async () => {
    const { prisma, posts, service } = setup();
    prisma.forumThread.create.mockResolvedValue(createdThread);

    prisma.forumCategory.findFirst.mockResolvedValue({ postToFeed: false });
    await service.createThread(7, 3, 5, {
      title: 'Quiet',
      content: '<p>Hi</p>',
    });
    expect(posts.shareThread).not.toHaveBeenCalled();

    prisma.forumCategory.findFirst.mockResolvedValue({ postToFeed: true });
    await service.createThread(7, 3, 5, {
      title: 'Watch party',
      content: '<p>Friday</p>',
    });
    expect(posts.shareThread).toHaveBeenCalledWith(
      {
        id: 9,
        communityId: 3,
        authorId: 7,
        content: '<p>Friday</p>',
        linkUrl: null,
        spoiler: null,
      },
      [],
    );
  });

  it('marks the opening post and its feed post as spoilers', async () => {
    const { prisma, posts, service } = setup();
    prisma.forumCategory.findFirst.mockResolvedValue({ postToFeed: true });
    prisma.forumThread.create.mockResolvedValue(createdThread);

    await service.createThread(7, 3, 5, {
      title: 'Episode 12',
      content: '<p>They lose</p>',
      spoiler: ' Episode 12 ',
    });

    const [{ data }] = prisma.forumThread.create.mock.calls[0];
    expect(data.posts.create.spoiler).toBe('Episode 12');
    expect(posts.shareThread).toHaveBeenCalledWith(
      expect.objectContaining({ spoiler: 'Episode 12' }),
      [],
    );
  });

  it('needs a title and a body', async () => {
    const { prisma, service } = setup();
    prisma.forumCategory.findFirst.mockResolvedValue({ id: 5 });

    await expect(
      service.createThread(7, 3, 5, { title: '   ', content: '<p>Hi</p>' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createThread(7, 3, 5, { title: 'Hi', content: '<p></p>' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.forumThread.create).not.toHaveBeenCalled();
  });

  it('can start with just a link, which it saves with the opening post and its feed post', async () => {
    const { prisma, posts, service } = setup();
    prisma.forumCategory.findFirst.mockResolvedValue({ postToFeed: true });
    prisma.forumThread.create.mockResolvedValue(createdThread);
    const linkUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

    await service.createThread(7, 3, 5, {
      title: 'Opening song',
      content: '<p></p>',
      linkUrl,
    });

    expect(requireEstablishedAccount).toHaveBeenCalledWith(
      prisma,
      7,
      'post links',
    );
    expect(prisma.forumThread.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          posts: {
            create: expect.objectContaining({ content: '', linkUrl }),
          },
        }),
      }),
    );
    expect(posts.shareThread).toHaveBeenCalledWith(
      expect.objectContaining({ content: '', linkUrl }),
      [],
    );
  });
});

describe('Admin-only categories', () => {
  it('only lets admins start threads when the category or its section is admin-only', async () => {
    const { prisma, service } = setup();
    prisma.forumThread.create.mockResolvedValue(createdThread);
    const body = { title: 'News', content: '<p>Big news</p>' };

    for (const category of [
      { adminOnly: true, section: null },
      { adminOnly: false, section: { adminOnly: true } },
    ]) {
      prisma.forumCategory.findFirst.mockResolvedValue(category);
      await expect(service.createThread(7, 3, 5, body)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
    expect(prisma.forumThread.create).not.toHaveBeenCalled();

    jest.mocked(isForumManager).mockResolvedValue(true);
    await service.createThread(7, 3, 5, body);
    expect(prisma.forumThread.create).toHaveBeenCalled();
  });

  it('tells members they can’t post there, and admins they can', async () => {
    const { prisma, service } = setup();
    prisma.forumCategory.findFirst.mockResolvedValue({
      id: 5,
      name: 'Announcements',
      description: '',
      adminOnly: false,
      section: { id: 1, name: 'Club', adminOnly: true },
    });

    const member = await service.threads(7, 3, 5);
    jest.mocked(isForumManager).mockResolvedValue(true);
    const admin = await service.threads(7, 3, 5);

    expect(member.category).toEqual({
      id: 5,
      name: 'Announcements',
      description: '',
      adminOnly: true,
      section: { id: 1, name: 'Club' },
    });
    expect(member.canPost).toBe(false);
    expect(admin.canPost).toBe(true);
  });
});

describe('Replying', () => {
  function visibleThread(
    prisma: ReturnType<typeof setup>['prisma'],
    extra = {},
  ) {
    prisma.forumThread.findFirst.mockResolvedValue({
      ...thread(9, { title: 'Arc', ...extra }),
      authorId: 2,
      category: { id: 5, name: 'General' },
    });
    prisma.forumPost.create.mockResolvedValue({ id: 41 });
  }

  it('saves a link with a reply', async () => {
    const { prisma, service } = setup();
    visibleThread(prisma);
    const linkUrl = 'https://myanimelist.net/anime/52991';

    await service.reply(7, 3, 9, { content: '<p>Rated it here</p>', linkUrl });

    expect(prisma.forumPost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: '<p>Rated it here</p>',
          linkUrl,
        }),
      }),
    );
  });

  it('refuses replies to locked threads from people who aren’t admins', async () => {
    const { prisma, service } = setup();
    visibleThread(prisma, { lockedAt: new Date() });

    await expect(
      service.reply(7, 3, 9, { content: '<p>Late</p>' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.forumPost.create).not.toHaveBeenCalled();

    jest.mocked(isForumManager).mockResolvedValue(true);
    await service.reply(7, 3, 9, { content: '<p>Locked for good</p>' });
    expect(prisma.forumPost.create).toHaveBeenCalled();
  });

  it('notifies the quoted person and the thread author once each', async () => {
    const { prisma, notifications, service } = setup();
    visibleThread(prisma);
    prisma.forumPost.findFirst.mockResolvedValue({ id: 40, authorId: 4 });

    await service.reply(7, 3, 9, { content: '<p>Agreed</p>', quoteId: 40 });

    const link = '/communities/3/forum/threads/9?post=41';
    expect(prisma.forumThread.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { replyCount: { increment: 1 }, lastPostAt: expect.any(Date) },
    });
    expect(notifications.notify).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 4, type: 'forum_quote', link }),
      expect.objectContaining({ userId: 2, type: 'forum_reply', link }),
    ]);
    expect(notifyMentions).toHaveBeenCalledWith(
      prisma,
      notifications,
      expect.objectContaining({ link, alreadyNotified: [4, 2] }),
    );
  });

  it('sends the thread author one notification when they’re the one quoted', async () => {
    const { prisma, notifications, service } = setup();
    visibleThread(prisma);
    prisma.forumPost.findFirst.mockResolvedValue({ id: 40, authorId: 2 });

    await service.reply(7, 3, 9, { content: '<p>Agreed</p>', quoteId: 40 });

    expect(notifications.notify).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 2, type: 'forum_quote' }),
    ]);
  });

  it('only quotes posts from the same thread that the person can see', async () => {
    const { prisma, service } = setup();
    visibleThread(prisma);
    prisma.forumPost.findFirst.mockResolvedValue(null);

    await expect(
      service.reply(7, 3, 9, { content: '<p>Hm</p>', quoteId: 40 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.forumPost.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 40, threadId: 9 }),
      }),
    );
    expect(prisma.forumPost.create).not.toHaveBeenCalled();
  });
});

describe('Editing and deleting', () => {
  it('only lets the author edit a post', async () => {
    const { prisma, service } = setup();
    prisma.forumPost.findFirst.mockResolvedValue({
      authorId: 2,
      content: '<p>Mine</p>',
      threadId: 9,
    });

    await expect(
      service.updatePost(7, 3, 40, { content: '<p>Not mine</p>' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.forumPost.update).not.toHaveBeenCalled();
  });

  it('keeps the feed post in step when the opening post or title changes', async () => {
    const { prisma, posts, service } = setup();
    prisma.forumPost.update.mockResolvedValue({
      id: 40,
      opening: true,
      content: '<p>New</p>',
      author,
    });

    prisma.forumPost.findFirst.mockResolvedValue({
      authorId: 7,
      content: '<p>Old</p>',
      threadId: 9,
      opening: false,
    });
    await service.updatePost(7, 3, 41, { content: '<p>Reply</p>' });
    expect(posts.threadChanged).not.toHaveBeenCalled();

    prisma.forumPost.findFirst.mockResolvedValue({
      authorId: 7,
      content: '<p>Old</p>',
      threadId: 9,
      opening: true,
    });
    await service.updatePost(7, 3, 40, { content: '<p>New</p>' });
    expect(posts.threadChanged).toHaveBeenCalledWith(
      9,
      { content: '<p>New</p>', linkUrl: null },
      [],
    );

    prisma.forumThread.findFirst.mockResolvedValue({
      authorId: 7,
      categoryId: 5,
    });
    await service.updateThread(7, 3, 9, { title: 'Renamed' });
    expect(posts.threadChanged).toHaveBeenLastCalledWith(9);
  });

  it('only lets admins move threads, and only within the community', async () => {
    const { prisma, service } = setup();
    prisma.forumThread.findFirst.mockResolvedValue({
      authorId: 7,
      categoryId: 5,
    });

    await expect(
      service.updateThread(7, 3, 9, { categoryId: 6 }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    jest.mocked(isForumManager).mockResolvedValue(true);
    prisma.forumCategory.findFirst.mockResolvedValue(null);
    await expect(
      service.updateThread(7, 3, 9, { categoryId: 6 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.forumThread.update).not.toHaveBeenCalled();
  });

  it('deletes the whole thread with its opening post, cleaning up likes, reports and notifications', async () => {
    const { prisma, posts, service } = setup();
    prisma.forumPost.findFirst.mockResolvedValue({
      authorId: 7,
      threadId: 9,
      opening: true,
    });
    prisma.forumThread.findFirst.mockResolvedValue({
      authorId: 7,
      posts: [{ id: 40 }, { id: 41 }],
    });

    await service.removePost(7, 3, 40);

    expect(posts.removeThreadPosts).toHaveBeenCalledWith([9]);
    expect(prisma.forumThread.delete).toHaveBeenCalledWith({
      where: { id: 9 },
    });
    expect(prisma.like.deleteMany).toHaveBeenCalledWith({
      where: { likeableType: 'forum_post', likeableId: { in: [40, 41] } },
    });
    expect(prisma.contentReport.deleteMany).toHaveBeenCalledWith({
      where: { targetType: 'forum_post', targetId: { in: [40, 41] } },
    });
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { link: '/communities/3/forum/threads/9' },
          { link: { startsWith: '/communities/3/forum/threads/9?' } },
        ],
      },
    });
  });

  it('updates the reply count and last activity when a reply is deleted', async () => {
    const { prisma, service } = setup();
    const latest = new Date('2026-10-29T00:00:00Z');
    prisma.forumPost.findFirst
      .mockResolvedValueOnce({ authorId: 7, threadId: 9, opening: false })
      .mockResolvedValueOnce({ createdAt: latest });

    await service.removePost(7, 3, 41);

    expect(prisma.forumPost.delete).toHaveBeenCalledWith({ where: { id: 41 } });
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: { link: '/communities/3/forum/threads/9?post=41' },
    });
    expect(prisma.forumThread.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { replyCount: { decrement: 1 }, lastPostAt: latest },
    });
  });

  it('lets admins delete other people’s replies, but not members', async () => {
    const { prisma, service } = setup();
    prisma.forumPost.findFirst.mockResolvedValue({
      authorId: 2,
      threadId: 9,
      opening: false,
    });

    await expect(service.removePost(7, 3, 41)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.forumPost.delete).not.toHaveBeenCalled();
  });
});

describe('Forum search', () => {
  it('ignores queries shorter than 2 characters without searching', async () => {
    const { prisma, service } = setup();

    expect(await service.search(7, 3, ' a ')).toEqual([]);
    expect(prisma.forumThread.findMany).not.toHaveBeenCalled();
  });

  it('matches titles or visible posts, with the same visibility as the thread list', async () => {
    const { prisma, service } = setup();

    await service.search(7, 3, 'arc');

    expect(prisma.forumThread.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          communityId: 3,
          posts: { some: expect.objectContaining({ opening: true }) },
          OR: [
            { title: { contains: 'arc', mode: 'insensitive' } },
            {
              posts: {
                some: expect.objectContaining({
                  OR: [
                    { content: { contains: 'arc', mode: 'insensitive' } },
                    { spoiler: { contains: 'arc', mode: 'insensitive' } },
                  ],
                }),
              },
            },
          ],
        }),
        take: 8,
      }),
    );
  });
});

describe('Hashtags in forum posts', () => {
  const usage = (hashtagId: number, forumPostId: number, createdAt: Date) => ({
    hashtagId,
    forumPostId,
    authorId: 7,
    createdAt,
  });

  it('links tags in a new thread, saves them for the opening post, and shares them with its feed post', async () => {
    const { prisma, posts, service } = setup();
    prisma.forumCategory.findFirst.mockResolvedValue({ postToFeed: true });
    prisma.forumThread.create.mockResolvedValue(createdThread);

    await service.createThread(7, 3, 5, {
      title: 'Episode 1',
      content: '<p>#Frieren</p>',
    });

    const linked =
      '<p><a href="/tags/frieren" class="hashtag">#Frieren</a></p>';
    const [{ data }] = prisma.forumThread.create.mock.calls[0];
    expect(data.posts.create.content).toBe(linked);
    expect(prisma.hashtagUsage.createMany).toHaveBeenCalledWith({
      data: [usage(7, 30, createdThread.posts[0].createdAt)],
      skipDuplicates: true,
    });
    expect(posts.shareThread).toHaveBeenCalledWith(
      expect.objectContaining({ content: linked }),
      [{ name: 'frieren', display: 'Frieren' }],
    );
  });

  it('saves the tags of a reply', async () => {
    const { prisma, service } = setup();
    prisma.forumThread.findFirst.mockResolvedValue({
      ...thread(9),
      authorId: 7,
      category: { id: 5, name: 'General' },
    });
    prisma.forumPost.create.mockResolvedValue({ id: 41 });

    await service.reply(7, 3, 9, { content: '<p>#Fern too</p>' });

    const [{ data }] = prisma.forumPost.create.mock.calls[0];
    expect(data.content).toBe(
      '<p><a href="/tags/fern" class="hashtag">#Fern</a> too</p>',
    );
    expect(prisma.hashtagUsage.createMany).toHaveBeenCalledWith({
      data: [usage(4, 41, data.createdAt)],
      skipDuplicates: true,
    });
  });

  it('re-reads the tags on edit, replaces them, and passes them on to the feed post', async () => {
    const { prisma, posts, service } = setup();
    const createdAt = new Date('2026-11-01T00:00:00Z');
    prisma.forumPost.findFirst.mockResolvedValue({
      authorId: 7,
      content: '<p><a href="/tags/old" class="hashtag">#Old</a></p>',
      threadId: 9,
      opening: true,
    });
    prisma.forumPost.update.mockImplementation(({ data }) => ({
      id: 40,
      opening: true,
      createdAt,
      author,
      ...data,
    }));

    await service.updatePost(7, 3, 40, {
      content: '<p><a href="/tags/old" class="hashtag">#Old</a> #Himmel</p>',
    });

    expect(prisma.hashtagUsage.deleteMany).toHaveBeenCalledWith({
      where: { forumPostId: 40 },
    });
    expect(prisma.hashtagUsage.createMany).toHaveBeenCalledWith({
      data: [usage(3, 40, createdAt), usage(6, 40, createdAt)],
    });
    expect(posts.threadChanged).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        content:
          '<p><a href="/tags/old" class="hashtag">#Old</a> ' +
          '<a href="/tags/himmel" class="hashtag">#Himmel</a></p>',
      }),
      [
        { name: 'old', display: 'Old' },
        { name: 'himmel', display: 'Himmel' },
      ],
    );
  });

  it('loads tagged forum posts as thread pages show them, with their thread', async () => {
    const { prisma, service } = setup();
    const community = { id: 3, name: 'Seasonal Anime Club', iconUrl: null };
    prisma.forumPost.findMany.mockResolvedValue([
      {
        id: 40,
        threadId: 9,
        opening: false,
        content: '<p>#Frieren</p>',
        linkUrl: null,
        spoiler: null,
        quoteId: null,
        likeCount: 0,
        hiddenAt: null,
        editedAt: null,
        createdAt: new Date(),
        author,
        communityId: 3,
        thread: { id: 9, title: 'Episode 1', categoryId: 5, community },
      },
    ]);

    const [found] = await service.findForTags(2, [40]);

    expect(found.thread).toEqual({
      id: 9,
      title: 'Episode 1',
      categoryId: 5,
      community,
    });
    expect(found.forumPost).toMatchObject({
      id: 40,
      liked: false,
      quote: null,
      canEdit: true,
      canDelete: true,
    });
    expect(found.forumPost).not.toHaveProperty('thread');
    expect(found.forumPost).not.toHaveProperty('communityId');
  });
});
