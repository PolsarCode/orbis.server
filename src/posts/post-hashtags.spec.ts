import { PostsService } from './posts.service';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LikesService } from '../likes/likes.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';
import { publicPosts } from '../tags/public-content';

jest.mock('../common/rich-text', () => ({
  sanitizeRichText: (html: string) => ({
    html,
    empty: !html.replace(/<[^>]+>/g, '').trim(),
  }),
}));
jest.mock('./wall-access', () => ({
  ...jest.requireActual('./wall-access'),
  requireWallAccess: jest.fn(),
}));
jest.mock('../library/library-api', () => ({
  ...jest.requireActual('../library/library-api'),
  getMedia: jest.fn().mockResolvedValue({}),
}));

const person = { id: 1, username: 'frieren', name: null, avatarUrl: null };
const createdAt = new Date('2026-11-05T10:00:00Z');

function setup() {
  const prisma = {
    post: {
      create: jest.fn(({ data }) => ({
        id: 9,
        commentCount: 0,
        createdAt,
        author: person,
        ...data,
      })),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(({ data }) => ({
        id: 9,
        authorId: 1,
        communityId: 5,
        wallUserId: null,
        commentCount: 0,
        createdAt,
        author: person,
        ...data,
      })),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 4, username: 'himmel' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    libraryActivity: { findMany: jest.fn().mockResolvedValue([]) },
    contentReport: { findMany: jest.fn().mockResolvedValue([]) },
    membership: { findMany: jest.fn().mockResolvedValue([]) },
    bookmark: { findMany: jest.fn().mockResolvedValue([]) },
    hashtag: {
      upsert: jest.fn(({ where }: { where: { name: string } }) =>
        Promise.resolve({ id: where.name.length }),
      ),
    },
    hashtagUsage: { createMany: jest.fn(), deleteMany: jest.fn() },
    $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
  };
  const discordChannel = {
    postCreated: jest.fn(),
    contentEdited: jest.fn(),
  };
  const service = new PostsService(
    prisma as unknown as PrismaService,
    { notify: jest.fn() } as unknown as NotificationsService,
    {
      likedBy: jest.fn().mockResolvedValue(new Set()),
    } as unknown as LikesService,
    discordChannel as unknown as DiscordChannelService,
  );
  return { prisma, service };
}

const usage = (hashtagId: number, postId = 9) => ({
  hashtagId,
  postId,
  authorId: 1,
  createdAt,
});

describe('Hashtags in posts', () => {
  it('links the tags and saves a use for each one in community, wall and title-page posts', async () => {
    const { prisma, service } = setup();

    await service.create(5, 1, { content: '<p>#Frieren is #frieren</p>' });
    await service.createOnWall('himmel', 1, { content: '<p>#Mimic</p>' });
    await service.createOnMedia('anime', '52991', 1, {
      content: '<p>#Fern</p>',
    });

    expect(prisma.post.create.mock.calls[0][0].data.content).toBe(
      '<p><a href="/tags/frieren" class="hashtag">#Frieren</a> is ' +
        '<a href="/tags/frieren" class="hashtag">#frieren</a></p>',
    );
    expect(prisma.hashtagUsage.createMany.mock.calls).toEqual([
      [{ data: [usage(7)], skipDuplicates: true }],
      [{ data: [usage(5)], skipDuplicates: true }],
      [{ data: [usage(4)], skipDuplicates: true }],
    ]);
  });

  it('saves nothing for posts without tags', async () => {
    const { prisma, service } = setup();

    await service.create(5, 1, { content: '<p>No tags, C#9 &amp;#nope</p>' });

    expect(prisma.hashtag.upsert).not.toHaveBeenCalled();
    expect(prisma.hashtagUsage.createMany).not.toHaveBeenCalled();
  });

  it('re-reads the tags on edit and replaces the saved uses', async () => {
    const { prisma, service } = setup();
    prisma.post.findUnique.mockResolvedValue({
      authorId: 1,
      content:
        '<p><a href="/tags/frieren" class="hashtag">#Frieren</a> #himmel</p>',
      communityId: 5,
      wallUserId: null,
      mediaType: null,
      mediaSourceId: null,
      forumThreadId: null,
      wallUser: null,
    });

    await service.update(1, 9, {
      content: '<p><a href="/tags/frieren" class="hashtag">#Frieren</a></p>',
    });

    expect(prisma.post.update.mock.calls[0][0].data.content).toBe(
      '<p><a href="/tags/frieren" class="hashtag">#Frieren</a></p>',
    );
    expect(prisma.hashtagUsage.deleteMany).toHaveBeenCalledWith({
      where: { postId: 9 },
    });
    expect(prisma.hashtagUsage.createMany).toHaveBeenCalledWith({
      data: [usage(7)],
    });
  });

  it('gives a shared forum thread’s feed post the same tags, and keeps them in step', async () => {
    const { prisma, service } = setup();
    const hashtags = [{ name: 'frieren', display: 'Frieren' }];

    await service.shareThread(
      {
        id: 3,
        communityId: 5,
        authorId: 1,
        content: '<p>#Frieren</p>',
        linkUrl: null,
        spoiler: null,
      },
      hashtags,
    );
    expect(prisma.hashtagUsage.createMany).toHaveBeenCalledWith({
      data: [usage(7)],
      skipDuplicates: true,
    });

    prisma.post.findUnique.mockResolvedValue({ id: 9 });
    await service.threadChanged(
      3,
      { content: '<p>Edited</p>', linkUrl: null, spoiler: null },
      [],
    );
    expect(prisma.hashtagUsage.deleteMany).toHaveBeenCalledWith({
      where: { postId: 9 },
    });
    expect(prisma.hashtagUsage.createMany).toHaveBeenLastCalledWith({
      data: [],
    });
  });
});

describe('Followed tags in the home feed', () => {
  const followed = {
    AND: [
      publicPosts(),
      {
        hashtagUsages: {
          some: { hashtag: { follows: { some: { userId: 1 } } } },
        },
      },
    ],
  };

  it('adds public posts with a followed tag to the same query, so paging stays intact', async () => {
    const { prisma, service } = setup();

    await service.findForMember(1, '1730800000000_0_5');

    expect(prisma.post.findMany).toHaveBeenCalledTimes(1);
    const { where, take } = prisma.post.findMany.mock.calls[0][0];
    expect(take).toBe(11);
    expect(where.AND[0].OR).toContainEqual(followed);
    expect(where.AND[1]).toEqual({
      OR: [
        { createdAt: { lt: new Date(1730800000000) } },
        { createdAt: new Date(1730800000000), id: { lt: 5 } },
      ],
    });
  });

  it('only counts posts people outside the community or profile could see', () => {
    expect(publicPosts()).toEqual({
      OR: [
        { community: { isPublic: true } },
        { wallUser: { isPublic: true } },
        { mediaType: { not: null } },
      ],
    });
  });

  it('searches the followed tags’ posts too, like the feed shows them', async () => {
    const { prisma, service } = setup();

    await service.searchFeed(1, 'frieren');

    const { where } = prisma.post.findMany.mock.calls[0][0];
    expect(where.AND[0].OR).toContainEqual(followed);
  });
});
