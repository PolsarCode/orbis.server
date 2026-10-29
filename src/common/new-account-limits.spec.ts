import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PostsService } from '../posts/posts.service';
import { CommentsService } from '../comments/comments.service';
import { CommunitiesService } from '../communities/communities.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LikesService } from '../likes/likes.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';
import { StorageService } from '../storage/storage.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { TwitchLiveService } from '../friends/twitch-live.service';

jest.mock('../common/rich-text', () => ({
  sanitizeRichText: (html: string) => ({
    html,
    empty: !html.replace(/<[^>]+>/g, '').trim(),
  }),
}));

const HOUR = 60 * 60 * 1000;
const saved = new Error('saved');
const newAccount = {
  createdAt: new Date(Date.now() - 2 * HOUR),
  isAdmin: false,
  email: 'new@anime.test',
};
const olderAccount = {
  createdAt: new Date(Date.now() - 48 * HOUR),
  isAdmin: false,
  email: 'old@anime.test',
};
const newAdmin = { ...newAccount, isAdmin: true };
const link = '<p>Watch here: https://spam.test</p>';

describe('Limits for new accounts', () => {
  const prisma = {
    user: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    post: { findUnique: jest.fn(), update: jest.fn() },
    comment: { findUnique: jest.fn(), update: jest.fn() },
    community: { count: jest.fn() },
    membership: { count: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  const discordChannel = {} as DiscordChannelService;
  const notifications = {
    notify: jest.fn(),
  } as unknown as NotificationsService;
  const posts = new PostsService(
    prisma as unknown as PrismaService,
    notifications,
    {} as LikesService,
    discordChannel,
  );
  const comments = new CommentsService(
    prisma as unknown as PrismaService,
    {} as LikesService,
    notifications,
  );
  const communities = new CommunitiesService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    {} as PresenceGateway,
    {} as TwitchLiveService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.post.findUnique.mockResolvedValue({ authorId: 1, content: '' });
    prisma.post.update.mockRejectedValue(saved);
    prisma.comment.findUnique.mockResolvedValue({
      authorId: 1,
      content: '',
      deletedAt: null,
    });
    prisma.comment.update.mockRejectedValue(saved);
    prisma.$transaction.mockRejectedValue(saved);
    prisma.community.count.mockRejectedValue(saved);
  });

  const cases: [string, () => Promise<unknown>][] = [
    ['posts', () => posts.update(1, 4, { content: link })],
    [
      'post link previews',
      () =>
        posts.update(1, 4, {
          content: '<p>look</p>',
          linkUrl: 'https://spam.test',
        }),
    ],
    ['comments', () => comments.update(1, 8, { content: link })],
  ];

  it.each(cases)(
    'refuses links in %s from accounts under a day old',
    async (_name, run) => {
      prisma.user.findUnique.mockResolvedValue(newAccount);
      await expect(run()).rejects.toMatchObject({
        response: { code: 'account_too_new' },
      });
    },
  );

  it.each(cases)(
    'allows links in %s from older accounts',
    async (_name, run) => {
      prisma.user.findUnique.mockResolvedValue(olderAccount);
      await expect(run()).rejects.toBe(saved);
    },
  );

  it('allows links from new admin accounts', async () => {
    prisma.user.findUnique.mockResolvedValue(newAdmin);
    await expect(posts.update(1, 4, { content: link })).rejects.toBe(saved);
  });

  it('does not look up the account when there is no link', async () => {
    await expect(
      posts.update(1, 4, { content: '<p>Episode 3 was great</p>' }),
    ).rejects.toBe(saved);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('refuses community creation from accounts under a day old', async () => {
    prisma.user.findUnique.mockResolvedValue(newAccount);
    const creating = communities.create(1, { name: 'Spam club' });
    await expect(creating).rejects.toThrow(ForbiddenException);
    await expect(creating).rejects.toMatchObject({
      response: { code: 'account_too_new' },
    });
    expect(prisma.community.count).not.toHaveBeenCalled();
  });

  it('lets older accounts create communities', async () => {
    prisma.user.findUnique.mockResolvedValue(olderAccount);
    await expect(communities.create(1, { name: 'Reading club' })).rejects.toBe(
      saved,
    );
  });
});
