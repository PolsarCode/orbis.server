import { NotFoundException } from '@nestjs/common';
import { CommentsService } from './comments.service';
import { PrismaService } from '../prisma.service';
import { LikesService } from '../likes/likes.service';
import { NotificationsService } from '../notifications/notifications.service';
import { targetOf } from '../posts/wall-access';

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
});
