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
    post: { updateMany: jest.fn(), findMany: jest.fn() },
    libraryActivity: { updateMany: jest.fn(), findMany: jest.fn() },
    user: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
    contentReport: { findMany: jest.fn().mockResolvedValue([]) },
    membership: { findMany: jest.fn() },
    hashtag: {
      upsert: jest.fn(({ where }: { where: { name: string } }) =>
        Promise.resolve({ id: where.name.length }),
      ),
    },
    hashtagUsage: { createMany: jest.fn(), deleteMany: jest.fn() },
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
      data: {
        deletedAt: expect.any(Date),
        content: '',
        linkUrl: null,
        spoiler: null,
      },
    });
    expect(prisma.hashtagUsage.deleteMany).toHaveBeenCalledWith({
      where: { commentId: 11 },
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

  it('keeps a spoiler without a note as an empty note', async () => {
    prisma.comment.findUnique.mockResolvedValue(comment());
    prisma.comment.update.mockImplementation(({ data }) => ({
      id: 11,
      parentId: null,
      likeCount: 0,
      hiddenAt: null,
      deletedAt: null,
      createdAt: new Date(),
      author,
      ...data,
    }));

    const updated = await service.update(1, 11, {
      content: '<p>the ending</p>',
      spoiler: '',
    });

    expect(updated).toMatchObject({ spoiler: '' });
  });

  it('won’t edit a deleted comment', async () => {
    prisma.comment.findUnique.mockResolvedValue(
      comment({ deletedAt: new Date() }),
    );

    await expect(
      service.update(1, 11, { content: '<p>back</p>' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('re-reads hashtags on edit and replaces the saved uses', async () => {
    const createdAt = new Date('2026-11-05T09:00:00Z');
    prisma.comment.findUnique.mockResolvedValue(
      comment({ commentableType: 'activity', commentableId: 8 }),
    );
    prisma.comment.update.mockImplementation(({ data }) => ({
      id: 11,
      parentId: null,
      likeCount: 0,
      hiddenAt: null,
      deletedAt: null,
      createdAt,
      author,
      ...data,
    }));

    const updated = await service.update(1, 11, {
      content: '<p><a href="/tags/old" class="hashtag">#Old</a> and #Fern</p>',
    });

    expect(updated.content).toBe(
      '<p><a href="/tags/old" class="hashtag">#Old</a> and ' +
        '<a href="/tags/fern" class="hashtag">#Fern</a></p>',
    );
    expect(prisma.hashtagUsage.deleteMany).toHaveBeenCalledWith({
      where: { commentId: 11 },
    });
    expect(prisma.hashtagUsage.createMany).toHaveBeenCalledWith({
      data: [3, 4].map((hashtagId) => ({
        hashtagId,
        commentId: 11,
        targetPostId: null,
        targetActivityId: 8,
        authorId: 1,
        createdAt,
      })),
    });
  });

  it('loads tagged comments with what they were left on', async () => {
    const row = (
      id: number,
      commentableType: string,
      commentableId: number,
    ) => ({
      id,
      parentId: null,
      content: '<p>#Fern</p>',
      linkUrl: null,
      spoiler: null,
      likeCount: 0,
      hiddenAt: null,
      editedAt: null,
      deletedAt: null,
      createdAt: new Date(),
      author,
      communityId: commentableType === 'post' ? 3 : null,
      commentableType,
      commentableId,
    });
    const owner = { id: 2, username: 'frieren', name: null, avatarUrl: null };
    const community = { id: 3, name: 'Seasonal Anime Club', iconUrl: null };
    prisma.comment.findMany.mockResolvedValue([
      row(11, 'post', 7),
      row(12, 'activity', 8),
      row(13, 'post', 99),
    ]);
    prisma.post.findMany.mockResolvedValue([
      {
        id: 7,
        mediaType: 'anime',
        mediaSourceId: '52991',
        author: owner,
        community,
        wallUser: null,
      },
    ]);
    prisma.libraryActivity.findMany.mockResolvedValue([
      { id: 8, entry: { user: owner } },
    ]);

    const found = await service.findForTags(1, [11, 12, 13]);

    expect(found).toEqual([
      {
        comment: expect.objectContaining({
          id: 11,
          liked: false,
          canDelete: true,
        }),
        target: {
          type: 'post',
          id: 7,
          author: { ...owner, nickname: null },
          community,
          media: { type: 'anime', sourceId: '52991' },
          wallUser: null,
        },
      },
      {
        comment: expect.objectContaining({ id: 12 }),
        target: {
          type: 'activity',
          id: 8,
          author: owner,
          community: null,
          media: null,
          wallUser: null,
        },
      },
    ]);
    expect(found[0].comment).not.toHaveProperty('commentableType');
    expect(found[0].comment).not.toHaveProperty('communityId');
  });
});
