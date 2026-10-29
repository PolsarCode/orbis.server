import { ForbiddenException, NotFoundException } from '@nestjs/common';
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
  requireProfileView: jest.fn(),
  requireTargetAccess: jest.fn(),
}));
jest.mock('../communities/require-membership', () => ({
  requireViewAccess: jest.fn(),
}));
jest.mock('../common/rich-text', () => ({
  sanitizeRichText: (html: string) => ({
    html,
    empty: !html.replace(/<[^>]+>/g, '').trim(),
  }),
}));

const author = { id: 1, username: 'reader', name: null, avatarUrl: null };

describe('Editing and deleting comments', () => {
  const prisma = {
    comment: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    like: { deleteMany: jest.fn() },
    post: { updateMany: jest.fn() },
    libraryActivity: { updateMany: jest.fn() },
    user: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
    contentReport: { findMany: jest.fn().mockResolvedValue([]) },
    membership: { findMany: jest.fn() },
    $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
  };
  const likes = { likedBy: jest.fn().mockResolvedValue(new Set()) };
  const service = new CommentsService(
    prisma as unknown as PrismaService,
    likes as unknown as LikesService,
    { notify: jest.fn() } as unknown as NotificationsService,
  );

  const comment = (overrides: Record<string, unknown> = {}) => ({
    authorId: 1,
    communityId: 3,
    commentableType: 'post',
    commentableId: 7,
    parentId: null,
    deletedAt: null,
    content: '<p>first</p>',
    _count: { replies: 0 },
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.membership.findMany.mockResolvedValue([]);
  });

  it('removes a comment with no replies, its likes, and lowers the count', async () => {
    prisma.comment.findUnique.mockResolvedValue(comment());

    await service.remove(1, 11);

    expect(prisma.comment.delete).toHaveBeenCalledWith({ where: { id: 11 } });
    expect(prisma.like.deleteMany).toHaveBeenCalledWith({
      where: { likeableType: 'comment', likeableId: 11 },
    });
    expect(prisma.post.updateMany).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { commentCount: { decrement: 1 } },
    });
  });

  it('leaves a placeholder when the comment has replies', async () => {
    prisma.comment.findUnique.mockResolvedValue(
      comment({ _count: { replies: 2 } }),
    );

    await service.remove(1, 11);

    expect(prisma.comment.delete).not.toHaveBeenCalled();
    expect(prisma.comment.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { deletedAt: expect.any(Date), content: '', linkUrl: null },
    });
  });

  it('clears away a placeholder once its last reply is deleted', async () => {
    prisma.comment.findUnique
      .mockResolvedValueOnce(comment({ parentId: 10 }))
      .mockResolvedValueOnce({
        parentId: null,
        deletedAt: new Date(),
        _count: { replies: 0 },
      });

    await service.remove(1, 11);

    expect(prisma.comment.delete).toHaveBeenCalledWith({ where: { id: 11 } });
    expect(prisma.comment.delete).toHaveBeenCalledWith({ where: { id: 10 } });
    expect(prisma.post.updateMany).toHaveBeenCalledTimes(1);
  });

  it('lets community admins delete comments but not other members', async () => {
    prisma.comment.findUnique.mockResolvedValue(comment());
    prisma.membership.findMany.mockResolvedValueOnce([
      { communityId: 3, community: { ownerId: 9 }, roles: [] },
    ]);

    await service.remove(9, 11);
    expect(prisma.comment.delete).toHaveBeenCalled();

    jest.clearAllMocks();
    prisma.comment.findUnique.mockResolvedValue(comment());
    prisma.membership.findMany.mockResolvedValue([
      { communityId: 3, community: { ownerId: 2 }, roles: [] },
    ]);

    await expect(service.remove(8, 11)).rejects.toThrow(ForbiddenException);
  });

  it('shows deleted comments as empty placeholders that can’t be deleted again', async () => {
    prisma.comment.findMany.mockResolvedValue([
      {
        id: 11,
        parentId: null,
        content: '',
        linkUrl: null,
        likeCount: 1,
        hiddenAt: null,
        editedAt: null,
        deletedAt: new Date(),
        createdAt: new Date(),
        author,
      },
    ]);

    const [listed] = await service.list(1, 'post', 7);

    expect(listed).toMatchObject({
      deleted: true,
      canDelete: false,
      content: '',
    });
  });

  it('lets only the author edit, and marks it edited', async () => {
    prisma.comment.findUnique.mockResolvedValue(comment());
    prisma.comment.update.mockImplementation(({ data }) => ({
      id: 11,
      parentId: null,
      likeCount: 1,
      hiddenAt: null,
      deletedAt: null,
      createdAt: new Date(),
      author,
      ...data,
    }));

    const updated = await service.update(1, 11, { content: '<p>second</p>' });
    expect(updated).toMatchObject({
      content: '<p>second</p>',
      editedAt: expect.any(Date),
      canDelete: true,
    });

    await expect(
      service.update(2, 11, { content: '<p>not yours</p>' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('won’t edit a deleted comment', async () => {
    prisma.comment.findUnique.mockResolvedValue(
      comment({ deletedAt: new Date() }),
    );

    await expect(
      service.update(1, 11, { content: '<p>back</p>' }),
    ).rejects.toThrow(NotFoundException);
  });
});
