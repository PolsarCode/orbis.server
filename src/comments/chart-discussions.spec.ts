import { NotFoundException } from '@nestjs/common';
import { CommentsService } from './comments.service';
import { PrismaService } from '../prisma.service';
import { LikesService } from '../likes/likes.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GUEST_USER_ID } from '../auth/allow-guest';

jest.mock('../common/rich-text', () => ({
  sanitizeRichText: (html: string) => ({ html, empty: false }),
}));

const person = (id: number) => ({
  id,
  username: `user${id}`,
  name: null,
  avatarUrl: null,
});

const comment = (id: number, authorId: number, extra: object = {}) => ({
  id,
  parentId: null,
  content: '<p>Frieren on top again</p>',
  linkUrl: null,
  spoiler: null,
  likeCount: 0,
  hiddenAt: null,
  editedAt: null,
  deletedAt: null,
  createdAt: new Date('2026-11-10T00:00:00Z'),
  author: person(authorId),
  ...extra,
});

const chartLink = '/library?tab=charts&week=2026-W46#discussion';

describe('Chart discussions', () => {
  const prisma = {
    chartDiscussion: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    comment: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    like: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    post: { findMany: jest.fn() },
    libraryActivity: { findMany: jest.fn() },
    block: { findMany: jest.fn(), count: jest.fn() },
    mute: { findMany: jest.fn() },
    keywordFilter: { findMany: jest.fn() },
    contentReport: { findMany: jest.fn() },
    membership: { findMany: jest.fn() },
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    hashtag: { upsert: jest.fn() },
    hashtagUsage: { createMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const notifications = { notify: jest.fn() };
  const likes = new LikesService(prisma as unknown as PrismaService);
  const service = new CommentsService(
    prisma as unknown as PrismaService,
    likes,
    notifications as unknown as NotificationsService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((run) =>
      Array.isArray(run) ? Promise.all(run) : run(prisma),
    );
    prisma.chartDiscussion.findUnique.mockResolvedValue({ id: 5 });
    prisma.chartDiscussion.findUniqueOrThrow.mockResolvedValue({
      mediaType: 'anime',
      week: '2026-W46',
    });
    prisma.chartDiscussion.findMany.mockResolvedValue([]);
    prisma.comment.findMany.mockResolvedValue([]);
    prisma.comment.create.mockImplementation(({ data }) => ({
      ...comment(11, data.authorId),
      parentId: data.parentId ?? null,
      content: data.content,
    }));
    prisma.like.findMany.mockResolvedValue([]);
    prisma.like.findUnique.mockResolvedValue(null);
    prisma.post.findMany.mockResolvedValue([]);
    prisma.libraryActivity.findMany.mockResolvedValue([]);
    prisma.block.findMany.mockResolvedValue([]);
    prisma.block.count.mockResolvedValue(0);
    prisma.mute.findMany.mockResolvedValue([]);
    prisma.keywordFilter.findMany.mockResolvedValue([]);
    prisma.contentReport.findMany.mockResolvedValue([]);
    prisma.membership.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.hashtag.upsert.mockImplementation(({ where }) => ({
      id: where.name.length,
    }));
  });

  it('lets guests read the thread', async () => {
    prisma.comment.findMany.mockResolvedValue([
      comment(11, 2),
      comment(12, 3, { parentId: 11 }),
    ]);

    const comments = await service.list(GUEST_USER_ID, 'chart', 5);

    expect(prisma.chartDiscussion.findUnique).toHaveBeenCalledWith({
      where: { id: 5 },
      select: { id: true },
    });
    expect(prisma.comment.findMany.mock.calls[0][0].where).toMatchObject({
      commentableType: 'chart',
      commentableId: 5,
    });
    expect(
      comments.map(({ id, liked, canDelete }) => [id, liked, canDelete]),
    ).toEqual([
      [11, false, false],
      [12, false, false],
    ]);
  });

  it('reports a thread that doesn’t exist as not found', async () => {
    prisma.chartDiscussion.findUnique.mockResolvedValue(null);

    await expect(service.list(1, 'chart', 99)).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      service.create(1, { type: 'chart', id: 99, content: '<p>Hi</p>' }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.comment.create).not.toHaveBeenCalled();
  });

  it('lets anyone signed in comment, counting it on the thread and notifying no owner', async () => {
    const created = await service.create(1, {
      type: 'chart',
      id: 5,
      content: '<p>Frieren on top again</p>',
    });

    expect(prisma.comment.create.mock.calls[0][0].data).toMatchObject({
      communityId: null,
      commentableType: 'chart',
      commentableId: 5,
      authorId: 1,
    });
    expect(prisma.chartDiscussion.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { commentCount: { increment: 1 } },
    });
    expect(prisma.block.count).not.toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith([]);
    expect(created).toMatchObject({ id: 11, canDelete: true, liked: false });
  });

  it('sends replies and mentions to the chart’s discussion', async () => {
    prisma.comment.findUnique.mockResolvedValue({
      commentableType: 'chart',
      commentableId: 5,
      authorId: 2,
    });
    prisma.user.findMany.mockResolvedValue([{ id: 3, username: 'user3' }]);

    await service.create(1, {
      type: 'chart',
      id: 5,
      parentId: 10,
      content: '<p>Agreed, @user3</p>',
    });

    expect(prisma.chartDiscussion.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 5 },
      select: { mediaType: true, week: true },
    });
    expect(notifications.notify).toHaveBeenNthCalledWith(1, [
      {
        userId: 2,
        actorId: 1,
        type: 'comment_reply',
        message: 'replied to your comment',
        link: chartLink,
      },
    ]);
    expect(notifications.notify).toHaveBeenNthCalledWith(2, [
      {
        userId: 3,
        actorId: 1,
        type: 'mention',
        message: 'mentioned you in a comment',
        link: chartLink,
      },
    ]);
  });

  it('won’t take a reply to a comment from another thread', async () => {
    prisma.comment.findUnique.mockResolvedValue({
      commentableType: 'post',
      commentableId: 5,
      authorId: 2,
    });

    await expect(
      service.create(1, {
        type: 'chart',
        id: 5,
        parentId: 10,
        content: '<p>Hi</p>',
      }),
    ).rejects.toThrow('Invalid parent comment');
  });

  it('takes a deleted comment off the thread’s count', async () => {
    prisma.comment.findUnique.mockResolvedValueOnce({
      authorId: 1,
      communityId: null,
      commentableType: 'chart',
      commentableId: 5,
      parentId: null,
      deletedAt: null,
      _count: { replies: 0 },
    });

    await service.remove(1, 11);

    expect(prisma.comment.delete).toHaveBeenCalledWith({ where: { id: 11 } });
    expect(prisma.chartDiscussion.updateMany).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { commentCount: { decrement: 1 } },
    });
  });

  it('lets people like a comment in the thread', async () => {
    prisma.comment.findFirst.mockResolvedValue({
      commentableType: 'chart',
      commentableId: 5,
    });
    prisma.comment.update.mockResolvedValue({ likeCount: 1 });

    const result = await likes.setLike(1, {
      type: 'comment',
      id: 11,
      liked: true,
    });

    expect(result).toEqual({ likeCount: 1, liked: true });
    expect(prisma.chartDiscussion.findUnique).toHaveBeenCalledWith({
      where: { id: 5 },
      select: { id: true },
    });
    expect(prisma.block.count).not.toHaveBeenCalled();
    expect(prisma.like.create).toHaveBeenCalledWith({
      data: { userId: 1, likeableType: 'comment', likeableId: 11 },
    });
    expect(prisma.comment.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { likeCount: { increment: 1 } },
      select: { likeCount: true },
    });
  });

  it('shows chart comments on tag pages, pointing at the chart', async () => {
    prisma.comment.findMany.mockResolvedValue([
      {
        ...comment(11, 2),
        communityId: null,
        commentableType: 'chart',
        commentableId: 5,
      },
    ]);
    prisma.chartDiscussion.findMany.mockResolvedValue([
      { id: 5, mediaType: 'manga', week: '2026-W46' },
    ]);

    const items = await service.findForTags(1, [11]);

    expect(prisma.chartDiscussion.findMany).toHaveBeenCalledWith({
      where: { id: { in: [5] } },
      select: { id: true, mediaType: true, week: true },
    });
    expect(items).toEqual([
      {
        comment: expect.objectContaining({ id: 11 }),
        target: {
          type: 'chart',
          id: 5,
          author: null,
          community: null,
          media: null,
          wallUser: null,
          chart: { type: 'manga', week: '2026-W46' },
        },
      },
    ]);
  });
});
