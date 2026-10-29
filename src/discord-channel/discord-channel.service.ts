import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { CommentableType } from '../../prisma/generated/client';
import { author } from '../common/author';
import { CommunitiesService } from '../communities/communities.service';
import { loadNicknames } from '../communities/nicknames';
import { PrismaService } from '../prisma.service';
import {
  activityMessage,
  connectedMessage,
  MessageAuthor,
  MessageCommunity,
  postMessage,
  RenderedMessage,
} from './discord-message';
import {
  deleteMessage,
  deleteWebhook,
  DiscordError,
  editMessage,
  SentMessage,
  sendMessage,
  Webhook,
} from './discord-webhook';

export type IncomingWebhook = {
  id: string;
  token: string;
  guildId: string;
  channelId: string;
};

export type DiscordChannelSettings = {
  sendPosts?: boolean;
  sendLibrary?: boolean;
};

const viewSelect = {
  guildId: true,
  guildName: true,
  channelId: true,
  isForum: true,
  sendPosts: true,
  sendLibrary: true,
  lostAt: true,
  createdAt: true,
} as const;

const channelSelect = {
  communityId: true,
  webhookId: true,
  webhookToken: true,
  isForum: true,
  sendPosts: true,
  sendLibrary: true,
  lostAt: true,
  community: {
    select: { id: true, name: true, iconUrl: true, isPublic: true },
  },
} as const;

const rowSelect = {
  id: true,
  communityId: true,
  targetId: true,
  messageId: true,
  threadId: true,
  channel: {
    select: {
      communityId: true,
      webhookId: true,
      webhookToken: true,
      isForum: true,
    },
  },
} as const;

type Channel = {
  communityId: number;
  webhookId: string;
  webhookToken: string;
  isForum: boolean;
};

type SendingChannel = Channel & {
  sendPosts: boolean;
  sendLibrary: boolean;
  lostAt: Date | null;
  community: MessageCommunity & { isPublic: boolean };
};

export const PRIVATE_COMMUNITY =
  'Discord channels are only for public communities';

export const ACTIVITY_DELAY_MS = 5_000;
const RECENT_ACTIVITY_MS = 10 * 60 * 1000;

const webhookOf = (channel: Channel): Webhook => ({
  id: channel.webhookId,
  token: channel.webhookToken,
});

@Injectable()
export class DiscordChannelService implements OnModuleDestroy {
  private readonly logger = new Logger(DiscordChannelService.name);
  private readonly pending = new Map<
    number,
    { timer: NodeJS.Timeout; visibilityChanged: boolean }
  >();

  constructor(
    private prisma: PrismaService,
    private communities: CommunitiesService,
  ) {}

