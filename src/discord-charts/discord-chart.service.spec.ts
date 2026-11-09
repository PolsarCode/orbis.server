import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CommunitiesService } from '../communities/communities.service';
import { CommunityMemberGuard } from '../communities/community-member.guard';
import { LibraryService } from '../library/library.service';
import { PrismaService } from '../prisma.service';
import { DiscordChartPostingService } from './discord-chart-posting.service';
import { DiscordChartService } from './discord-chart.service';
import { DiscordChartsController } from './discord-charts.controller';
import { SendDiscordChartsDto } from './dto/send-discord-charts.dto';
import { UpdateDiscordChartsDto } from './dto/update-discord-charts.dto';

const webhook = {
  id: '111',
  token: 'hook-token',
  guildId: '55',
  channelId: '66',
};

const view = {
  guildId: '55',
  guildName: 'Konoha',
  channelId: '66',
  isForum: false,
  sendAnime: true,
  sendManga: false,
  sendGames: false,
  message: null,
  lostAt: null,
  createdAt: new Date('2026-11-01T00:00:00Z'),
};

function channel(overrides: Record<string, unknown> = {}) {
  return {
    communityId: 7,
    webhookId: '111',
    webhookToken: 'hook-token',
    isForum: false,
    message: null,
    community: { id: 7, name: 'Hidden Leaf Village', iconUrl: null },
    ...overrides,
  };
}

async function errors(
  body: Record<string, unknown>,
  dto: new () => object = UpdateDiscordChartsDto,
) {
  const found = await validate(plainToInstance(dto, body), {
    whitelist: true,
  });
  return found.map(({ property }) => property);
}

