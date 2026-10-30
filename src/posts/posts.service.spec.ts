import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PostsService } from './posts.service';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LikesService } from '../likes/likes.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';

jest.mock('../common/rich-text', () => ({ sanitizeRichText: jest.fn() }));

const date = new Date('2026-10-24T12:00:00Z');
const person = { id: 1, username: 'reader', name: null, avatarUrl: null };
const post = {
  id: 1,
  createdAt: date,
  commentCount: 0,
  content: 'Post',
  author: person,
};
const isPinnedQuery = (where: object) => {
  const text = JSON.stringify(where);
  return text.includes('"pinnedAt":{"not":null}') && !text.includes('"NOT"');
};
const activity = {
  id: 3,
  createdAt: date,
  commentCount: 0,
  progressTo: null,
  status: 'current',
  entry: {
    mediaType: 'anime',
    sourceId: '1',
    title: 'Title',
    coverImage: null,
    year: null,
    user: person,
  },
};

describe('Feed content filters', () => {
  const prisma = {
    post: { findMany: jest.fn() },
    libraryActivity: { findMany: jest.fn() },
    contentReport: { findMany: jest.fn() },
    user: { findUnique: jest.fn() },
    friendship: { findFirst: jest.fn() },
    membership: { findMany: jest.fn() },
  };
  const likes = { likedBy: jest.fn() };
  const service = new PostsService(
    prisma as unknown as PrismaService,
    {} as NotificationsService,
    likes as unknown as LikesService,
    {} as DiscordChannelService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.post.findMany.mockImplementation(({ where }) =>
      Promise.resolve(isPinnedQuery(where) ? [] : [post]),
    );
    prisma.libraryActivity.findMany.mockResolvedValue([activity]);
    prisma.contentReport.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue(person);
    prisma.friendship.findFirst.mockResolvedValue(null);
    prisma.membership.findMany.mockResolvedValue([]);
    likes.likedBy.mockResolvedValue(new Set());
  });

  it('includes all types by default', async () => {
    const result = await service.findForMember(1);
    expect(result.items.map((item) => item.type)).toEqual(['activity', 'post']);
  });

  it('can hide library updates', async () => {
    const result = await service.findForMember(1, undefined, 'activity');
    expect(result.items.map((item) => item.type)).toEqual(['post']);
    expect(prisma.libraryActivity.findMany).not.toHaveBeenCalled();
  });

  it('can show only library updates', async () => {
    expect(
      (await service.findForMember(1, undefined, 'post')).items.map(
        (item) => item.type,
      ),
    ).toEqual(['activity']);
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });

  it('can hide all types', async () => {
    expect(await service.findForMember(1, undefined, 'post,activity')).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(prisma.post.findMany).not.toHaveBeenCalled();
    expect(prisma.libraryActivity.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['thread', ['activity', 'post']],
    ['activity,thread', ['post']],
    ['post,,unknown', ['activity']],
    ['constructor', ['activity', 'post']],
  ])('ignores unknown types in the filter %s', async (filter, types) => {
    const { items } = await service.findForMember(1, undefined, filter);
    expect(items.map((item) => item.type)).toEqual(types);
  });

  it('filters community feeds before pagination', async () => {
    expect(
      (await service.findForCommunity(1, 9, undefined, 'activity')).items.map(
        (item) => item.type,
      ),
    ).toEqual(['post']);
    expect(prisma.libraryActivity.findMany).not.toHaveBeenCalled();
  });

  it('shows posts and library updates in a community’s feed', async () => {
    const { items } = await service.findForCommunity(1, 9);

    expect(items.map((item) => item.type)).toEqual(['activity', 'post']);
    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ communityId: 9 }),
      }),
    );
  });

  it('filters profile feeds', async () => {
    expect(
      (
        await service.findForProfile(1, 'reader', undefined, 'activity')
      ).items.map((item) => item.type),
    ).toEqual(['post']);
    expect(prisma.libraryActivity.findMany).not.toHaveBeenCalled();
  });

  it('filters title-page posts', async () => {
    expect(
      await service.findForMedia(1, 'anime', '1', undefined, 'post'),
    ).toEqual({ items: [], nextCursor: null });
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });

  it('paginates matching items even when other types dominate the feed', async () => {
    prisma.post.findMany.mockResolvedValue(
      Array.from({ length: 11 }, (_, index) => ({ ...post, id: 11 - index })),
    );
    const first = await service.findForMember(1, undefined, 'activity');
    expect(first.items).toHaveLength(10);
    expect(first.nextCursor).toBe(`${date.getTime()}_0_2`);
    prisma.post.findMany.mockResolvedValue([{ ...post, id: 1 }]);
    const second = await service.findForMember(
      1,
      first.nextCursor!,
      'activity',
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const where = prisma.post.findMany.mock.calls[1][0].where;
    expect(where.AND).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ wallUserId: 1 }),
          ]),
        }),
        expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ id: { lt: 2 } }),
          ]),
        }),
      ]),
    );
  });

  it('retains profile visibility conditions when paging filtered posts', async () => {
    await service.findForProfile(
      1,
      'reader',
      `${date.getTime()}_0_2`,
      'activity',
    );
    const where = prisma.post.findMany.mock.calls[0][0].where;
    expect(where.AND[0].OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorId: person.id,
          community: expect.any(Object),
        }),
      ]),
    );
    expect(where.AND).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ id: { lt: 2 } }),
          ]),
        }),
      ]),
    );
  });

  it('searches only the posts a profile shows', async () => {
    const result = await service.searchProfile(1, 'reader', ' Post ');

    expect(result.map((item) => item.type)).toEqual(['post']);
    const postWhere = prisma.post.findMany.mock.calls[0][0].where;
    expect(postWhere.AND[0].OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ wallUserId: person.id }),
        expect.objectContaining({
          authorId: person.id,
          community: expect.any(Object),
        }),
      ]),
    );
    expect(postWhere.AND[1]).toEqual({
      content: { contains: 'Post', mode: 'insensitive' },
    });
  });

  it('shows community authors by their nickname there', async () => {
    prisma.post.findMany.mockResolvedValue([{ ...post, communityId: 5 }]);
    prisma.membership.findMany.mockResolvedValueOnce([
      { communityId: 5, userId: person.id, nickname: 'Navigator' },
    ]);

    const { items } = await service.findForCommunity(
      1,
      5,
      undefined,
      'activity',
    );

    expect(items[0].author).toEqual({ ...person, nickname: 'Navigator' });
  });

  it('searches posts from the same places as the home feed', async () => {
    await service.searchFeed(1, '  frieren ');
    await service.findForMember(1);

    const contains = { contains: 'frieren', mode: 'insensitive' };
    const [searchPosts, feedPosts] = prisma.post.findMany.mock.calls.map(
      ([args]) => args.where.AND,
    );
    expect(searchPosts[0]).toEqual(feedPosts[0]);
    expect(searchPosts).toContainEqual({ content: contains });
  });

  it('waits for at least two characters before searching everywhere', async () => {
    expect(await service.searchFeed(1, 'a')).toEqual([]);
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });

  it('leaves out library updates members hid from a community', async () => {
    await service.findForCommunity(1, 9);
    expect(
      prisma.libraryActivity.findMany.mock.calls[0][0].where.entry.user,
    ).toEqual({
      OR: [
        { suspendedAt: null },
        { suspendedUntil: { lte: expect.any(Date) } },
      ],
      memberships: { some: { communityId: 9, showLibraryUpdates: true } },
    });

    await service.findForMember(1);
    expect(
      prisma.libraryActivity.findMany.mock.calls[1][0].where.entry.user,
    ).toEqual({
      OR: [
        { suspendedAt: null },
        { suspendedUntil: { lte: expect.any(Date) } },
      ],
      memberships: {
        some: {
          showLibraryUpdates: true,
          community: { memberships: { some: { userId: 1 } } },
        },
      },
    });
  });

  it('hides 18+ library updates unless the viewer turned NSFW on', async () => {
    await service.findForMember(1);
    expect(
      prisma.libraryActivity.findMany.mock.calls[0][0].where.entry,
    ).toMatchObject({ isAdult: false });

    prisma.user.findUnique.mockResolvedValue({ ...person, showNsfw: true });
    await service.findForMember(1);
    expect(
      prisma.libraryActivity.findMany.mock.calls[1][0].where.entry,
    ).not.toHaveProperty('isAdult');
  });

  it('waits for at least two characters before searching a profile', async () => {
    expect(await service.searchProfile(1, 'reader', 'a')).toEqual([]);
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });

  it('refuses to search a private profile you can’t see', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 4, isPublic: false });

    await expect(service.searchProfile(1, 'secret', 'Post')).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });
});

