import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CommunitiesService } from '../communities/communities.service';
import {
  Channel,
  ChannelMessage,
  IncomingWebhook,
  sendToChannel,
} from '../discord-channel/discord-channel.service';
import {
  chartsConnectedMessage,
  MessageCommunity,
} from '../discord-channel/discord-message';
import {
  deleteWebhook,
  DiscordError,
  WebhookFile,
} from '../discord-channel/discord-webhook';
import { PrismaService } from '../prisma.service';

export type DiscordChartSettings = {
  sendAnime?: boolean;
  sendManga?: boolean;
  sendGames?: boolean;
  message?: string | null;
};

export type ChartChannel = Channel & {
  message: string | null;
  community: MessageCommunity;
};

const viewSelect = {
  guildId: true,
  guildName: true,
  channelId: true,
  isForum: true,
  sendAnime: true,
  sendManga: true,
  sendGames: true,
  message: true,
  lostAt: true,
  createdAt: true,
} as const;

export const chartChannelSelect = {
  communityId: true,
  webhookId: true,
  webhookToken: true,
  isForum: true,
  message: true,
  community: { select: { id: true, name: true, iconUrl: true } },
} as const;

const NOT_CONNECTED = 'No Discord channel is connected for charts';

@Injectable()
export class DiscordChartService {
  private readonly logger = new Logger(DiscordChartService.name);

  constructor(
    private prisma: PrismaService,
    private communities: CommunitiesService,
  ) {}

  async find(userId: number, communityId: number) {
    await this.communities.assertCanManage(userId, communityId);
    return this.prisma.discordChartChannel.findUnique({
      where: { communityId },
      select: viewSelect,
    });
  }

  async update(
    userId: number,
    communityId: number,
    { message, ...settings }: DiscordChartSettings,
  ) {
    await this.communities.assertCanManage(userId, communityId);
    const { count } = await this.prisma.discordChartChannel.updateMany({
      where: { communityId },
      data: {
        ...settings,
        message: message === undefined ? undefined : message?.trim() || null,
      },
    });
    if (count === 0) throw new NotFoundException(NOT_CONNECTED);
    return this.prisma.discordChartChannel.findUnique({
      where: { communityId },
      select: viewSelect,
    });
  }

  async disconnect(userId: number, communityId: number) {
    await this.communities.assertCanManage(userId, communityId);
    const channel = await this.prisma.discordChartChannel.findUnique({
      where: { communityId },
      select: { webhookId: true, webhookToken: true },
    });
    if (!channel) throw new NotFoundException(NOT_CONNECTED);

    await this.prisma.discordChartChannel.delete({ where: { communityId } });
    await deleteWebhook({
      id: channel.webhookId,
      token: channel.webhookToken,
    }).catch((error) => this.warn(communityId, error));
  }

  async connect(
    userId: number,
    communityId: number,
    webhook: IncomingWebhook,
    guildName: string | null,
  ) {
    await this.communities.assertCanManage(userId, communityId);
    const previous = await this.prisma.discordChartChannel.findUnique({
      where: { communityId },
      select: { webhookId: true, webhookToken: true },
    });

    const data = {
      webhookId: webhook.id,
      webhookToken: webhook.token,
      guildId: webhook.guildId,
      guildName,
      channelId: webhook.channelId,
      isForum: false,
      lostAt: null,
    };
    const channel = await this.prisma.discordChartChannel.upsert({
      where: { communityId },
      create: { communityId, ...data },
      update: data,
      select: chartChannelSelect,
    });

    if (previous && previous.webhookId !== webhook.id) {
      await deleteWebhook({
        id: previous.webhookId,
        token: previous.webhookToken,
      }).catch((error) => this.warn(communityId, error));
    }

    try {
      await this.send(channel, chartsConnectedMessage(channel.community));
    } catch (error) {
      await this.failed(channel, error);
    }
  }

  send(channel: Channel, message: ChannelMessage, file?: WebhookFile) {
    return sendToChannel(
      channel,
      message,
      () =>
        this.prisma.discordChartChannel.updateMany({
          where: {
            communityId: channel.communityId,
            webhookId: channel.webhookId,
          },
          data: { isForum: true },
        }),
      file,
    );
  }

  async failed(channel: Channel, error: unknown) {
    if (error instanceof DiscordError && error.webhookGone) {
      await this.prisma.discordChartChannel.updateMany({
        where: {
          communityId: channel.communityId,
          webhookId: channel.webhookId,
        },
        data: { lostAt: new Date() },
      });
      return;
    }
    this.warn(channel.communityId, error);
  }

  private warn(communityId: number, error: unknown) {
    this.logger.warn(
      `Discord chart channel for community ${communityId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