  onModuleDestroy() {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  async find(userId: number, communityId: number) {
    await this.communities.assertCanManage(userId, communityId);
    return this.prisma.discordChannel.findUnique({
      where: { communityId },
      select: viewSelect,
    });
  }

  async update(
    userId: number,
    communityId: number,
    settings: DiscordChannelSettings,
  ) {
    await this.communities.assertCanManage(userId, communityId);
    const { count } = await this.prisma.discordChannel.updateMany({
      where: { communityId },
      data: settings,
    });
    if (count === 0) {
      throw new NotFoundException('No Discord channel is connected');
    }
    return this.prisma.discordChannel.findUnique({
      where: { communityId },
      select: viewSelect,
    });
  }

  async disconnect(userId: number, communityId: number) {
    await this.communities.assertCanManage(userId, communityId);
    const channel = await this.prisma.discordChannel.findUnique({
      where: { communityId },
      select: { webhookId: true, webhookToken: true },
    });
    if (!channel)
      throw new NotFoundException('No Discord channel is connected');

    await this.prisma.discordChannel.delete({ where: { communityId } });
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
    const community = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: { isPublic: true },
    });
    if (!community?.isPublic) {
      await deleteWebhook(webhook).catch((error) =>
        this.warn(communityId, error),
      );
      throw new BadRequestException(PRIVATE_COMMUNITY);
    }
    const previous = await this.prisma.discordChannel.findUnique({
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
    const [, channel] = await this.prisma.$transaction([
      this.prisma.discordMessage.deleteMany({ where: { communityId } }),
      this.prisma.discordChannel.upsert({
        where: { communityId },
        create: { communityId, ...data },
        update: data,
        select: channelSelect,
      }),
    ]);

    if (previous && previous.webhookId !== webhook.id) {
      await deleteWebhook({
        id: previous.webhookId,
        token: previous.webhookToken,
      }).catch((error) => this.warn(communityId, error));
    }

    try {
      await this.send(channel, connectedMessage(channel.community));
    } catch (error) {
      await this.failed(channel, error);
    }
  }

  async postCreated(postId: number) {
    try {
      await this.sendPost(postId);
    } catch (error) {
      this.logger.warn(
        `Couldn’t send post ${postId} to Discord: ${String(error)}`,
      );
    }
  }

  async hiddenChanged(type: 'post', id: number, hidden: boolean) {
    try {
      if (hidden) await this.remove(type, [id]);
      else await this.sendPost(id);
    } catch (error) {
      this.logger.warn(
        `Couldn’t update ${type} ${id} on Discord: ${String(error)}`,
      );
    }
  }

  async contentEdited(type: 'post', id: number) {
    try {
      const rows = await this.prisma.discordMessage.findMany({
        where: { targetType: type, targetId: id },
        select: rowSelect,
      });
      if (rows.length === 0) return;
      const rendered = await this.renderPost(id);
      if (!rendered) return;
      for (const row of rows) {
        try {
          await editMessage(webhookOf(row.channel), row, rendered.message.body);
        } catch (error) {
          await this.failed(row.channel, error);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Couldn’t update ${type} ${id} on Discord: ${String(error)}`,
      );
    }
  }

  async contentDeleted(type: 'post', id: number) {
    try {
      await this.remove(type, [id]);
    } catch (error) {
      this.logger.warn(
        `Couldn’t remove ${type} ${id} from Discord: ${String(error)}`,
      );
    }
  }

  async activitiesDeleted(ids: number[]) {
    if (ids.length === 0) return;
    try {
      await this.remove('activity', ids);
    } catch (error) {
      this.logger.warn(
        `Couldn’t remove library updates from Discord: ${String(error)}`,
      );
    }
  }

  entryChanged(entryId: number, visibilityChanged = false) {
    const pending = this.pending.get(entryId);
    if (pending) clearTimeout(pending.timer);
    const changed = visibilityChanged || (pending?.visibilityChanged ?? false);
    const timer = setTimeout(() => {
      this.pending.delete(entryId);
      this.syncEntry(entryId, changed).catch((error) =>
        this.logger.warn(
          `Couldn’t update library entry ${entryId} on Discord: ${String(error)}`,
        ),
      );
    }, ACTIVITY_DELAY_MS);
    timer.unref();
    this.pending.set(entryId, { timer, visibilityChanged: changed });
  }

  async syncEntry(entryId: number, visibilityChanged: boolean) {
    const entry = await this.prisma.libraryEntry.findUnique({
      where: { id: entryId },
      select: {
        userId: true,
        isPublic: true,
        isAdult: true,
        mediaType: true,
        title: true,
        coverImage: true,
        user: author,
        activities: {
          select: {
            id: true,
            status: true,
            progressFrom: true,
            progressTo: true,
            createdAt: true,
          },
        },
      },
    });
    if (!entry || entry.activities.length === 0) return;

    const rows = await this.prisma.discordMessage.findMany({
      where: {
        targetType: 'activity',
        targetId: { in: entry.activities.map(({ id }) => id) },
      },
      select: rowSelect,
    });
    const since = Date.now() - RECENT_ACTIVITY_MS;
    const recent = entry.activities.filter(
      ({ createdAt }) => createdAt.getTime() >= since,
    );

    if (!entry.isPublic || entry.isAdult) {
      if (!visibilityChanged) {
        const ids = new Set(recent.map(({ id }) => id));
        await this.removeRows(rows.filter(({ targetId }) => ids.has(targetId)));
      } else {
        await this.removeRows(rows);
      }
      return;
    }
    if (recent.length === 0) return;

    const memberships = await this.prisma.membership.findMany({
      where: {
        userId: entry.userId,
        showLibraryUpdates: true,
        community: {
          isPublic: true,
          discordChannel: { lostAt: null, sendLibrary: true },
        },
      },
      select: {
        nickname: true,
        community: { select: { discordChannel: { select: channelSelect } } },
      },
    });

    for (const activity of recent) {
      for (const { nickname, community } of memberships) {
        const channel = community.discordChannel;
        if (!channel) continue;
        const message = activityMessage(
          {
            ...activity,
            author: { ...entry.user, nickname },
            media: {
              type: entry.mediaType,
              title: entry.title,
              coverImage: entry.coverImage,
            },
          },
          channel.community,
        );
        const row = rows.find(
          (candidate) =>
            candidate.targetId === activity.id &&
            candidate.communityId === channel.communityId,
        );
        if (row) {
          try {
            await editMessage(webhookOf(channel), row, message.body);
          } catch (error) {
            await this.failed(channel, error);
          }
        } else {
          await this.deliver(channel, 'activity', activity.id, message);
        }
      }
    }
  }

  private async renderPost(postId: number) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: {
        id: true,
        content: true,
        linkUrl: true,
        hiddenAt: true,
        createdAt: true,
        author,
        community: { select: { discordChannel: { select: channelSelect } } },
      },
    });
    const channel = post?.community?.discordChannel;
    if (!post || !channel) return null;

    const withAuthor = await this.withNickname(
      channel.communityId,
      post.author,
    );
    return {
      channel,
      hidden: post.hiddenAt !== null,
      enabled: channel.sendPosts,
      message: postMessage({ ...post, author: withAuthor }, channel.community),
    };
  }

  private async sendPost(postId: number) {
    await this.sendRendered('post', postId, await this.renderPost(postId));
  }

  private async sendRendered(
    type: 'post',
    id: number,
    rendered: Awaited<ReturnType<DiscordChannelService['renderPost']>>,
  ) {
    if (
      !rendered ||
      rendered.hidden ||
      !rendered.enabled ||
      rendered.channel.lostAt ||
      !rendered.channel.community.isPublic
    ) {
      return;
    }
    await this.deliver(rendered.channel, type, id, rendered.message);
  }

  private async withNickname(
    communityId: number,
    person: MessageAuthor & { id: number },
  ) {
    const withNickname = await loadNicknames(this.prisma, [
      { communityId, userId: person.id },
    ]);
    return withNickname(communityId, person);
  }

  private async deliver(
    channel: SendingChannel,
    targetType: CommentableType,
    targetId: number,
    message: RenderedMessage,
  ) {
    const key = {
      communityId_targetType_targetId: {
        communityId: channel.communityId,
        targetType,
        targetId,
      },
    };
    const existing = await this.prisma.discordMessage.findUnique({
      where: key,
      select: { id: true },
    });
    if (existing) return;

    let sent: SentMessage;
    try {
      sent = await this.send(channel, message);
    } catch (error) {
      await this.failed(channel, error);
      return;
    }
    await this.prisma.discordMessage.upsert({
      where: key,
      create: { ...key.communityId_targetType_targetId, ...sent },
      update: sent,
    });
  }

  private async send(channel: Channel, message: RenderedMessage) {
    const webhook = webhookOf(channel);
    const body = { ...message.body, ...message.identity };
    const threadName = () => (channel.isForum ? message.threadName : undefined);
    try {
      return await sendMessage(webhook, body, threadName());
    } catch (error) {
      if (!(error instanceof DiscordError)) throw error;
      if (error.needsThread && !channel.isForum) {
        channel.isForum = true;
        await this.prisma.discordChannel.updateMany({
          where: {
            communityId: channel.communityId,
            webhookId: channel.webhookId,
          },
          data: { isForum: true },
        });
        return sendMessage(webhook, body, threadName());
      }
      if (error.invalidBody) {
        return sendMessage(
          webhook,
          { ...message.body, username: 'Orbis' },
          threadName(),
        );
      }
      throw error;
    }
  }

  private async remove(targetType: CommentableType, ids: number[]) {
    const rows = await this.prisma.discordMessage.findMany({
      where: { targetType, targetId: { in: ids } },
      select: rowSelect,
    });
    await this.removeRows(rows);
  }

  private async removeRows(
    rows: {
      id: number;
      messageId: string;
      threadId: string | null;
      channel: Channel;
    }[],
  ) {
    const removed: number[] = [];
    for (const row of rows) {
      try {
        await deleteMessage(webhookOf(row.channel), row);
        removed.push(row.id);
      } catch (error) {
        if (error instanceof DiscordError && error.webhookGone) {
          removed.push(row.id);
        }
        await this.failed(row.channel, error);
      }
    }
    if (removed.length > 0) {
      await this.prisma.discordMessage.deleteMany({
        where: { id: { in: removed } },
      });
    }
  }

  private async failed(channel: Channel, error: unknown) {
    if (error instanceof DiscordError && error.webhookGone) {
      await this.prisma.discordChannel.updateMany({
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
      `Discord channel for community ${communityId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
