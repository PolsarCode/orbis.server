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
    block: { count: jest.fn().mockResolvedValue(0) },
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
                    deleteAt: null,
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
            { id: { notIn: [12] } },
          ],
        },
      }),
    );
    expect(requireTargetAccess).not.toHaveBeenCalled();
    expect(prisma.like.create).not.toHaveBeenCalled();
    expect(prisma.comment.update).not.toHaveBeenCalled();
  });

  it('won’t like a post across a block, either way', async () => {
    prisma.block.count.mockResolvedValueOnce(1);

    await expect(
      service.setLike(1, { type: 'post', id: 7, liked: true }),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.block.count).toHaveBeenCalledWith({
      where: {
        OR: [
          { blockerId: 1, blockedId: 2 },
          { blockerId: 2, blockedId: 1 },
        ],
      },
    });
    expect(requireTargetAccess).not.toHaveBeenCalled();
    expect(prisma.like.create).not.toHaveBeenCalled();
    expect(prisma.post.update).not.toHaveBeenCalled();
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

describe('Liking forum posts', () => {
  const prisma = {
    forumPost: { findFirst: jest.fn(), update: jest.fn() },
    membership: { findUnique: jest.fn() },
    contentReport: { findMany: jest.fn() },
    like: { findUnique: jest.fn(), create: jest.fn(), delete: jest.fn() },
    $transaction: jest.fn((run) => run(prisma)),
  };
  const service = new LikesService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.contentReport.findMany.mockResolvedValue([]);
    prisma.forumPost.findFirst.mockResolvedValue({ communityId: 3 });
    prisma.membership.findUnique.mockResolvedValue({ userId: 1 });
    prisma.like.findUnique.mockResolvedValue(null);
    prisma.forumPost.update.mockResolvedValue({ likeCount: 4 });
  });

  it('likes a forum post the member can see and counts it', async () => {
    const result = await service.setLike(1, {
      type: 'forum_post',
      id: 40,
      liked: true,
    });

    expect(result).toEqual({ likeCount: 4, liked: true });
    expect(prisma.forumPost.update).toHaveBeenCalledWith({
      where: { id: 40 },
      data: { likeCount: { increment: 1 } },
      select: { likeCount: true },
    });
    expect(targetOf).not.toHaveBeenCalled();
  });

  it('refuses people who aren’t members of the community', async () => {
    prisma.membership.findUnique.mockResolvedValue(null);

    await expect(
      service.setLike(1, { type: 'forum_post', id: 40, liked: true }),
    ).rejects.toThrow('You are not a member of this community');
    expect(prisma.like.create).not.toHaveBeenCalled();
  });

  it('treats forum posts the person can’t see as missing', async () => {
    prisma.forumPost.findFirst.mockResolvedValue(null);

    await expect(
      service.setLike(1, { type: 'forum_post', id: 40, liked: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Removing a deleted account’s likes', () => {
  const prisma = {
    like: { findMany: jest.fn(), deleteMany: jest.fn() },
    post: { updateMany: jest.fn() },
    libraryActivity: { updateMany: jest.fn() },
    comment: { updateMany: jest.fn() },
    forumPost: { updateMany: jest.fn() },
    $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
  };
  const service = new LikesService(prisma as unknown as PrismaService);

  it('takes each like off the count it added to, then removes the likes', async () => {
    prisma.like.findMany.mockResolvedValue([
      { likeableType: 'post', likeableId: 3 },
      { likeableType: 'post', likeableId: 4 },
      { likeableType: 'comment', likeableId: 9 },
      { likeableType: 'forum_post', likeableId: 12 },
    ]);

    await service.removeAllBy(7);

    const fewer = (ids: number[]) => ({
      where: { id: { in: ids } },
      data: { likeCount: { decrement: 1 } },
    });
    expect(prisma.like.findMany).toHaveBeenCalledWith({
      where: { userId: 7 },
      select: { likeableType: true, likeableId: true },
    });
    expect(prisma.post.updateMany).toHaveBeenCalledWith(fewer([3, 4]));
    expect(prisma.libraryActivity.updateMany).toHaveBeenCalledWith(fewer([]));
    expect(prisma.comment.updateMany).toHaveBeenCalledWith(fewer([9]));
    expect(prisma.forumPost.updateMany).toHaveBeenCalledWith(fewer([12]));
    expect(prisma.like.deleteMany).toHaveBeenCalledWith({
      where: { userId: 7 },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
