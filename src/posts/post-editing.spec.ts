import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PostsService, viewablePost, viewablePosts } from './posts.service';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LikesService } from '../likes/likes.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';
import { editHistorySelect } from '../common/edit-history';
import { GUEST_USER_ID } from '../auth/allow-guest';
import { visibleTo } from '../moderation/visibility';
import { visibleThreads } from '../forum/forum-helpers';

jest.mock('../common/rich-text', () => ({
  sanitizeRichText: (html: string) => ({
    html,
    empty: !html.replace(/<[^>]+>/g, '').trim(),
  }),
}));

const person = { id: 1, username: 'reader', name: null, avatarUrl: null };

describe('Editing and deleting posts', () => {
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
    post: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    editVersion: { create: jest.fn() },
    repost: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    comment: { findMany: jest.fn(), deleteMany: jest.fn() },
    like: { deleteMany: jest.fn() },
    bookmark: { findMany: jest.fn(), deleteMany: jest.fn() },
    user: { findMany: jest.fn(), findUnique: jest.fn() },
    contentReport: { findMany: jest.fn() },
    membership: { findMany: jest.fn() },
    community: { findUnique: jest.fn() },
    hashtag: { upsert: jest.fn().mockResolvedValue({ id: 1 }) },
    hashtagUsage: { createMany: jest.fn(), deleteMany: jest.fn() },
    $transaction: jest.fn((operations: unknown) =>
      typeof operations === 'function'
        ? (operations as (tx: unknown) => unknown)(prisma)
        : Promise.all(operations as unknown[]),
    ),
  };
  const notifications = { notify: jest.fn() };
  const discordChannel = {
    contentEdited: jest.fn(),
    contentDeleted: jest.fn(),
  };
  const service = new PostsService(
    prisma as unknown as PrismaService,
    notifications as unknown as NotificationsService,
    {
      likedBy: jest.fn().mockResolvedValue(new Set()),
    } as unknown as LikesService,
    discordChannel as unknown as DiscordChannelService,
  );

  const posted = new Date('2026-11-01T10:00:00Z');
  const firstEdit = new Date('2026-11-01T10:05:00Z');
  const secondEdit = new Date('2026-11-01T11:00:00Z');

  const saved = {
    authorId: 1,
    content: '<p>hi <a href="/users/naruto" class="mention">@naruto</a></p>',
    linkUrl: null,
    spoiler: null,
    createdAt: posted,
    editedAt: null,
    communityId: 5,
    wallUserId: null,
    mediaType: null,
    mediaSourceId: null,
    wallUser: null,
  };

  let row: Record<string, unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    row = { ...saved };
    prisma.post.findUnique.mockImplementation(() => row);
    prisma.post.updateMany.mockImplementation(({ data }) => {
      row = { ...row, ...data };
      return { count: 1 };
    });
    prisma.post.findUniqueOrThrow.mockImplementation(() => ({
      id: 3,
      ...row,
      commentCount: 0,
      likeCount: 0,
      author: person,
      community: null,
    }));
    prisma.contentReport.findMany.mockResolvedValue([]);
    prisma.membership.findMany.mockResolvedValue([]);
    prisma.comment.findMany.mockResolvedValue([]);
    prisma.bookmark.findMany.mockResolvedValue([]);
    prisma.community.findUnique.mockResolvedValue({
      isPublic: true,
      memberships: [],
    });
  });

  it('sends edits to a shared forum thread back to the thread', async () => {
    prisma.post.findUnique.mockResolvedValue({ ...saved, forumThreadId: 9 });

    await expect(
      service.update(1, 3, { content: '<p>Changed</p>' }),
    ).rejects.toThrow('Edit this in the forum thread instead');
    expect(prisma.post.updateMany).not.toHaveBeenCalled();
  });

  it('lets the author edit, keeps old mentions, and only notifies new ones', async () => {
    prisma.post.findUnique.mockResolvedValue(saved);
    prisma.user.findMany.mockResolvedValue([
      { id: 7, username: 'naruto' },
      { id: 8, username: 'sasuke' },
    ]);

    const item = await service.update(1, 3, {
      content:
        '<p>hi <a href="/users/naruto" class="mention">@naruto</a> @sasuke</p>',
    });

    const { where, data } = prisma.post.updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: 3, editedAt: null });
    expect(data.editedAt).toBeInstanceOf(Date);
    expect(data.content).toContain('href="/users/naruto" class="mention"');
    expect(data.content).toContain('href="/users/sasuke" class="mention"');
    expect(
      notifications.notify.mock.calls.flatMap(([items]) =>
        items.map(({ userId }: { userId: number }) => userId),
      ),
    ).toEqual([8]);
    expect(discordChannel.contentEdited).toHaveBeenCalledWith('post', 3);
    expect(item).toMatchObject({ id: 3, canDelete: true });
  });

  it('saves a trimmed spoiler note, and clears it when it’s left out', async () => {
    prisma.post.findUnique.mockResolvedValue(saved);
    prisma.user.findMany.mockResolvedValue([]);

    const marked = await service.update(1, 3, {
      content: '<p>The twist</p>',
      spoiler: '  Season   finale ',
    });
    await service.update(1, 3, { content: '<p>No longer a spoiler</p>' });

    expect(prisma.post.updateMany.mock.calls[0][0].data.spoiler).toBe(
      'Season finale',
    );
    expect(marked).toMatchObject({ spoiler: 'Season finale' });
    expect(prisma.post.updateMany.mock.calls[1][0].data.spoiler).toBeNull();
  });

  it('won’t let someone else edit the post', async () => {
    prisma.post.findUnique.mockResolvedValue(saved);

    await expect(
      service.update(2, 3, { content: '<p>mine now</p>' }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.post.updateMany).not.toHaveBeenCalled();
  });

  it('lets community admins delete posts, along with their comments, likes and bookmarks', async () => {
    prisma.post.findUnique.mockResolvedValue(saved);
    prisma.membership.findMany.mockResolvedValue([
      {
        communityId: 5,
        community: { ownerId: 2 },
        roles: [{ role: { permissions: BigInt(1) } }],
      },
    ]);
    prisma.comment.findMany.mockResolvedValue([{ id: 40 }]);

    await service.remove(9, 3);

    expect(prisma.like.deleteMany).toHaveBeenCalledWith({
      where: { likeableType: 'comment', likeableId: { in: [40] } },
    });
    expect(prisma.comment.deleteMany).toHaveBeenCalledWith({
      where: { commentableType: 'post', commentableId: { in: [3] } },
    });
    expect(prisma.like.deleteMany).toHaveBeenCalledWith({
      where: { likeableType: 'post', likeableId: { in: [3] } },
    });
    expect(prisma.bookmark.deleteMany).toHaveBeenCalledWith({
      where: { bookmarkableType: 'post', bookmarkableId: { in: [3] } },
    });
    expect(prisma.post.delete).toHaveBeenCalledWith({ where: { id: 3 } });
    expect(discordChannel.contentDeleted).toHaveBeenCalledWith('post', 3);
  });

  it('lets people remove posts from their own wall', async () => {
    prisma.post.findUnique.mockResolvedValue({
      ...saved,
      communityId: null,
      wallUserId: 6,
    });

    await service.remove(6, 3);

    expect(prisma.post.delete).toHaveBeenCalled();
  });

  it('won’t let other members delete someone’s post', async () => {
    prisma.post.findUnique.mockResolvedValue(saved);
    prisma.membership.findMany.mockResolvedValue([
      { communityId: 5, community: { ownerId: 2 }, roles: [] },
    ]);

    await expect(service.remove(9, 3)).rejects.toThrow(ForbiddenException);
    expect(prisma.post.delete).not.toHaveBeenCalled();
  });

  it('takes a deleted forum thread’s feed posts down with their comments, likes and bookmarks', async () => {
    prisma.post.findMany.mockResolvedValue([{ id: 3 }, { id: 4 }]);

    await service.removeThreadPosts([9, 10]);

    expect(prisma.post.findMany).toHaveBeenCalledWith({
      where: { forumThreadId: { in: [9, 10] } },
      select: { id: true },
    });
    expect(prisma.comment.deleteMany).toHaveBeenCalledWith({
      where: { commentableType: 'post', commentableId: { in: [3, 4] } },
    });
    expect(prisma.like.deleteMany).toHaveBeenCalledWith({
      where: { likeableType: 'post', likeableId: { in: [3, 4] } },
    });
    expect(prisma.bookmark.deleteMany).toHaveBeenCalledWith({
      where: { bookmarkableType: 'post', bookmarkableId: { in: [3, 4] } },
    });
    expect(prisma.post.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [3, 4] } },
    });
    expect(discordChannel.contentDeleted).toHaveBeenCalledWith('post', 3);
    expect(discordChannel.contentDeleted).toHaveBeenCalledWith('post', 4);
  });

  describe('Edit history', () => {
    const viewer = (id: number) => ({
      id,
      reported: { post: [], comment: [], forum_post: [] },
      siteAdmin: false,
      manages: [],
    });
    const versions = [
      {
        content: '<p>Second</p>',
        linkUrl: null,
        spoiler: null,
        createdAt: firstEdit,
      },
      {
        content: '<p>First</p>',
        linkUrl: null,
        spoiler: null,
        createdAt: posted,
      },
    ];
    const conflict = new ConflictException(
      'This was edited somewhere else. Reload and try again',
    );

    beforeEach(() => {
      prisma.user.findMany.mockResolvedValue([]);
      jest.useFakeTimers({
        now: secondEdit,
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
    });
    afterEach(() => jest.useRealTimers());

    it('saves the previous version with the edit, dated by its last edit', async () => {
      row = { ...saved, content: '<p>Second</p>', editedAt: firstEdit };

      await service.update(1, 3, {
        content: '<p>Second</p>',
        spoiler: 'Finale',
      });

      expect(prisma.post.updateMany).toHaveBeenCalledWith({
        where: { id: 3, editedAt: firstEdit },
        data: {
          content: '<p>Second</p>',
          linkUrl: null,
          spoiler: 'Finale',
          editedAt: secondEdit,
        },
      });
      expect(prisma.editVersion.create).toHaveBeenCalledWith({
        data: {
          postId: 3,
          content: '<p>Second</p>',
          linkUrl: null,
          spoiler: null,
          createdAt: firstEdit,
        },
      });
    });

    it('neither marks it edited nor saves a version when the body is the same', async () => {
      row = { ...saved, content: '<p>Same</p>' };

      const item = await service.update(1, 3, { content: '<p>Same</p>' });

      expect(prisma.post.updateMany.mock.calls[0][0].data).toEqual({
        content: '<p>Same</p>',
        linkUrl: null,
        spoiler: null,
      });
      expect(prisma.editVersion.create).not.toHaveBeenCalled();
      expect(item).toMatchObject({ id: 3, editedAt: null });
    });

    it('dates a real edit after an unchanged one by when the body was really published', async () => {
      row = { ...saved, content: '<p>First</p>' };

      jest.setSystemTime(firstEdit);
      await service.update(1, 3, { content: '<p>Second</p>' });
      jest.setSystemTime(new Date('2026-11-01T10:30:00Z'));
      await service.update(1, 3, { content: '<p>Second</p>' });
      jest.setSystemTime(secondEdit);
      await service.update(1, 3, { content: '<p>Third</p>' });

      expect(
        prisma.editVersion.create.mock.calls.map(([{ data }]) => data),
      ).toEqual([
        expect.objectContaining({ content: '<p>First</p>', createdAt: posted }),
        expect.objectContaining({
          content: '<p>Second</p>',
          createdAt: firstEdit,
        }),
      ]);
      expect(row.editedAt).toEqual(secondEdit);
    });

    it('refuses an edit when the post was edited after it was read, saving nothing', async () => {
      prisma.post.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.update(1, 3, { content: '<p>Mine</p>' }),
      ).rejects.toThrow(conflict);
      expect(prisma.editVersion.create).not.toHaveBeenCalled();
      expect(prisma.hashtagUsage.deleteMany).not.toHaveBeenCalled();
      expect(notifications.notify).not.toHaveBeenCalled();
      expect(discordChannel.contentEdited).not.toHaveBeenCalled();
    });

    it('keeps a shared forum thread’s feed post history of its own', async () => {
      prisma.post.findUnique.mockResolvedValue({
        id: 4,
        authorId: 1,
        content: '<p>Old</p>',
        linkUrl: null,
        spoiler: null,
        createdAt: posted,
        editedAt: null,
      });
      const body = (content: string) => ({
        content,
        linkUrl: null,
        spoiler: null,
      });

      await service.threadChanged(9, body('<p>New</p>'));
      await service.threadChanged(9, body('<p>Old</p>'));

      expect(prisma.post.updateMany.mock.calls).toEqual([
        [
          {
            where: { id: 4, editedAt: null },
            data: { ...body('<p>New</p>'), editedAt: secondEdit },
          },
        ],
        [{ where: { id: 4, editedAt: null }, data: body('<p>Old</p>') }],
      ]);
      expect(prisma.editVersion.create).toHaveBeenCalledTimes(1);
      expect(prisma.editVersion.create).toHaveBeenCalledWith({
        data: { postId: 4, ...body('<p>Old</p>'), createdAt: posted },
      });

      prisma.post.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(
        service.threadChanged(9, body('<p>Newer</p>')),
      ).rejects.toThrow(conflict);
      expect(prisma.editVersion.create).toHaveBeenCalledTimes(1);
    });

    it('lists every version newest first, starting with the current one', async () => {
      prisma.post.findFirst.mockResolvedValue({
        content: '<p>Third</p>',
        linkUrl: null,
        spoiler: 'Finale',
        createdAt: posted,
        editedAt: secondEdit,
        editVersions: versions,
      });

      await expect(service.findEdits(1, 3)).resolves.toEqual([
        {
          content: '<p>Third</p>',
          linkUrl: null,
          spoiler: 'Finale',
          createdAt: secondEdit,
        },
        ...versions,
      ]);
      expect(prisma.post.findFirst).toHaveBeenCalledWith({
        where: { id: 3, ...viewablePost(viewer(1), false) },
        select: editHistorySelect,
      });
    });

    it('answers 404 to anyone who can’t open the post where it was posted', async () => {
      prisma.post.findFirst.mockResolvedValue(null);

      await expect(service.findEdits(1, 3)).rejects.toThrow(
        new NotFoundException('Post not found'),
      );
      const { AND } = prisma.post.findFirst.mock.calls[0][0].where;
      expect(AND).toContainEqual(viewablePosts(viewer(1)));
      expect(viewablePosts(viewer(1)).AND).toContainEqual(
        visibleTo(viewer(1), 'post'),
      );
      expect(AND).toContainEqual({ isAdult: false });
    });

    it('answers 404 for a post on the wall of someone the viewer blocked, or who blocked them', async () => {
      prisma.post.findFirst.mockResolvedValue(null);

      await expect(service.findEdits(1, 3)).rejects.toThrow(NotFoundException);
      expect(prisma.post.findFirst.mock.calls[0][0].where.AND).toContainEqual({
        OR: [
          { wallUserId: null },
          {
            wallUser: {
              blocksMade: { none: { blockedId: 1 } },
              blocksReceived: { none: { blockerId: 1 } },
            },
          },
        ],
      });
    });

    it('answers 404 for a shared forum thread’s feed post when its opening post is hidden', async () => {
      prisma.post.findFirst.mockResolvedValue(null);

      await expect(service.findEdits(1, 3)).rejects.toThrow(NotFoundException);
      expect(prisma.post.findFirst.mock.calls[0][0].where.AND).toContainEqual({
        OR: [
          { forumThreadId: null },
          { forumThread: visibleThreads(viewer(1)) },
        ],
      });
      expect(visibleThreads(viewer(1)).posts.some.AND).toContainEqual({
        OR: [{ hiddenAt: null }, { authorId: 1 }],
      });
    });

    it('answers 404 for ids out of range without looking them up', async () => {
      await expect(service.findEdits(1, 2 ** 31)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.post.findFirst).not.toHaveBeenCalled();
    });

    it('lets guests read the history of public posts', async () => {
      prisma.post.findFirst.mockResolvedValue({
        content: '<p>Only</p>',
        linkUrl: null,
        spoiler: null,
        createdAt: posted,
        editedAt: null,
        editVersions: [],
      });

      await expect(service.findEdits(GUEST_USER_ID, 3)).resolves.toEqual([
        {
          content: '<p>Only</p>',
          linkUrl: null,
          spoiler: null,
          createdAt: posted,
        },
      ]);
      expect(prisma.post.findFirst.mock.calls[0][0].where).toEqual({
        id: 3,
        ...viewablePost(viewer(GUEST_USER_ID), false),
      });
    });
  });
});
