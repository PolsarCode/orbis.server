import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CommentsService } from './comments.service';
import { PrismaService } from '../prisma.service';
import { LikesService } from '../likes/likes.service';
import { NotificationsService } from '../notifications/notifications.service';
import { requireViewAccess } from '../communities/require-membership';
import { GUEST_USER_ID } from '../auth/allow-guest';
import { editHistorySelect } from '../common/edit-history';
import { unblockedFor, visibleTo } from '../moderation/visibility';
import {
  viewableActivity,
  viewablePost,
  viewablePosts,
} from '../posts/posts.service';
import { viewableProfiles } from '../posts/wall-access';

jest.mock('../posts/wall-access', () => ({
  ...jest.requireActual('../posts/wall-access'),
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
  ...jest.requireActual('../communities/require-membership'),
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
    block: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    mute: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    keywordFilter: { findMany: jest.fn().mockResolvedValue([]) },
    comment: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      delete: jest.fn(),
    },
    like: { deleteMany: jest.fn() },
    post: { updateMany: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    libraryActivity: {
      updateMany: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    user: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
    contentReport: { findMany: jest.fn().mockResolvedValue([]) },
    membership: { findMany: jest.fn() },
    hashtag: {
      upsert: jest.fn(({ where }: { where: { name: string } }) =>
        Promise.resolve({ id: where.name.length }),
      ),
    },
    hashtagUsage: { createMany: jest.fn(), deleteMany: jest.fn() },
    editVersion: { deleteMany: jest.fn(), create: jest.fn() },
    $transaction: jest.fn((operations: unknown): unknown =>
      typeof operations === 'function'
        ? (operations as (tx: typeof prisma) => unknown)(prisma)
        : Promise.all(operations as unknown[]),
    ),
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

  let written: Record<string, unknown>;
  const returnsEdited = (row: (args: { data: object }) => object) =>
    prisma.comment.findUniqueOrThrow.mockImplementation(() =>
      row({ data: written }),
    );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.membership.findMany.mockResolvedValue([]);
    prisma.post.findFirst.mockResolvedValue({ id: 7 });
    prisma.libraryActivity.findFirst.mockResolvedValue({ id: 8 });
    written = {};
    prisma.comment.updateMany.mockImplementation(({ data }) => {
      written = data;
      return { count: 1 };
    });
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

  it('leaves a placeholder without its edit history when the comment has replies', async () => {
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
    expect(prisma.editVersion.deleteMany).toHaveBeenCalledWith({
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
    returnsEdited(({ data }) => ({
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
    returnsEdited(({ data }) => ({
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
    returnsEdited(({ data }) => ({
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

  describe('Edit history', () => {
    const posted = new Date('2026-11-05T09:00:00Z');
    const firstEdit = new Date('2026-11-05T09:05:00Z');
    const secondEdit = new Date('2026-11-05T10:00:00Z');
    const viewer = (id: number) => ({
      id,
      reported: { post: [], comment: [], forum_post: [] },
      siteAdmin: false,
      manages: [],
    });
    const editable = (overrides: Record<string, unknown> = {}) =>
      comment({
        linkUrl: null,
        spoiler: null,
        createdAt: posted,
        editedAt: null,
        ...overrides,
      });
    const edited = ({ data }: { data: object }) => ({
      id: 11,
      parentId: null,
      likeCount: 0,
      hiddenAt: null,
      deletedAt: null,
      createdAt: posted,
      author,
      ...data,
    });
    const versions = [
      {
        content: '<p>second</p>',
        linkUrl: null,
        spoiler: null,
        createdAt: firstEdit,
      },
      {
        content: '<p>first</p>',
        linkUrl: null,
        spoiler: null,
        createdAt: posted,
      },
    ];
    const notFound = new NotFoundException('Comment not found');

    beforeEach(() => {
      prisma.comment.findUnique.mockResolvedValue({
        commentableType: 'post',
        commentableId: 7,
      });
      jest.useFakeTimers({
        now: secondEdit,
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
    });
    afterEach(() => jest.useRealTimers());

    it('saves the previous version with the edit, dated by its last edit', async () => {
      prisma.comment.findUnique.mockResolvedValue(
        editable({ content: '<p>second</p>', editedAt: firstEdit }),
      );
      returnsEdited(edited);

      await service.update(1, 11, { content: '<p>third</p>' });

      expect(prisma.comment.updateMany).toHaveBeenCalledWith({
        where: { id: 11, editedAt: firstEdit, deletedAt: null },
        data: {
          content: '<p>third</p>',
          linkUrl: null,
          spoiler: null,
          editedAt: secondEdit,
        },
      });
      expect(prisma.editVersion.create).toHaveBeenCalledWith({
        data: {
          commentId: 11,
          content: '<p>second</p>',
          linkUrl: null,
          spoiler: null,
          createdAt: firstEdit,
        },
      });
    });

    it('refuses an edit when the comment was edited or deleted after it was read, saving nothing', async () => {
      prisma.comment.findUnique.mockResolvedValue(editable());
      prisma.comment.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.update(1, 11, { content: '<p>second</p>' }),
      ).rejects.toThrow(
        new ConflictException(
          'This was edited somewhere else. Reload and try again',
        ),
      );
      expect(prisma.editVersion.create).not.toHaveBeenCalled();
      expect(prisma.hashtagUsage.deleteMany).not.toHaveBeenCalled();
    });

    it('neither marks it edited nor saves a version when the body is the same', async () => {
      prisma.comment.findUnique.mockResolvedValue(
        editable({ spoiler: 'Finale' }),
      );
      returnsEdited(edited);

      await expect(
        service.update(1, 11, { content: '<p>first</p>', spoiler: ' Finale ' }),
      ).resolves.toMatchObject({ id: 11, content: '<p>first</p>' });

      expect(prisma.comment.updateMany.mock.calls[0][0].data).toEqual({
        content: '<p>first</p>',
        linkUrl: null,
        spoiler: 'Finale',
      });
      expect(prisma.editVersion.create).not.toHaveBeenCalled();
    });

    it('lists every version newest first, starting with the current one', async () => {
      prisma.comment.findFirst.mockResolvedValue({
        content: '<p>third</p>',
        linkUrl: 'https://frieren.example',
        spoiler: null,
        createdAt: posted,
        editedAt: secondEdit,
        editVersions: versions,
      });

      await expect(service.findEdits(1, 11)).resolves.toEqual([
        {
          content: '<p>third</p>',
          linkUrl: 'https://frieren.example',
          spoiler: null,
          createdAt: secondEdit,
        },
        ...versions,
      ]);
      expect(prisma.comment.findFirst).toHaveBeenCalledWith({
        where: { id: 11, deletedAt: null, ...visibleTo(viewer(1), 'comment') },
        select: editHistorySelect,
      });
    });

    it('answers 404 for a deleted or hidden comment, or one from someone blocked', async () => {
      prisma.comment.findFirst.mockResolvedValue(null);

      await expect(service.findEdits(1, 11)).rejects.toThrow(notFound);
      const { where } = prisma.comment.findFirst.mock.calls[0][0];
      expect(where.deletedAt).toBeNull();
      expect(where.AND).toEqual(
        expect.arrayContaining([
          { OR: [{ hiddenAt: null }, { authorId: 1 }] },
          unblockedFor(viewer(1)),
        ]),
      );
    });

    it('answers 404 when the viewer can’t see where the comment was left, like a private community', async () => {
      jest
        .mocked(requireViewAccess)
        .mockRejectedValueOnce(
          new ForbiddenException('You are not a member of this community'),
        );

      await expect(service.findEdits(1, 11)).rejects.toThrow(notFound);
      expect(requireViewAccess).toHaveBeenCalledWith(prisma, 1, 3);
      expect(prisma.comment.findFirst).not.toHaveBeenCalled();
    });

    it('answers 404 across a block with the post’s author', async () => {
      prisma.block.count.mockResolvedValueOnce(1);

      await expect(service.findEdits(1, 11)).rejects.toThrow(notFound);
      expect(prisma.comment.findFirst).not.toHaveBeenCalled();
    });

    it('answers 404 for a missing comment or an id out of range', async () => {
      prisma.comment.findUnique.mockResolvedValue(null);

      await expect(service.findEdits(1, 12)).rejects.toThrow(notFound);
      await expect(service.findEdits(1, 2 ** 31)).rejects.toThrow(notFound);
      expect(prisma.comment.findUnique).toHaveBeenCalledTimes(1);
    });

    it('answers 404 when the post it was left on can’t be opened: hidden, by a suspended author, reported or 18+', async () => {
      prisma.post.findFirst.mockResolvedValue(null);
      prisma.comment.findFirst.mockResolvedValue({
        content: '<p>first</p>',
        linkUrl: null,
        spoiler: null,
        createdAt: posted,
        editedAt: null,
        editVersions: [],
      });

      await expect(service.findEdits(1, 11)).rejects.toThrow(notFound);
      expect(prisma.post.findFirst).toHaveBeenCalledWith({
        where: { id: 7, ...viewablePost(viewer(1), false) },
        select: { id: true },
      });
      expect(viewablePost(viewer(1), false).AND).toEqual(
        expect.arrayContaining([viewablePosts(viewer(1)), { isAdult: false }]),
      );
      expect(viewablePosts(viewer(1)).AND).toContainEqual(
        visibleTo(viewer(1), 'post'),
      );
    });

    it('answers 404 when the library update it was left on can’t be opened, like one on a private profile', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        commentableType: 'activity',
        commentableId: 8,
      });
      prisma.libraryActivity.findFirst.mockResolvedValue(null);
      prisma.comment.findFirst.mockResolvedValue({
        content: '<p>first</p>',
        linkUrl: null,
        spoiler: null,
        createdAt: posted,
        editedAt: null,
        editVersions: [],
      });

      await expect(service.findEdits(1, 11)).rejects.toThrow(notFound);
      expect(prisma.libraryActivity.findFirst).toHaveBeenCalledWith({
        where: { id: 8, ...viewableActivity(viewer(1), false) },
        select: { id: true },
      });
      expect(viewableActivity(viewer(1), false).entry).toMatchObject({
        isAdult: false,
        user: { AND: expect.arrayContaining([viewableProfiles(1)]) },
      });
      expect(prisma.post.findFirst).not.toHaveBeenCalled();
    });

    it('lets guests read the history of comments in public places', async () => {
      prisma.comment.findFirst.mockResolvedValue({
        content: '<p>first</p>',
        linkUrl: null,
        spoiler: null,
        createdAt: posted,
        editedAt: null,
        editVersions: [],
      });

      await expect(service.findEdits(GUEST_USER_ID, 11)).resolves.toEqual([
        {
          content: '<p>first</p>',
          linkUrl: null,
          spoiler: null,
          createdAt: posted,
        },
      ]);
      expect(requireViewAccess).toHaveBeenCalledWith(prisma, GUEST_USER_ID, 3);
    });
  });
});
