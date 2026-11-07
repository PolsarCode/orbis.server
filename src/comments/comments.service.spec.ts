import { BadRequestException } from '@nestjs/common';
import { CommentsService } from './comments.service';
import { PrismaService } from '../prisma.service';
import { LikesService } from '../likes/likes.service';
import { NotificationsService } from '../notifications/notifications.service';

jest.mock('../posts/wall-access', () => ({
  targetOf: jest.fn(async () => ({
    type: 'post',
    id: 7,
    communityId: 3,
    ownerId: 2,
    wallUserId: null,
  })),
  requireTargetAccess: jest.fn(async () => undefined),
}));
jest.mock('../common/rich-text', () => ({ sanitizeRichText: jest.fn() }));

describe('CommentsService.create', () => {
  const comment = jest.fn(({ data }) => ({
    id: 11,
    likeCount: 0,
    ...data,
    createdAt: new Date(),
    author: { id: 1, username: 'reader', name: null, avatarUrl: null },
  }));
  const likeCreate = jest.fn();
  const prisma = {
    comment: {
      create: comment,
      findUnique: jest.fn(),
    },
    like: { create: likeCreate },
    post: { update: jest.fn() },
    user: { findUnique: jest.fn() },
    block: { count: jest.fn().mockResolvedValue(0) },
    membership: { findMany: jest.fn().mockResolvedValue([]) },
    hashtag: {
      upsert: jest.fn(({ where }: { where: { name: string } }) =>
        Promise.resolve({ id: where.name.length }),
      ),
    },
    hashtagUsage: { createMany: jest.fn() },
    $transaction: jest.fn((run) => run(prisma)),
  };
  const notifications = { notify: jest.fn() };
  const service = new CommentsService(
    prisma as unknown as PrismaService,
    {} as LikesService,
    notifications as unknown as NotificationsService,
  );
  const sanitize = jest.requireMock('../common/rich-text')
    .sanitizeRichText as jest.Mock;

  beforeEach(() => jest.clearAllMocks());

  it('starts the comment with no likes, not even the author’s', async () => {
    sanitize.mockReturnValue({ html: '<p>Nice</p>', empty: false });

    const created = await service.create(1, {
      type: 'post',
      id: 7,
      content: '<p>Nice</p>',
    });

    expect(comment.mock.calls[0][0].data).not.toHaveProperty('likeCount');
    expect(likeCreate).not.toHaveBeenCalled();
    expect(prisma.post.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { commentCount: { increment: 1 } },
    });
    expect(created).toMatchObject({ likeCount: 0, liked: false });
  });

  it('saves the link with the comment', async () => {
    sanitize.mockReturnValue({ html: '<p>Look</p>', empty: false });

    await service.create(1, {
      type: 'post',
      id: 7,
      content: '<p>Look</p>',
      linkUrl: 'https://youtu.be/dQw4w9WgXcQ',
    });

    expect(comment.mock.calls[0][0].data).toMatchObject({
      content: '<p>Look</p>',
      linkUrl: 'https://youtu.be/dQw4w9WgXcQ',
    });
  });

  it('allows a comment that is only a link card', async () => {
    sanitize.mockReturnValue({ html: '<p></p>', empty: true });

    await service.create(1, {
      type: 'post',
      id: 7,
      content: '<p></p>',
      linkUrl: 'https://example.com',
    });

    expect(comment.mock.calls[0][0].data).toMatchObject({
      content: '',
      linkUrl: 'https://example.com',
    });
  });

  it('still rejects empty comments without a link', async () => {
    sanitize.mockReturnValue({ html: '<p></p>', empty: true });

    await expect(
      service.create(1, { type: 'post', id: 7, content: '<p></p>' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(comment).not.toHaveBeenCalled();
  });

  it('links hashtags and saves a use for each, pointing at what was commented on', async () => {
    sanitize.mockReturnValue({
      html: '<p>#Frieren and #Fern</p>',
      empty: false,
    });

    const created = await service.create(1, {
      type: 'post',
      id: 7,
      content: '<p>#Frieren and #Fern</p>',
    });

    expect(comment.mock.calls[0][0].data.content).toBe(
      '<p><a href="/tags/frieren" class="hashtag">#Frieren</a> and ' +
        '<a href="/tags/fern" class="hashtag">#Fern</a></p>',
    );
    expect(prisma.hashtagUsage.createMany).toHaveBeenCalledWith({
      data: [7, 4].map((hashtagId) => ({
        hashtagId,
        commentId: 11,
        targetPostId: 7,
        targetActivityId: null,
        authorId: 1,
        createdAt: created.createdAt,
      })),
      skipDuplicates: true,
    });
  });

  it('replies under a deleted account’s placeholder without notifying anyone for it', async () => {
    sanitize.mockReturnValue({
      html: '<p>Still a good point</p>',
      empty: false,
    });
    prisma.comment.findUnique.mockResolvedValue({
      commentableType: 'post',
      commentableId: 7,
      authorId: null,
    });

    await service.create(1, {
      type: 'post',
      id: 7,
      parentId: 5,
      content: '<p>Still a good point</p>',
    });

    const sent = notifications.notify.mock.calls.flatMap(([list]) => list);
    expect(sent.every(({ userId }) => typeof userId === 'number')).toBe(true);
    expect(sent).toEqual([
      expect.objectContaining({ userId: 2, type: 'post_comment' }),
    ]);
  });
});
