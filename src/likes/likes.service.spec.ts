import { NotFoundException } from '@nestjs/common';
import { LikesService } from './likes.service';
import { PrismaService } from '../prisma.service';
import { requireTargetAccess, targetOf } from '../posts/wall-access';

jest.mock('../posts/wall-access', () => ({
  targetOf: jest.fn(),
  requireTargetAccess: jest.fn(),
}));

const target = {
  type: 'post',
  id: 7,
  communityId: 3,
  wallUserId: null,
  mediaType: null,
  mediaSourceId: null,
  ownerId: 2,
};

describe('Liking comments', () => {
  const prisma = {
    comment: { findFirst: jest.fn(), update: jest.fn() },
    contentReport: { findMany: jest.fn() },
    like: { findUnique: jest.fn(), create: jest.fn(), delete: jest.fn() },
    post: { update: jest.fn() },
    libraryActivity: { update: jest.fn() },
    $transaction: jest.fn((run) => run(prisma)),
  };
  const service = new LikesService(prisma as unknown as PrismaService);
  const key = {
    userId_likeableType_likeableId: {
      userId: 1,
      likeableType: 'comment',
      likeableId: 11,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(targetOf).mockResolvedValue(target as never);
    prisma.contentReport.findMany.mockResolvedValue([]);
    prisma.comment.findFirst.mockResolvedValue({
      commentableType: 'post',
      commentableId: 7,
    });
    prisma.like.findUnique.mockResolvedValue(null);
    prisma.comment.update.mockResolvedValue({ likeCount: 3 });
  });

  it('likes a comment and counts it, checking access to its post', async () => {
    const result = await service.setLike(1, {
      type: 'comment',
      id: 11,
      liked: true,
    });

    expect(result).toEqual({ likeCount: 3, liked: true });
    expect(targetOf).toHaveBeenCalledWith(prisma, 1, 'post', 7);
    expect(requireTargetAccess).toHaveBeenCalledWith(prisma, 1, target);
    expect(prisma.like.create).toHaveBeenCalledWith({
      data: { userId: 1, likeableType: 'comment', likeableId: 11 },
    });
    expect(prisma.comment.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { likeCount: { increment: 1 } },
      select: { likeCount: true },
    });
  });

  it('takes a like back off a comment', async () => {
    prisma.like.findUnique.mockResolvedValue(
      key.userId_likeableType_likeableId,
    );
    prisma.comment.update.mockResolvedValue({ likeCount: 2 });

    const result = await service.setLike(1, {
      type: 'comment',
      id: 11,
      liked: false,
    });

    expect(result).toEqual({ likeCount: 2, liked: false });
    expect(prisma.like.delete).toHaveBeenCalledWith({ where: key });
    expect(prisma.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { likeCount: { increment: -1 } } }),
    );
  });

  it('won’t like a deleted, hidden, or reported comment', async () => {
    prisma.contentReport.findMany.mockResolvedValue([
      { targetType: 'comment', targetId: 12 },
    ]);
    prisma.comment.findFirst.mockResolvedValue(null);

    await expect(
      service.setLike(1, { type: 'comment', id: 11, liked: true }),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.comment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 11,
          deletedAt: null,
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
            { id: { notIn: [12] } },
          ],
        },
      }),
    );
    expect(requireTargetAccess).not.toHaveBeenCalled();
    expect(prisma.like.create).not.toHaveBeenCalled();
    expect(prisma.comment.update).not.toHaveBeenCalled();
  });

  it('keeps liking posts and library updates directly', async () => {
    prisma.post.update.mockResolvedValue({ likeCount: 5 });
    prisma.libraryActivity.update.mockResolvedValue({ likeCount: 1 });

    await expect(
      service.setLike(1, { type: 'post', id: 7, liked: true }),
    ).resolves.toEqual({ likeCount: 5, liked: true });
    await expect(
      service.setLike(1, { type: 'activity', id: 4, liked: true }),
    ).resolves.toEqual({ likeCount: 1, liked: true });

    expect(targetOf).toHaveBeenCalledWith(prisma, 1, 'post', 7);
    expect(targetOf).toHaveBeenCalledWith(prisma, 1, 'activity', 4);
    expect(prisma.comment.findFirst).not.toHaveBeenCalled();
    expect(prisma.comment.update).not.toHaveBeenCalled();
  });
});