describe('Creating posts with a link card', () => {
  const create = jest.fn(({ data }) => ({ id: 9, ...data, author: person }));
  const service = new PostsService(
    {
      post: { create },
      membership: { findMany: jest.fn().mockResolvedValue([]) },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          createdAt: new Date('2026-01-01'),
          isAdmin: false,
          email: 'reader@anime.test',
        }),
      },
    } as unknown as PrismaService,
    {} as NotificationsService,
    {} as LikesService,
    { postCreated: jest.fn() } as unknown as DiscordChannelService,
  );
  const sanitize = jest.requireMock('../common/rich-text')
    .sanitizeRichText as jest.Mock;

  beforeEach(() => jest.clearAllMocks());

  it('saves the link alongside the text', async () => {
    sanitize.mockReturnValue({ html: '<p>Watch this</p>', empty: false });

    await service.create(3, 1, {
      content: '<p>Watch this</p>',
      linkUrl: 'https://youtu.be/dQw4w9WgXcQ',
    });

    expect(create.mock.calls[0][0].data).toMatchObject({
      content: '<p>Watch this</p>',
      linkUrl: 'https://youtu.be/dQw4w9WgXcQ',
    });
  });

  it('allows a post that is only a link card', async () => {
    sanitize.mockReturnValue({ html: '<p></p>', empty: true });

    await service.create(3, 1, {
      content: '<p></p>',
      linkUrl: 'https://example.com',
    });

    expect(create.mock.calls[0][0].data).toMatchObject({
      content: '',
      linkUrl: 'https://example.com',
    });
  });

  it('still rejects empty posts without a link', async () => {
    sanitize.mockReturnValue({ html: '<p></p>', empty: true });

    await expect(
      service.create(3, 1, { content: '<p></p>' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('Opening a post or library update from a link', () => {
  const prisma = {
    post: { findFirst: jest.fn() },
    libraryActivity: { findFirst: jest.fn() },
    contentReport: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn().mockResolvedValue({ showNsfw: false }) },
    membership: { findMany: jest.fn().mockResolvedValue([]) },
    steamGame: { findMany: jest.fn().mockResolvedValue([]) },
    steamAccount: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const likes = { likedBy: jest.fn().mockResolvedValue(new Set()) };
  const service = new PostsService(
    prisma as unknown as PrismaService,
    {} as NotificationsService,
    likes as unknown as LikesService,
    {} as DiscordChannelService,
  );

  it('finds a visible post in that community', async () => {
    prisma.post.findFirst.mockResolvedValue({ ...post, communityId: 7 });

    const item = await service.findOneInCommunity(1, 7, 1);

    expect(item).toMatchObject({ type: 'post', id: 1 });
    expect(prisma.post.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 1,
          communityId: 7,
          AND: expect.any(Array),
        }),
      }),
    );
  });

  it('says a hidden or missing post isn’t there', async () => {
    prisma.post.findFirst.mockResolvedValue(null);

    await expect(service.findOneInCommunity(1, 7, 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('only finds public library updates shared with the community', async () => {
    prisma.libraryActivity.findFirst.mockResolvedValue(activity);

    const item = await service.findActivityInCommunity(1, 7, 3);

    expect(item).toMatchObject({ type: 'activity', id: 3 });
    expect(prisma.libraryActivity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 3,
          entry: {
            isPublic: true,
            isAdult: false,
            user: {
              OR: [
                { suspendedAt: null },
                { suspendedUntil: { lte: expect.any(Date) } },
              ],
              memberships: {
                some: { communityId: 7, showLibraryUpdates: true },
              },
            },
          },
        },
      }),
    );
  });
});
