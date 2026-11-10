import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { MediaType } from '../../prisma/generated/client';
import { isUniqueViolation } from '../common/prisma-errors';
import { MINUTE } from '../common/throttle';
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
import {
  CHART_LABELS,
  CHART_TYPES,
  ChartShareService,
  ChartWeek,
  fullDate,
  typeList,
  weekRange,
} from '../library/chart-share.service';
import { PrismaService } from '../prisma.service';
import { runLocked } from '../common/locked-job';
import {
  ChartChannel,
  DiscordChartService,
  sendingSelect,
} from './discord-chart.service';

const POST_MS = 10 * MINUTE;
const POST_LOCK = 727_012_051;
const SUPPRESS_EMBEDS = 1 << 2;
const CHANNEL_LOST =
  'This channel was disconnected in Discord. Connect it again first';

const SWITCHES = {
  anime: 'sendAnime',
  manga: 'sendManga',
  game: 'sendGames',
} as const satisfies Record<MediaType, string>;

type Chart = { type: MediaType; chart: ChartWeek };
type Attached = Chart & { file: WebhookFile };
type Switches = Record<(typeof SWITCHES)[MediaType], boolean>;

const switchedOn = (channel: Switches) =>
  CHART_TYPES.filter((type) => channel[SWITCHES[type]]);

export function fillMessage(
  message: string,
  types: MediaType[],
  chart: ChartWeek,
) {
  const values: Record<string, string> = {
    type: typeList(types),
    date: fullDate(chart.startsAt),
    dates: weekRange(chart),
    week: String(Number(chart.week.slice(6))),
    year: chart.week.slice(0, 4),
  };
  return message.replace(
    /\{(\w+)\}/g,
    (match, name: string) => values[name.toLowerCase()] ?? match,
  );
}

function discussionLinks(charts: Chart[]) {
  const links = charts.map(({ type, chart }) => ({
    label: CHART_LABELS[type],
    url: absoluteUrl(chartPath(type, chart.week)),
  }));
  if (links.length === 1) return `[Join the discussion](${links[0].url})`;
  return `Join the discussion: ${links
    .map(({ label, url }) => `[${label}](${url})`)
    .join(' · ')}`;
}

function chartMessage(charts: Chart[], channel: ChartChannel) {
  const types = charts.map(({ type }) => type);
  const { chart } = charts[0];
  const message = channel.message && fillMessage(channel.message, types, chart);
  return {
    identity: communityIdentity(channel.community),
    body: {
      content: `${message ? `${message}\n\n` : ''}${discussionLinks(charts)}`,
      allowed_mentions: { parse: ['everyone'] },
      flags: SUPPRESS_EMBEDS,
    },
    threadName: `${typeList(types)} · ${weekRange(chart)}`,
  };
}

@Injectable()
export class DiscordChartPostingService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DiscordChartPostingService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private prisma: PrismaService,
    private charts: ChartShareService,
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
      await runLocked(this.prisma, POST_LOCK, POST_MS, () => this.postDue());
    } catch (error) {
      this.logger.warn(
        `Posting weekly charts to Discord failed: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async postDue() {
    const channels = await this.prisma.discordChartChannel.findMany({
      where: {
        lostAt: null,
        OR: CHART_TYPES.map((type) => ({ [SWITCHES[type]]: true })),
      },
      orderBy: { createdAt: 'asc' },
      select: sendingSelect,
    });
    if (channels.length === 0) return;

    const charts = await this.charts.startedToday(
      CHART_TYPES.filter((type) =>
        channels.some((channel) => channel[SWITCHES[type]]),
      ),
    );
    if (charts.size === 0) return;

    const posted = await this.prisma.discordChartPost.findMany({
      where: {
        communityId: { in: channels.map(({ communityId }) => communityId) },
        OR: [...charts].flatMap(([type, chart]) =>
          chart ? [{ mediaType: type, week: chart.week }] : [],
        ),
      },
      select: { communityId: true, mediaType: true },
    });
    const done = new Set(
      posted.map(({ communityId, mediaType }) => `${communityId}:${mediaType}`),
    );

    const files = new Map<MediaType, Promise<WebhookFile>>();
    const fileFor = ({ type, chart }: Chart) => {
      if (!files.has(type)) {
        const file = this.charts.image(type, chart);
        file.catch((error: Error) =>
          this.logger.warn(
            `Couldn’t load the ${type} chart image: ${error.message}`,
          ),
        );
        files.set(type, file);
      }
      return files.get(type)!;
    };

    for (const channel of channels) {
      const due = switchedOn(channel).filter(
        (type) =>
          charts.has(type) && !done.has(`${channel.communityId}:${type}`),
      );
      if (due.length === 0 || due.some((type) => !charts.get(type))) continue;

      const dueCharts = due.map((type) => ({ type, chart: charts.get(type)! }));
      let attached: Attached[];
      try {
        attached = await Promise.all(
          dueCharts.map(async (chart) => ({
            ...chart,
            file: await fileFor(chart),
          })),
        );
      } catch {
        continue;
      }
      try {
        await this.post(channel, attached);
      } catch (error) {
        this.logger.warn(
          `Couldn’t post the weekly charts for community ${channel.communityId}: ${(error as Error).message}`,
        );
      }
    }
  }

  async sendNow(userId: number, communityId: number, message?: string | null) {
    const saved = await this.discordCharts.findForSending(userId, communityId);
    const channel =
      message === undefined
        ? saved
        : { ...saved, message: message?.trim() || null };
    if (channel.lostAt) {
      throw new BadRequestException(CHANNEL_LOST);
    }
    const types = switchedOn(channel);
    if (types.length === 0) {
      throw new BadRequestException('Turn on at least one chart first');
    }

    const attached: Attached[] = [];
    for (const type of types) {
      const chart = await this.charts.current(type);
      const file = await this.charts
        .image(type, chart)
        .catch((error: Error) => {
          this.logger.warn(
            `Couldn’t load the ${type} chart image: ${error.message}`,
          );
          throw new BadGatewayException(
            'Couldn’t make the chart image. Try again in a moment',
          );
        });
      attached.push({ type, chart, file });
    }

    try {
      await this.discordCharts.send(
        channel,
        chartMessage(attached, channel),
        attached.map(({ file }) => file),
      );
    } catch (error) {
      await this.discordCharts.failed(channel, error);
      if (error instanceof DiscordError && error.webhookGone) {
        throw new BadRequestException(CHANNEL_LOST);
      }
      throw new BadGatewayException(
        'Discord didn’t accept the post. Try again in a moment',
      );
    }
  }

  private async post(channel: ChartChannel, charts: Attached[]) {
    const keyOf = ({ type, chart }: Chart) => ({
      mediaType: type,
      week: chart.week,
    });
    const claimed: Attached[] = [];
    const release = () =>
      this.prisma.discordChartPost.deleteMany({
        where: { communityId: channel.communityId, OR: claimed.map(keyOf) },
      });

    for (const chart of charts) {
      try {
        await this.prisma.discordChartPost.create({
          data: { communityId: channel.communityId, ...keyOf(chart) },
        });
        claimed.push(chart);
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        if (claimed.length) await release();
        throw error;
      }
    }
    if (claimed.length === 0) return;

    let sent: SentMessage;
    try {
      sent = await this.discordCharts.send(
        channel,
        chartMessage(claimed, channel),
        claimed.map(({ file }) => file),
      );
    } catch (error) {
      if (canRetry(error)) await release();
      await this.discordCharts.failed(channel, error);
      return;
    }
    await this.prisma.discordChartPost.updateMany({
      where: { communityId: channel.communityId, OR: claimed.map(keyOf) },
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
