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
    membership: { findMany: jest.fn().mockResolvedValue([]) },
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
});
