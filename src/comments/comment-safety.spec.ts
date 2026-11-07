import { NotFoundException } from '@nestjs/common';
import { CommentsService } from './comments.service';
import { PrismaService } from '../prisma.service';
import { LikesService } from '../likes/likes.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  requireProfileView,
  targetOf,
  viewableProfiles,
} from '../posts/wall-access';
import { requireViewAccess } from '../communities/require-membership';
import {
  viewableActivity,
  viewablePost,
  viewablePosts,
} from '../posts/posts.service';
import { visibleThreads } from '../forum/forum-helpers';
import { visibleTo } from '../moderation/visibility';

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
jest.mock('../common/rich-text', () => ({ sanitizeRichText: jest.fn() }));

const person = (id: number) => ({
  id,
  username: `user${id}`,
  name: null,
  avatarUrl: null,
});

const comment = (id: number, authorId: number, extra: object = {}) => ({
  id,
  parentId: null,
  content: '<p>Loved the Frieren finale</p>',
  linkUrl: null,
  spoiler: null,
  likeCount: 0,
  hiddenAt: null,
  editedAt: null,
  deletedAt: null,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  author: person(authorId),
  ...extra,
});

describe('Blocked and muted people in comment threads', () => {
  const prisma = {
    block: { findMany: jest.fn(), count: jest.fn() },
    mute: { findMany: jest.fn() },
    keywordFilter: { findMany: jest.fn() },
    contentReport: { findMany: jest.fn() },
    comment: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
    membership: { findMany: jest.fn() },
    user: { findUnique: jest.fn() },
    post: { findFirst: jest.fn() },
    libraryActivity: { findFirst: jest.fn() },
  };
  const likes = { likedBy: jest.fn() };
  const service = new CommentsService(
    prisma as unknown as PrismaService,
    likes as unknown as LikesService,
    { notify: jest.fn() } as unknown as NotificationsService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.block.findMany.mockResolvedValue([]);
    prisma.block.count.mockResolvedValue(0);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.mute.findMany.mockResolvedValue([]);
    prisma.keywordFilter.findMany.mockResolvedValue([]);
    prisma.contentReport.findMany.mockResolvedValue([]);
    prisma.comment.findMany.mockResolvedValue([]);
    prisma.membership.findMany.mockResolvedValue([]);
    prisma.post.findFirst.mockResolvedValue({ id: 7 });
    prisma.libraryActivity.findFirst.mockResolvedValue({ id: 8 });
    likes.likedBy.mockResolvedValue(new Set());
  });

  it('leaves out comments from people blocked either way', async () => {
    await service.list(1, 'post', 7);

    expect(prisma.comment.findMany.mock.calls[0][0].where.AND).toContainEqual({
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

  it('collapses muted people and filtered phrases, but not the viewer’s own comments', async () => {
    prisma.mute.findMany.mockResolvedValue([{ mutedId: 7 }]);
    prisma.keywordFilter.findMany.mockResolvedValue([{ phrase: 'frieren' }]);
    prisma.comment.findMany.mockResolvedValue([
      comment(1, 7),
      comment(2, 3),
      comment(3, 3, { content: '<p>Episode 12</p>', spoiler: 'Frieren' }),
      comment(4, 3, { content: '<p>Dungeon Meshi</p>' }),
      comment(5, 1),
    ]);

    const comments = await service.list(1, 'post', 7);

    const filtered = { kind: 'filtered', phrase: 'frieren' };
    expect(comments.map(({ hiddenBecause }) => hiddenBecause)).toEqual([
      { kind: 'muted' },
      filtered,
      filtered,
      null,
      null,
    ]);
  });

  it('doesn’t collapse comments that are already deleted or hidden', async () => {
    prisma.mute.findMany.mockResolvedValue([{ mutedId: 7 }]);
    prisma.contentReport.findMany.mockResolvedValue([
      { targetType: 'comment', targetId: 2 },
    ]);
    prisma.comment.findMany.mockResolvedValue([
      comment(1, 7, { deletedAt: new Date() }),
      comment(2, 7),
      comment(3, 7, { hiddenAt: new Date() }),
    ]);

    const comments = await service.list(1, 'post', 7);

    expect(
      comments.map(({ hidden, hiddenBecause }) => [hidden, hiddenBecause]),
    ).toEqual([
      [null, null],
      ['reported', null],
      ['review', null],
    ]);
  });

  const ownerBlocks = (owners: number[], theirs = true) => ({
    where: {
      OR: [
        { blockerId: 1, blockedId: { in: owners } },
        ...(theirs ? [{ blockedId: 1, blockerId: { in: owners } }] : []),
      ],
    },
  });

  it('acts as if a post doesn’t exist when its author is blocked either way', async () => {
    prisma.block.count.mockResolvedValue(1);

    await expect(service.list(1, 'post', 7)).rejects.toThrow(
      new NotFoundException('Not found'),
    );
    expect(prisma.block.count).toHaveBeenCalledWith(ownerBlocks([2]));
    expect(prisma.comment.findMany).not.toHaveBeenCalled();
  });

  it('checks the wall owner and a library update’s owner too', async () => {
    jest.mocked(targetOf).mockResolvedValueOnce({
      type: 'post',
      id: 7,
      communityId: null,
      wallUserId: 5,
      ownerId: 2,
      mediaType: null,
      mediaSourceId: null,
    });
    await service.list(1, 'post', 7);
    expect(prisma.block.count).toHaveBeenLastCalledWith(ownerBlocks([2, 5]));

    jest.mocked(targetOf).mockResolvedValueOnce({
      type: 'activity',
      id: 8,
      communityId: null,
      wallUserId: null,
      ownerId: 6,
      mediaType: null,
      mediaSourceId: null,
    });
    prisma.block.count.mockResolvedValue(1);
    await expect(service.list(1, 'activity', 8)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.block.count).toHaveBeenLastCalledWith(ownerBlocks([6]));
  });

  it('lets site admins read comments under posts by people who blocked them, keeping their own blocks', async () => {
    prisma.user.findUnique.mockResolvedValue({
      isAdmin: true,
      email: 'admin@anime.test',
    });

    await service.list(1, 'post', 7);

    expect(prisma.block.count).toHaveBeenCalledWith(ownerBlocks([2], false));
    expect(prisma.comment.findMany.mock.calls[0][0].where.AND).toContainEqual({
      OR: [
        { author: { blocksReceived: { none: { blockerId: 1 } } } },
        { authorId: 1 },
      ],
    });
  });

  it('lets community admins read every comment in the communities they run', async () => {
    prisma.membership.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.OR
          ? [{ communityId: 3, community: { ownerId: 1 }, roles: [] }]
          : [],
      ),
    );

    await service.list(1, 'post', 7);

    expect(prisma.block.count).toHaveBeenCalledWith(ownerBlocks([2], false));
    expect(prisma.comment.findMany.mock.calls[0][0].where.AND).toContainEqual({
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

  it('won’t let someone comment across a block with the post’s author', async () => {
    prisma.block.count.mockResolvedValue(1);

    await expect(
      service.create(1, { type: 'post', id: 7, content: '<p>Hi</p>' }),
    ).rejects.toThrow(new NotFoundException('Not found'));
    expect(prisma.block.count).toHaveBeenCalledWith(ownerBlocks([2]));
    expect(prisma.comment.create).not.toHaveBeenCalled();
  });

  it('won’t let someone reply across a block with the parent comment’s author, even as a site admin', async () => {
    prisma.user.findUnique.mockResolvedValue({
      isAdmin: true,
      email: 'admin@anime.test',
    });
    prisma.comment.findUnique.mockResolvedValue({
      commentableType: 'post',
      commentableId: 7,
      authorId: 9,
    });
    prisma.block.count.mockResolvedValue(1);

    await expect(
      service.create(1, {
        type: 'post',
        id: 7,
        parentId: 12,
        content: '<p>Hi</p>',
      }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.block.count).toHaveBeenCalledWith(ownerBlocks([2, 9]));
    expect(prisma.comment.create).not.toHaveBeenCalled();
  });

  it('won’t let someone comment on a library update or wall post across a block with its owner', async () => {
    prisma.block.count.mockResolvedValue(1);
    jest.mocked(targetOf).mockResolvedValueOnce({
      type: 'activity',
      id: 8,
      communityId: null,
      wallUserId: null,
      ownerId: 6,
      mediaType: null,
      mediaSourceId: null,
    });
    await expect(
      service.create(1, { type: 'activity', id: 8, content: '<p>Hi</p>' }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.block.count).toHaveBeenLastCalledWith(ownerBlocks([6]));

    jest.mocked(targetOf).mockResolvedValueOnce({
      type: 'post',
      id: 7,
      communityId: null,
      wallUserId: 5,
      ownerId: 2,
      mediaType: null,
      mediaSourceId: null,
    });
    await expect(
      service.create(1, { type: 'post', id: 7, content: '<p>Hi</p>' }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.block.count).toHaveBeenLastCalledWith(ownerBlocks([2, 5]));
    expect(prisma.comment.create).not.toHaveBeenCalled();
  });

  describe('on something the viewer can’t open', () => {
    const viewer = (reportedPosts: number[] = []) => ({
      id: 1,
      reported: { post: reportedPosts, comment: [], forum_post: [] },
      siteAdmin: false,
      manages: [],
    });
    const notFound = new NotFoundException('Not found');
    const profilePost = {
      type: 'post' as const,
      id: 7,
      communityId: null,
      wallUserId: null,
      ownerId: 2,
      mediaType: null,
      mediaSourceId: null,
    };

    beforeEach(() =>
      jest.useFakeTimers({
        now: new Date('2026-11-07T12:00:00Z'),
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      }),
    );
    afterEach(() => jest.useRealTimers());

    it('lists the comments as before when the viewer can open the post', async () => {
      prisma.comment.findMany.mockResolvedValue([comment(1, 3)]);

      await expect(service.list(1, 'post', 7)).resolves.toMatchObject([
        { id: 1, hidden: null, hiddenBecause: null },
      ]);
      expect(prisma.post.findFirst).toHaveBeenCalledWith({
        where: { id: 7, ...viewablePost(viewer(), false) },
        select: { id: true },
      });
    });

    it('answers 404 for a post that’s hidden, by a suspended author or reported by the viewer', async () => {
      prisma.contentReport.findMany.mockResolvedValue([
        { targetType: 'post', targetId: 7 },
      ]);
      prisma.post.findFirst.mockResolvedValue(null);

      await expect(service.list(1, 'post', 7)).rejects.toThrow(notFound);
      expect(prisma.post.findFirst).toHaveBeenCalledWith({
        where: { id: 7, ...viewablePost(viewer([7]), false) },
        select: { id: true },
      });
      expect(viewablePosts(viewer([7])).AND).toContainEqual(
        visibleTo(viewer([7]), 'post'),
      );
      expect(visibleTo(viewer([7]), 'post').AND).toContainEqual({
        id: { notIn: [7] },
      });
      expect(prisma.comment.findMany).not.toHaveBeenCalled();
    });

    it('leaves 18+ posts’ comments out unless the viewer shows 18+', async () => {
      prisma.post.findFirst.mockResolvedValue(null);
      await expect(service.list(1, 'post', 7)).rejects.toThrow(notFound);
      expect(prisma.post.findFirst.mock.calls[0][0].where.AND).toContainEqual({
        isAdult: false,
      });

      prisma.user.findUnique.mockResolvedValue({ showNsfw: true });
      prisma.post.findFirst.mockResolvedValue({ id: 7 });
      await expect(service.list(1, 'post', 7)).resolves.toEqual([]);
      expect(
        prisma.post.findFirst.mock.calls[1][0].where.AND,
      ).not.toContainEqual({ isAdult: false });
    });

    it('answers 404 for a profile post when the author’s profile is private to the viewer', async () => {
      jest.mocked(targetOf).mockResolvedValueOnce(profilePost);
      prisma.post.findFirst.mockResolvedValue(null);

      await expect(service.list(1, 'post', 7)).rejects.toThrow(notFound);
      expect(requireViewAccess).not.toHaveBeenCalled();
      expect(requireProfileView).not.toHaveBeenCalled();
      expect(viewablePosts(viewer())).toEqual({
        AND: expect.arrayContaining([
          {
            OR: expect.arrayContaining([
              {
                communityId: null,
                mediaType: null,
                author: viewableProfiles(1),
              },
            ]),
          },
        ]),
      });
      expect(prisma.comment.findMany).not.toHaveBeenCalled();
    });

    it('answers 404 across a block with the wall’s owner, or for a forum opener mirrored to the feed that the viewer can’t see', async () => {
      prisma.post.findFirst.mockResolvedValue(null);

      await expect(service.list(1, 'post', 7)).rejects.toThrow(notFound);
      expect(prisma.post.findFirst.mock.calls[0][0].where.AND).toEqual(
        expect.arrayContaining([
          {
            OR: [
              { forumThreadId: null },
              { forumThread: visibleThreads(viewer()) },
            ],
          },
          {
            OR: [
              { wallUserId: null },
              {
                wallUser: {
                  blocksMade: { none: { blockedId: 1 } },
                  blocksReceived: { none: { blockerId: 1 } },
                },
              },
            ],
          },
        ]),
      );
      expect(prisma.comment.findMany).not.toHaveBeenCalled();
    });

    it('answers 404 for a library update the viewer can’t open, like a public one on a private profile', async () => {
      jest
        .mocked(targetOf)
        .mockResolvedValueOnce({ ...profilePost, type: 'activity', id: 8 });
      prisma.libraryActivity.findFirst.mockResolvedValue(null);

      await expect(service.list(1, 'activity', 8)).rejects.toThrow(notFound);
      expect(prisma.libraryActivity.findFirst).toHaveBeenCalledWith({
        where: { id: 8, ...viewableActivity(viewer(), false) },
        select: { id: true },
      });
      expect(viewableActivity(viewer(), false).entry).toMatchObject({
        isAdult: false,
        user: { AND: expect.arrayContaining([viewableProfiles(1)]) },
      });
      expect(prisma.post.findFirst).not.toHaveBeenCalled();
      expect(prisma.comment.findMany).not.toHaveBeenCalled();
    });
  });
});
