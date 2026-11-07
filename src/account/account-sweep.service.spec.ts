import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccountSweepService } from './account-sweep.service';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { CommunitiesService } from '../communities/communities.service';
import { MessagesService } from '../messages/messages.service';
import { ForumService } from '../forum/forum.service';
import { PostsService } from '../posts/posts.service';
import { LibraryService } from '../library/library.service';
import { CommentsService } from '../comments/comments.service';
import { LikesService } from '../likes/likes.service';
import { ADMINISTRATOR } from '../communities/permissions';
import { NotFoundException } from '@nestjs/common';

jest.mock('../common/rich-text', () => ({ sanitizeRichText: jest.fn() }));

describe('Deleting accounts whose grace period is over', () => {
  const now = new Date('2026-12-07T12:00:00Z');
  const order: string[] = [];
  const track =
    (name: string) =>
    (...args: unknown[]) => {
      order.push(`${name}(${args.join(',')})`);
      return Promise.resolve();
    };
  const lock = { $queryRaw: jest.fn() };
  const prisma = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(() => order.push('deleteUser')),
    },
    community: {
      findMany: jest.fn(),
      update: jest.fn(({ where, data }) =>
        track('passCommunity')(where.id, data.ownerId),
      ),
    },
    membership: { findMany: jest.fn() },
    forumThread: { findMany: jest.fn() },
    forumPost: { findMany: jest.fn() },
    post: { findMany: jest.fn() },
    libraryEntry: { findMany: jest.fn() },
    comment: { findMany: jest.fn() },
    contentReport: { deleteMany: jest.fn() },
    communityBan: { deleteMany: jest.fn(), updateMany: jest.fn() },
    invite: { updateMany: jest.fn() },
    notification: { deleteMany: jest.fn() },
    $transaction: jest.fn((work: unknown) =>
      typeof work === 'function' ? work(lock) : Promise.all(work as unknown[]),
    ),
  };
  const storage = { deleteUrl: jest.fn() };
  const communities = { remove: jest.fn(track('removeCommunity')) };
  const messages = { removeUser: jest.fn(track('chats')) };
  const forum = {
    removeThread: jest.fn(track('removeThread')),
    removePost: jest.fn(track('removeForumPost')),
  };
  const posts = { remove: jest.fn(track('removePost')) };
  const library = { remove: jest.fn(track('removeEntry')) };
  const comments = { remove: jest.fn(track('removeComment')) };
  const likes = { removeAllBy: jest.fn(track('likes')) };
  const service = new AccountSweepService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    communities as unknown as CommunitiesService,
    messages as unknown as MessagesService,
    forum as unknown as ForumService,
    posts as unknown as PostsService,
    library as unknown as LibraryService,
    comments as unknown as CommentsService,
    likes as unknown as LikesService,
  );

  function due(deleteAt: Date | null) {
    prisma.user.findUnique.mockResolvedValue({
      deleteAt,
      avatarUrl: 'https://cdn.test/avatars/a.webp',
      coverUrl: null,
      backgroundUrl: 'https://cdn.test/user-backgrounds/b.webp',
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    order.length = 0;
    jest.useFakeTimers({ now, doNotFake: ['nextTick', 'setImmediate'] });
    prisma.community.findMany.mockResolvedValue([{ id: 3 }, { id: 4 }]);
    prisma.membership.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.communityId === 3
          ? [
              {
                user: { id: 9, username: 'sasuke', name: null },
                roles: [{ role: { permissions: ADMINISTRATOR } }],
              },
            ]
          : [],
      ),
    );
    prisma.forumThread.findMany.mockResolvedValue([{ id: 20, communityId: 3 }]);
    prisma.forumPost.findMany.mockResolvedValue([{ id: 21, communityId: 3 }]);
    prisma.post.findMany.mockResolvedValue([{ id: 31 }, { id: 30 }]);
    prisma.libraryEntry.findMany.mockResolvedValue([{ id: 40 }]);
    prisma.comment.findMany
      .mockResolvedValueOnce([{ id: 51 }, { id: 50 }])
      .mockResolvedValueOnce([{ id: 50 }]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('passes on or deletes their communities, then removes everything they made through the usual paths', async () => {
    due(new Date('2026-12-07T11:00:00Z'));

    await expect(service.deleteAccount(7)).resolves.toBe(true);

    expect(order).toEqual([
      'passCommunity(3,9)',
      'removeCommunity(7,4)',
      'chats(7)',
      'removeThread(7,3,20)',
      'removeForumPost(7,3,21)',
      'removePost(7,31)',
      'removePost(7,30)',
      'removeEntry(7,40)',
      'removeComment(7,51)',
      'removeComment(7,50)',
      'likes(7)',
      'deleteUser',
    ]);
    expect(prisma.community.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { ownerId: 9 },
    });
    expect(prisma.invite.updateMany).toHaveBeenCalledWith({
      where: { communityId: 3, creatorId: 7 },
      data: { creatorId: 9 },
    });
    expect(prisma.invite.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ authorId: 7 }, { wallUserId: 7 }] },
      }),
    );
    expect(prisma.comment.findMany).toHaveBeenNthCalledWith(1, {
      where: { authorId: 7, deletedAt: null },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
  });

  it('cleans up what points at them, deletes the account and its images', async () => {
    due(new Date('2026-12-07T11:00:00Z'));

    await service.deleteAccount(7);

    expect(prisma.contentReport.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { targetType: 'user', targetId: 7 },
          { targetType: 'comment', targetId: { in: [50] } },
        ],
      },
    });
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: { actorId: 7 },
    });
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 7 } });
    expect(storage.deleteUrl).toHaveBeenCalledWith(
      'https://cdn.test/avatars/a.webp',
    );
    expect(storage.deleteUrl).toHaveBeenCalledWith(null);
    expect(storage.deleteUrl).toHaveBeenCalledWith(
      'https://cdn.test/user-backgrounds/b.webp',
    );
  });

  it('keeps the bans an admin issued, leaving the database to clear who issued them', async () => {
    due(new Date('2026-12-07T11:00:00Z'));

    await service.deleteAccount(7);

    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 7 } });
    expect(prisma.communityBan.deleteMany).not.toHaveBeenCalled();
    expect(prisma.communityBan.updateMany).not.toHaveBeenCalled();
    const schema = readFileSync(
      join(__dirname, '../../prisma/schema/community.prisma'),
      'utf8',
    );
    expect(schema).toMatch(
      /bannedById\s+Int\?\n[\s\S]*bannedBy\s+User\?\s+@relation\("CommunityBansIssued", fields: \[bannedById\], references: \[id\], onDelete: SetNull\)/,
    );
  });

  it('leaves accounts alone that aren’t due or were restored', async () => {
    for (const deleteAt of [null, new Date('2026-12-08T00:00:00Z')]) {
      due(deleteAt);
      await expect(service.deleteAccount(7)).resolves.toBe(false);
    }
    expect(order).toEqual([]);
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('carries on past things that are already gone, but stops on real errors', async () => {
    due(new Date('2026-12-07T11:00:00Z'));
    posts.remove.mockRejectedValueOnce(new NotFoundException());

    await expect(service.deleteAccount(7)).resolves.toBe(true);
    expect(posts.remove).toHaveBeenCalledTimes(2);

    posts.remove.mockRejectedValueOnce(new Error('database down'));
    await expect(service.deleteAccount(7)).rejects.toThrow('database down');
  });

  it('runs only where it holds the sweep lock', async () => {
    lock.$queryRaw.mockResolvedValue([{ locked: false }]);

    await service.sweep();

    expect(lock.$queryRaw.mock.calls[0][0].join('?')).toContain(
      'pg_try_advisory_xact_lock(?::bigint)',
    );
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('deletes due accounts one at a time, and lets ones that keep failing wait a day', async () => {
    lock.$queryRaw.mockResolvedValue([{ locked: true }]);
    prisma.user.findMany.mockResolvedValue([{ id: 7 }, { id: 8 }]);
    const deleteAccount = jest
      .spyOn(service, 'deleteAccount')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(true);

    await service.sweep();

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { deleteAt: { lte: now }, id: { notIn: [] } },
      orderBy: { deleteAt: 'asc' },
      take: 20,
      select: { id: true },
    });
    expect(deleteAccount.mock.calls).toEqual([[7], [8]]);

    await service.sweep();
    expect(prisma.user.findMany.mock.calls[1][0].where.id).toEqual({
      notIn: [7],
    });

    jest.setSystemTime(new Date('2026-12-08T12:00:01Z'));
    await service.sweep();
    expect(prisma.user.findMany.mock.calls[2][0].where.id).toEqual({
      notIn: [],
    });
    deleteAccount.mockRestore();
  });
});