describe('Weekly charts in a Discord channel', () => {
  const prisma = {
    discordChartChannel: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    community: { findUnique: jest.fn() },
  };
  const communities = { assertCanManage: jest.fn() };
  const service = new DiscordChartService(
    prisma as unknown as PrismaService,
    communities as unknown as CommunitiesService,
  );
  const library = { chart: jest.fn() };
  const controller = new DiscordChartsController(
    service,
    new DiscordChartPostingService(
      prisma as unknown as PrismaService,
      library as unknown as LibraryService,
      service,
    ),
  );

  const fetchMock = jest.fn();
  const originalFetch = global.fetch;
  const previousWebUrl = process.env.WEB_URL;
  const reply = (status = 200, body: object = { id: '900' }) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const sent = (index: number) => {
    const [url, init] = fetchMock.mock.calls[index];
    return {
      url,
      method: init.method,
      body: init.body && JSON.parse(init.body),
    };
  };

  beforeAll(() => {
    process.env.WEB_URL = 'https://orbis.test';
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    process.env.WEB_URL = previousWebUrl;
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    communities.assertCanManage.mockResolvedValue(undefined);
    prisma.discordChartChannel.findUnique.mockResolvedValue(view);
    prisma.discordChartChannel.updateMany.mockResolvedValue({ count: 1 });
    prisma.discordChartChannel.upsert.mockResolvedValue(channel());
    fetchMock.mockResolvedValue(reply());
  });

  describe('connecting', () => {
    it('saves the webhook and says hello in the channel as the community', async () => {
      prisma.discordChartChannel.findUnique.mockResolvedValue(null);

      await service.connect(1, 7, webhook, 'Konoha');

      expect(communities.assertCanManage).toHaveBeenCalledWith(1, 7);
      const data = {
        webhookId: '111',
        webhookToken: 'hook-token',
        guildId: '55',
        guildName: 'Konoha',
        channelId: '66',
        isForum: false,
        lostAt: null,
      };
      expect(prisma.discordChartChannel.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { communityId: 7 },
          create: { communityId: 7, ...data },
          update: data,
        }),
      );
      const hello = sent(0);
      expect(hello.url).toBe(
        'https://discord.com/api/v10/webhooks/111/hook-token?wait=true&with_components=true',
      );
      expect(hello.body).toMatchObject({
        username: 'Hidden Leaf Village',
        avatar_url: 'https://orbis.test/apple-icon',
        allowed_mentions: { parse: [] },
        embeds: [
          expect.objectContaining({
            description:
              'Weekly charts from Orbis will be posted here every Monday.',
          }),
        ],
      });
    });

    it('works for private communities too', async () => {
      prisma.community.findUnique.mockResolvedValue({ isPublic: false });
      prisma.discordChartChannel.findUnique.mockResolvedValue(null);

      await service.connect(1, 7, webhook, null);

      expect(prisma.discordChartChannel.upsert).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('removes the old webhook when connecting a different channel', async () => {
      prisma.discordChartChannel.findUnique.mockResolvedValue({
        webhookId: '100',
        webhookToken: 'old-token',
      });

      await service.connect(1, 7, webhook, null);

      expect(sent(0)).toMatchObject({
        url: 'https://discord.com/api/v10/webhooks/100/old-token',
        method: 'DELETE',
      });
      expect(sent(1).method).toBe('POST');
    });

    it('switches to forum posts when the channel is a forum', async () => {
      prisma.discordChartChannel.findUnique.mockResolvedValue(null);
      fetchMock.mockResolvedValueOnce(reply(400, { code: 220001 }));

      await service.connect(1, 7, webhook, null);

      expect(prisma.discordChartChannel.updateMany).toHaveBeenCalledWith({
        where: { communityId: 7, webhookId: '111' },
        data: { isForum: true },
      });
      expect(sent(1).body.thread_name).toBe('Connected to Orbis');
    });

    it('marks the connection as lost when Discord already removed the webhook', async () => {
      prisma.discordChartChannel.findUnique.mockResolvedValue(null);
      fetchMock.mockResolvedValueOnce(reply(404, { code: 10015 }));

      await service.connect(1, 7, webhook, null);

      expect(prisma.discordChartChannel.updateMany).toHaveBeenCalledWith({
        where: { communityId: 7, webhookId: '111' },
        data: { lostAt: expect.any(Date) },
      });
    });
  });

  describe('settings', () => {
    it('shows the connection without the webhook secrets', async () => {
      await expect(controller.find(1, 7)).resolves.toEqual({ channel: view });

      const { select } = prisma.discordChartChannel.findUnique.mock.calls[0][0];
      expect(select).not.toHaveProperty('webhookId');
      expect(select).not.toHaveProperty('webhookToken');
    });

    it('shows nothing when no channel is connected', async () => {
      prisma.discordChartChannel.findUnique.mockResolvedValue(null);

      await expect(controller.find(1, 7)).resolves.toEqual({ channel: null });
    });

    it('turns charts on and trims the message', async () => {
      await expect(
        controller.update(1, 7, { sendManga: true, message: '  Hype!  ' }),
      ).resolves.toEqual({ channel: view });

      expect(prisma.discordChartChannel.updateMany).toHaveBeenCalledWith({
        where: { communityId: 7 },
        data: { sendManga: true, message: 'Hype!' },
      });
    });

    it('clears a blank message and leaves a missing one alone', async () => {
      await controller.update(1, 7, { message: '   ' });
      await controller.update(1, 7, { message: null });
      await controller.update(1, 7, { sendGames: false });

      const data = prisma.discordChartChannel.updateMany.mock.calls.map(
        ([args]) => args.data,
      );
      expect(data).toEqual([
        { message: null },
        { message: null },
        { sendGames: false, message: undefined },
      ]);
    });

    it('explains when no channel is connected', async () => {
      prisma.discordChartChannel.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        controller.update(1, 7, { sendAnime: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('removes the webhook from Discord when disconnecting', async () => {
      prisma.discordChartChannel.findUnique.mockResolvedValue({
        webhookId: '111',
        webhookToken: 'hook-token',
      });
      fetchMock.mockResolvedValueOnce(reply(404, { code: 10015 }));

      await expect(controller.disconnect(1, 7)).resolves.toBeUndefined();

      expect(prisma.discordChartChannel.delete).toHaveBeenCalledWith({
        where: { communityId: 7 },
      });
      expect(sent(0)).toMatchObject({
        url: 'https://discord.com/api/v10/webhooks/111/hook-token',
        method: 'DELETE',
      });
    });

    it('explains when there is nothing to disconnect', async () => {
      prisma.discordChartChannel.findUnique.mockResolvedValue(null);

      await expect(controller.disconnect(1, 7)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is only for owners and admins', async () => {
      communities.assertCanManage.mockRejectedValue(new ForbiddenException());

      await expect(controller.find(2, 7)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        controller.update(2, 7, { sendAnime: true }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.disconnect(2, 7)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(controller.send(2, 7, {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.connect(2, 7, webhook, null)).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(communities.assertCanManage).toHaveBeenCalledWith(2, 7);
      expect(prisma.discordChartChannel.findUnique).not.toHaveBeenCalled();
      expect(prisma.discordChartChannel.updateMany).not.toHaveBeenCalled();
      expect(prisma.discordChartChannel.upsert).not.toHaveBeenCalled();
      expect(prisma.discordChartChannel.delete).not.toHaveBeenCalled();
      expect(library.chart).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('needs a signed-in member of the community', () => {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, DiscordChartsController),
      ).toEqual([JwtAuthGuard, CommunityMemberGuard]);
    });

    it('accepts on/off switches and a message up to 500 characters', async () => {
      await expect(
        errors({
          sendAnime: true,
          sendManga: false,
          sendGames: true,
          message: 'a'.repeat(500),
        }),
      ).resolves.toEqual([]);
      await expect(errors({ message: null })).resolves.toEqual([]);
      await expect(errors({})).resolves.toEqual([]);
    });

    it('refuses long messages and anything that isn’t a switch or text', async () => {
      await expect(errors({ message: 'a'.repeat(501) })).resolves.toEqual([
        'message',
      ]);
      await expect(errors({ message: 12 })).resolves.toEqual(['message']);
      await expect(
        errors({ sendAnime: 'yes', sendManga: 1, sendGames: null }),
      ).resolves.toEqual(['sendAnime', 'sendManga']);
    });

    it('sends now with an optional message up to 500 characters', async () => {
      await expect(errors({}, SendDiscordChartsDto)).resolves.toEqual([]);
      await expect(
        errors({ message: 'a'.repeat(500) }, SendDiscordChartsDto),
      ).resolves.toEqual([]);
      await expect(
        errors({ message: 'a'.repeat(501) }, SendDiscordChartsDto),
      ).resolves.toEqual(['message']);
    });
  });
});
