import { BadRequestException } from '@nestjs/common';
import { CommunitiesService } from '../communities/communities.service';
import { PrismaService } from '../prisma.service';
import {
  ACTIVITY_DELAY_MS,
  DiscordChannelService,
} from './discord-channel.service';
import {
  deleteMessage,
  deleteWebhook,
  DiscordError,
  editMessage,
  sendMessage,
} from './discord-webhook';

jest.mock('./discord-webhook', () => ({
  ...jest.requireActual('./discord-webhook'),
  sendMessage: jest.fn(),
  editMessage: jest.fn(),
  deleteMessage: jest.fn(),
  deleteWebhook: jest.fn(),
}));

const person = {
  id: 1,
  username: 'naruto',
  name: 'Naruto Uzumaki',
  avatarUrl: null,
};

function channel(overrides: Record<string, unknown> = {}) {
  return {
    communityId: 7,
    webhookId: '111',
    webhookToken: 'secret-token',
    isForum: false,
    sendPosts: true,
    sendLibrary: true,
    lostAt: null,
    community: {
      id: 7,
      name: 'Hidden Leaf Village',
      iconUrl: null,
      isPublic: true,
    },
    ...overrides,
  };
}

describe('DiscordChannelService', () => {
  const prisma = {
    discordChannel: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      upsert: jest.fn(),
    },
    discordMessage: {
      deleteMany: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
    community: { findUnique: jest.fn() },
    post: { findUnique: jest.fn() },
    libraryEntry: { findUnique: jest.fn() },
    membership: { findMany: jest.fn() },
    $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
  };
  const communities = { assertCanManage: jest.fn() };
  const service = new DiscordChannelService(
    prisma as unknown as PrismaService,
    communities as unknown as CommunitiesService,
  );
  const send = jest.mocked(sendMessage);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.membership.findMany.mockResolvedValue([]);
    prisma.community.findUnique.mockResolvedValue({ isPublic: true });
    prisma.discordMessage.findUnique.mockResolvedValue(null);
    prisma.discordMessage.findMany.mockResolvedValue([]);
    send.mockResolvedValue({ messageId: '900', threadId: null });
  });

  function post(overrides: Record<string, unknown> = {}) {
    return {
      id: 12,
      communityId: 7,
      content: '<p>Believe it!</p>',
      linkUrl: null,
      hiddenAt: null,
      createdAt: new Date(),
      author: person,
      community: { discordChannel: channel() },
      ...overrides,
    };
  }

  it('connects a channel and says hello in it', async () => {
    prisma.discordChannel.findUnique.mockResolvedValue(null);
    prisma.discordChannel.upsert.mockResolvedValue(channel());

    await service.connect(
      1,
      7,
      { id: '111', token: 'secret-token', guildId: '55', channelId: '66' },
      'Konoha',
    );

    expect(communities.assertCanManage).toHaveBeenCalledWith(1, 7);
    expect(prisma.discordMessage.deleteMany).toHaveBeenCalledWith({
      where: { communityId: 7 },
    });
    expect(prisma.discordChannel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { communityId: 7 },
        update: expect.objectContaining({
          webhookId: '111',
          guildId: '55',
          guildName: 'Konoha',
          channelId: '66',
          lostAt: null,
        }),
      }),
    );
    expect(send.mock.calls[0][1]).toMatchObject({
      username: 'Hidden Leaf Village',
      embeds: [expect.objectContaining({ title: 'Connected to Orbis' })],
    });
  });

  it('refuses private communities and removes the webhook Discord made', async () => {
    prisma.community.findUnique.mockResolvedValue({ isPublic: false });
    jest.mocked(deleteWebhook).mockResolvedValue();

    await expect(
      service.connect(
        1,
        7,
        { id: '111', token: 'secret-token', guildId: '55', channelId: '66' },
        null,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(deleteWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ id: '111', token: 'secret-token' }),
    );
    expect(prisma.discordChannel.upsert).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('removes the old webhook when connecting a different channel', async () => {
    prisma.discordChannel.findUnique.mockResolvedValue({
      webhookId: '100',
      webhookToken: 'old-token',
    });
    prisma.discordChannel.upsert.mockResolvedValue(channel());
    jest.mocked(deleteWebhook).mockResolvedValue();

    await service.connect(
      1,
      7,
      { id: '111', token: 'secret-token', guildId: '55', channelId: '66' },
      null,
    );

    expect(deleteWebhook).toHaveBeenCalledWith({
      id: '100',
      token: 'old-token',
    });
  });

  it('switches to forum posts when the channel is a forum', async () => {
    prisma.discordChannel.findUnique.mockResolvedValue(null);
    prisma.discordChannel.upsert.mockResolvedValue(channel());
    send
      .mockRejectedValueOnce(new DiscordError(400, 220001))
      .mockResolvedValueOnce({ messageId: '900', threadId: '77' });

    await service.connect(
      1,
      7,
      { id: '111', token: 'secret-token', guildId: '55', channelId: '66' },
      null,
    );

    expect(prisma.discordChannel.updateMany).toHaveBeenCalledWith({
      where: { communityId: 7, webhookId: '111' },
      data: { isForum: true },
    });
    expect(send.mock.calls[1][2]).toBe('Connected to Orbis');
  });

  it('sends new posts and remembers the message', async () => {
    prisma.post.findUnique.mockResolvedValue(post());

    await service.postCreated(12);

    expect(send.mock.calls[0][0]).toEqual({ id: '111', token: 'secret-token' });
    expect(send.mock.calls[0][1]).toMatchObject({
      username: 'Naruto Uzumaki',
      allowed_mentions: { parse: [] },
    });
    expect(prisma.discordMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          communityId: 7,
          targetType: 'post',
          targetId: 12,
          messageId: '900',
          threadId: null,
        },
      }),
    );
  });

  it('skips posts when feed posts are turned off or the channel was lost', async () => {
    prisma.post.findUnique.mockResolvedValueOnce(
      post({ community: { discordChannel: channel({ sendPosts: false }) } }),
    );
    await service.postCreated(12);

    prisma.post.findUnique.mockResolvedValueOnce(
      post({ community: { discordChannel: channel({ lostAt: new Date() }) } }),
    );
    await service.postCreated(12);

    expect(send).not.toHaveBeenCalled();
  });

  it('stops sending while the community is private', async () => {
    prisma.post.findUnique.mockResolvedValue(
      post({
        community: {
          discordChannel: channel({
            community: {
              id: 7,
              name: 'Hidden Leaf Village',
              iconUrl: null,
              isPublic: false,
            },
          }),
        },
      }),
    );

    await service.postCreated(12);

    expect(send).not.toHaveBeenCalled();
  });

  it('marks the channel as lost when the webhook was deleted in Discord', async () => {
    prisma.post.findUnique.mockResolvedValue(post());
    send.mockRejectedValue(new DiscordError(404, 10015));

    await service.postCreated(12);

    expect(prisma.discordChannel.updateMany).toHaveBeenCalledWith({
      where: { communityId: 7, webhookId: '111' },
      data: { lostAt: expect.any(Date) },
    });
    expect(prisma.discordMessage.upsert).not.toHaveBeenCalled();
  });

  it('deletes the Discord message when moderation hides a post', async () => {
    prisma.discordMessage.findMany.mockResolvedValue([
      {
        id: 3,
        communityId: 7,
        targetId: 12,
        messageId: '900',
        threadId: null,
        channel: channel(),
      },
    ]);

    await service.hiddenChanged('post', 12, true);

    expect(deleteMessage).toHaveBeenCalledWith(
      { id: '111', token: 'secret-token' },
      expect.objectContaining({ messageId: '900', threadId: null }),
    );
    expect(prisma.discordMessage.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [3] } },
    });
  });

  it('sends a restored post again', async () => {
    prisma.post.findUnique.mockResolvedValue(post());

    await service.hiddenChanged('post', 12, false);

    expect(send).toHaveBeenCalledTimes(1);
  });

  describe('library updates', () => {
    function entry(overrides: Record<string, unknown> = {}) {
      return {
        userId: 1,
        isPublic: true,
        isAdult: false,
        mediaType: 'anime',
        title: 'Frieren',
        coverImage: null,
        user: person,
        activities: [
          {
            id: 30,
            status: 'current',
            progressFrom: 3,
            progressTo: 7,
            createdAt: new Date(),
          },
        ],
        ...overrides,
      };
    }

    it('sends to every community where the member shares library updates', async () => {
      prisma.libraryEntry.findUnique.mockResolvedValue(entry());
      prisma.membership.findMany.mockResolvedValue([
        { nickname: 'Hokage', community: { discordChannel: channel() } },
      ]);

      await service.syncEntry(5, false);

      expect(prisma.membership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 1,
            showLibraryUpdates: true,
            community: {
              isPublic: true,
              discordChannel: { lostAt: null, sendLibrary: true },
            },
          },
        }),
      );
      expect(send.mock.calls[0][1]).toMatchObject({
        username: 'Hokage',
        embeds: [
          expect.objectContaining({
            description: 'Watched episodes 3–7 of **Frieren**',
          }),
        ],
      });
    });

    it('edits the message when more progress is merged in', async () => {
      prisma.libraryEntry.findUnique.mockResolvedValue(entry());
      prisma.discordMessage.findMany.mockResolvedValue([
        {
          id: 3,
          communityId: 7,
          targetId: 30,
          messageId: '900',
          threadId: null,
          channel: channel(),
        },
      ]);
      prisma.membership.findMany.mockResolvedValue([
        { nickname: null, community: { discordChannel: channel() } },
      ]);

      await service.syncEntry(5, false);

      expect(send).not.toHaveBeenCalled();
      expect(editMessage).toHaveBeenCalledWith(
        { id: '111', token: 'secret-token' },
        expect.objectContaining({ messageId: '900' }),
        expect.objectContaining({ embeds: expect.any(Array) }),
      );
    });

    it('never sends private or 18+ titles and removes them once hidden', async () => {
      prisma.libraryEntry.findUnique.mockResolvedValue(
        entry({ isPublic: false }),
      );
      prisma.discordMessage.findMany.mockResolvedValue([
        {
          id: 3,
          communityId: 7,
          targetId: 30,
          messageId: '900',
          threadId: null,
          channel: channel(),
        },
      ]);

      await service.syncEntry(5, true);

      expect(send).not.toHaveBeenCalled();
      expect(prisma.membership.findMany).not.toHaveBeenCalled();
      expect(deleteMessage).toHaveBeenCalled();

      jest.clearAllMocks();
      prisma.libraryEntry.findUnique.mockResolvedValue(
        entry({ isAdult: true }),
      );
      prisma.discordMessage.findMany.mockResolvedValue([]);

      await service.syncEntry(5, false);

      expect(send).not.toHaveBeenCalled();
    });

    it('leaves older updates alone', async () => {
      prisma.libraryEntry.findUnique.mockResolvedValue(
        entry({
          activities: [
            {
              id: 30,
              status: 'current',
              progressFrom: 1,
              progressTo: 2,
              createdAt: new Date('2026-01-01T00:00:00Z'),
            },
          ],
        }),
      );
      prisma.membership.findMany.mockResolvedValue([
        { nickname: null, community: { discordChannel: channel() } },
      ]);

      await service.syncEntry(5, false);

      expect(send).not.toHaveBeenCalled();
    });

    it('waits for a burst of changes before updating Discord', async () => {
      jest.useFakeTimers();
      const sync = jest.spyOn(service, 'syncEntry').mockResolvedValue();

      service.entryChanged(5);
      service.entryChanged(5, true);
      service.entryChanged(5);
      jest.advanceTimersByTime(ACTIVITY_DELAY_MS);

      expect(sync).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledWith(5, true);
      sync.mockRestore();
      jest.useRealTimers();
    });

    it('deletes messages for removed library updates', async () => {
      prisma.discordMessage.findMany.mockResolvedValue([
        {
          id: 3,
          communityId: 7,
          targetId: 30,
          messageId: '900',
          threadId: null,
          channel: channel(),
        },
      ]);

      await service.activitiesDeleted([30]);

      expect(prisma.discordMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { targetType: 'activity', targetId: { in: [30] } },
        }),
      );
      expect(deleteMessage).toHaveBeenCalled();
    });
  });

  it('updates the Discord message when a post is edited', async () => {
    prisma.discordMessage.findMany.mockResolvedValue([
      {
        id: 3,
        communityId: 7,
        targetId: 12,
        messageId: '900',
        threadId: null,
        channel: channel(),
      },
    ]);
    prisma.post.findUnique.mockResolvedValue(
      post({ content: '<p>Edited</p>' }),
    );

    await service.contentEdited('post', 12);

    expect(editMessage).toHaveBeenCalledWith(
      { id: '111', token: 'secret-token' },
      expect.objectContaining({ messageId: '900' }),
      expect.objectContaining({
        embeds: [expect.objectContaining({ description: 'Edited' })],
      }),
    );
  });

  it('removes the Discord message when a post is deleted', async () => {
    prisma.discordMessage.findMany.mockResolvedValue([
      {
        id: 3,
        communityId: 7,
        targetId: 12,
        messageId: '900',
        threadId: null,
        channel: channel(),
      },
    ]);

    await service.contentDeleted('post', 12);

    expect(deleteMessage).toHaveBeenCalled();
    expect(prisma.discordMessage.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [3] } },
    });
  });

  it('removes the webhook from Discord when disconnecting', async () => {
    prisma.discordChannel.findUnique.mockResolvedValue({
      webhookId: '111',
      webhookToken: 'secret-token',
    });
    jest.mocked(deleteWebhook).mockResolvedValue();

    await service.disconnect(1, 7);

    expect(prisma.discordChannel.delete).toHaveBeenCalledWith({
      where: { communityId: 7 },
    });
    expect(deleteWebhook).toHaveBeenCalledWith({
      id: '111',
      token: 'secret-token',
    });
  });
});
