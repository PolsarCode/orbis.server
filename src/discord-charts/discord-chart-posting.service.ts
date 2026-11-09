import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { MediaType, Prisma } from '../../prisma/generated/client';
import { GUEST_USER_ID } from '../auth/allow-guest';
import { isUniqueViolation } from '../common/prisma-errors';
import { DAY, MINUTE } from '../common/throttle';
import { webUrl } from '../common/web-url';
import {
  absoluteUrl,
  communityIdentity,
} from '../discord-channel/discord-message';
import {
  DiscordError,
  SentMessage,
  WebhookFile,
} from '../discord-channel/discord-webhook';
import { chartPath } from '../library/chart-link';
import { LibraryService } from '../library/library.service';
import { PrismaService } from '../prisma.service';
import {
  ChartChannel,
  chartChannelSelect,
  DiscordChartService,
} from './discord-chart.service';

const POST_MS = 10 * MINUTE;
const POST_LOCK = 727_012_051;
const POST_WINDOW_MS = DAY;
const IMAGE_TIMEOUT_MS = 30_000;
const SUPPRESS_EMBEDS = 1 << 2;

const ENABLED: Record<MediaType, Prisma.DiscordChartChannelWhereInput> = {
  anime: { sendAnime: true },
  manga: { sendManga: true },
  game: { sendGames: true },
};

const LABELS: Record<MediaType, string> = {
  anime: 'Anime',
  manga: 'Manga',
  game: 'Games',
};

const day = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const dayWithYear = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

type Week = { week: string; startsAt: string; endsAt: string };

function weekRange({ startsAt, endsAt }: Week) {
  const start = new Date(startsAt);
  const end = new Date(Date.parse(endsAt) - 1);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  return `${(sameYear ? day : dayWithYear).format(start)} – ${dayWithYear.format(end)}`;
}

export function fillMessage(message: string, type: MediaType, chart: Week) {
  const values: Record<string, string> = {
    type: LABELS[type],
    date: dayWithYear.format(new Date(chart.startsAt)),
    dates: weekRange(chart),
    week: String(Number(chart.week.slice(6))),
    year: chart.week.slice(0, 4),
  };
  return message.replace(
    /\{(\w+)\}/g,
    (match, name: string) => values[name.toLowerCase()] ?? match,
  );
}

function chartMessage(type: MediaType, chart: Week, channel: ChartChannel) {
  const link = absoluteUrl(chartPath(type, chart.week));
  const message = channel.message && fillMessage(channel.message, type, chart);
  return {
    identity: communityIdentity(channel.community),
    body: {
      content: `${message ? `${message}\n\n` : ''}Join the discussion at ${link}`,
      allowed_mentions: { parse: ['everyone'] },
      flags: SUPPRESS_EMBEDS,
    },
    threadName: `${LABELS[type]} · ${weekRange(chart)}`,
  };
}

@Injectable()
export class DiscordChartPostingService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DiscordChartPostingService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private images = new Map<MediaType, { week: string; data: Buffer }>();

  constructor(
    private prisma: PrismaService,
    private library: LibraryService,
    private discordCharts: DiscordChartService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.run(), POST_MS);
    this.timer.unref();
    void this.run();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${POST_LOCK}::bigint) AS locked
          `;
          if (locked) await this.postDue();
        },
        { timeout: POST_MS },
      );
    } catch (error) {
      this.logger.warn(
        `Posting weekly charts to Discord failed: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async postDue() {
    for (const type of Object.values(MediaType)) {
      try {
        await this.postChart(type);
      } catch (error) {
        this.logger.warn(
          `Couldn’t post the ${type} chart to Discord: ${(error as Error).message}`,
        );
      }
    }
  }

  private async postChart(type: MediaType) {
    const enabled = { lostAt: null, ...ENABLED[type] };
    const connected = await this.prisma.discordChartChannel.count({
      where: enabled,
    });
    if (connected === 0) return;

    const chart = await this.library.chart(GUEST_USER_ID, type);
    const sinceStart = Date.now() - Date.parse(chart.startsAt);
    if (!(sinceStart >= 0 && sinceStart < POST_WINDOW_MS)) return;

    const channels = await this.prisma.discordChartChannel.findMany({
      where: {
        ...enabled,
        community: {
          discordChartPosts: { none: { mediaType: type, week: chart.week } },
        },
      },
      orderBy: { createdAt: 'asc' },
      select: chartChannelSelect,
    });
    if (channels.length === 0) return;

    const file = {
      filename: `orbis-${type}-chart-${chart.startsAt.slice(0, 10)}.png`,
      data: await this.image(type, chart.week),
      description: `${LABELS[type]} chart · ${weekRange(chart)}`,
    };
    for (const channel of channels) {
      await this.post(channel, type, chart, file);
    }
  }

  private async image(type: MediaType, week: string) {
    const cached = this.images.get(type);
    if (cached?.week === week) return cached.data;

    const response = await fetch(
      `${webUrl()}/charts/${type}/image?${new URLSearchParams({ week })}`,
      { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) },
    );
    if (
      !response.ok ||
      !response.headers.get('content-type')?.startsWith('image/')
    ) {
      throw new Error(`Chart image request failed with ${response.status}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    this.images.set(type, { week, data });
    return data;
  }

  private async post(
    channel: ChartChannel,
    type: MediaType,
    chart: Week,
    file: WebhookFile,
  ) {
    const key = {
      communityId: channel.communityId,
      mediaType: type,
      week: chart.week,
    };
    try {
      await this.prisma.discordChartPost.create({ data: key });
    } catch (error) {
      if (isUniqueViolation(error)) return;
      throw error;
    }

    let sent: SentMessage;
    try {
      sent = await this.discordCharts.send(
        channel,
        chartMessage(type, chart, channel),
        file,
      );
    } catch (error) {
      if (canRetry(error)) {
        await this.prisma.discordChartPost.deleteMany({ where: key });
      }
      await this.discordCharts.failed(channel, error);
      return;
    }
    await this.prisma.discordChartPost.update({
      where: { communityId_mediaType_week: key },
      data: { messageId: sent.messageId },
    });
  }
}

function canRetry(error: unknown) {
  return (
    error instanceof DiscordError &&
    (error.status === 429 || error.status >= 500 || error.webhookGone)
  );
}
