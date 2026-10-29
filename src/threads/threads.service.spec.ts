import { ThreadsService } from './threads.service';
import { PrismaService } from '../prisma.service';
import { VotesService } from '../votes/votes.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';

jest.mock('../common/rich-text', () => ({ sanitizeRichText: jest.fn() }));

describe('ThreadsService.create', () => {
  const create = jest.fn(({ data }) => ({
    id: 4,
    ...data,
    commentCount: 0,
    author: {
      id: data.authorId,
      username: 'reader',
      name: null,
      avatarUrl: null,
    },
  }));
  const voteCreate = jest.fn();
  const membershipFind = jest.fn().mockResolvedValue([]);
  const userFind = jest.fn();
  const communityFind = jest.fn();
  const prisma = {
    thread: { create },
    vote: { create: voteCreate },
    membership: { findMany: membershipFind },
    user: {
      findMany: userFind,
      findUnique: jest.fn().mockResolvedValue({
        createdAt: new Date('2026-01-01'),
        isAdmin: false,
        email: 'reader@anime.test',
      }),
    },
    community: { findUnique: communityFind },
    $transaction: jest.fn((run) => run(prisma)),
  };
  const notifications = { notify: jest.fn() };
  const service = new ThreadsService(
    prisma as unknown as PrismaService,
    {} as VotesService,
    notifications as unknown as NotificationsService,
    { threadCreated: jest.fn() } as unknown as DiscordChannelService,
  );
  const sanitize = jest.requireMock('../common/rich-text')
    .sanitizeRichText as jest.Mock;

  beforeEach(() => jest.clearAllMocks());

  it('links and notifies members mentioned in the thread', async () => {
    sanitize.mockReturnValue({
      html: '<p>Watch party, @Naruto and @outsider?</p>',
      empty: false,
    });
    userFind.mockResolvedValue([
      { id: 5, username: 'naruto' },
      { id: 6, username: 'outsider' },
    ]);
    communityFind.mockResolvedValue({
      isPublic: false,
      memberships: [{ userId: 5 }],
    });

    await service.create(1, 3, { title: 'Friday', content: 'x' });

    expect(create.mock.calls[0][0].data.content).toBe(
      '<p>Watch party, <a href="/users/naruto" class="mention">@Naruto</a> and <a href="/users/outsider" class="mention">@outsider</a>?</p>',
    );
    expect(notifications.notify).toHaveBeenCalledWith([
      {
        userId: 5,
        actorId: 1,
        type: 'mention',
        message: 'mentioned you in the thread “Friday”',
        link: '/communities/3?tab=forum&thread=4',
      },
    ]);
  });

  it('starts the thread at 1 with the author’s own upvote', async () => {
    sanitize.mockReturnValue({ html: '', empty: true });

    const thread = await service.create(1, 3, { title: 'Hello' });

    expect(create.mock.calls[0][0].data.score).toBe(1);
    expect(voteCreate).toHaveBeenCalledWith({
      data: {
        userId: 1,
        votableType: 'thread',
        votableId: 4,
        communityId: 3,
        value: 1,
      },
    });
    expect(thread.myVote).toBe(1);
  });

  it('shows the author by their nickname in the community', async () => {
    sanitize.mockReturnValue({ html: '', empty: true });
    membershipFind.mockResolvedValueOnce([
      { communityId: 3, userId: 1, nickname: 'Future Hokage' },
    ]);

    const thread = await service.create(1, 3, { title: 'Hello' });

    expect(thread).toMatchObject({ author: { nickname: 'Future Hokage' } });
  });

  it('saves the link card with the thread', async () => {
    sanitize.mockReturnValue({ html: '<p>Thoughts?</p>', empty: false });

    await service.create(1, 3, {
      title: '  Best arc?  ',
      content: '<p>Thoughts?</p>',
      linkUrl: 'https://youtu.be/dQw4w9WgXcQ',
    });

    expect(create.mock.calls[0][0].data).toMatchObject({
      title: 'Best arc?',
      content: '<p>Thoughts?</p>',
      linkUrl: 'https://youtu.be/dQw4w9WgXcQ',
    });
  });

  it('allows a thread that is only a title and a link', async () => {
    sanitize.mockReturnValue({ html: '', empty: true });

    await service.create(1, 3, {
      title: 'Watch this',
      linkUrl: 'https://example.com',
    });

    expect(create.mock.calls[0][0].data).toMatchObject({
      content: '',
      linkUrl: 'https://example.com',
    });
  });

  it('stores no link when none is given', async () => {
    sanitize.mockReturnValue({ html: '', empty: true });

    await service.create(1, 3, { title: 'Just a question' });

    expect(create.mock.calls[0][0].data.linkUrl).toBeNull();
  });
});
