import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ForumService } from './forum.service';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LikesService } from '../likes/likes.service';
import { isForumManager, isMember } from './forum-helpers';
import { notifyMentions } from '../common/mentions';

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

function setup() {
  const prisma = {
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
    communityBan: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((operations: unknown) =>
    typeof operations === 'function'
      ? (operations as (tx: typeof prisma) => unknown)(prisma)
      : Promise.all(operations as unknown[]),
  );
  const notifications = { notify: jest.fn() };
  const likes = { likedBy: jest.fn().mockResolvedValue(new Set()) };
  const service = new ForumService(
    prisma as unknown as PrismaService,
    notifications as unknown as NotificationsService,
    likes as unknown as LikesService,
  );
  return { prisma, notifications, service };
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
    expect(prisma.membership.findMany).not.toHaveBeenCalled();

    jest.mocked(isForumManager).mockResolvedValue(true);
    const owner = await service.thread(7, 3, 9);
    expect(owner.items.map(({ moderation }) => moderation)).toEqual([
      { remove: true, ban: true },
      null,
    ]);
  });
});

describe('Starting threads', () => {
  it('saves a tidy title with the opening post', async () => {
    const { prisma, service } = setup();
    prisma.forumCategory.findFirst.mockResolvedValue({ id: 5 });
    prisma.forumThread.create.mockResolvedValue({ id: 9 });

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
          },
        },
      },
      select: { id: true },
    });
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
});

describe('Admin-only categories', () => {
  it('only lets admins start threads when the category or its section is admin-only', async () => {
    const { prisma, service } = setup();
    prisma.forumThread.create.mockResolvedValue({ id: 9 });
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
    const { prisma, service } = setup();
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
                  content: { contains: 'arc', mode: 'insensitive' },
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
