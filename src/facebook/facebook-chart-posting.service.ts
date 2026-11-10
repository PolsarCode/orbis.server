import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { MediaType } from '../../prisma/generated/client';
import { runLocked } from '../common/locked-job';
import { isUniqueViolation } from '../common/prisma-errors';
import { MINUTE } from '../common/throttle';
import { webUrl } from '../common/web-url';
import { chartShortPath } from '../library/chart-link';
import {
  CHART_LABELS,
  CHART_TYPES,
  ChartShareService,
  ChartWeek,
  typeList,
  weekRange,
} from '../library/chart-share.service';
import { PrismaService } from '../prisma.service';
import {
  FacebookError,
  FacebookPage,
  facebookPage,
  NOT_SET_UP,
  pageName,
  postPhoto,
} from './facebook-page';

const POST_MS = 10 * MINUTE;
const POST_LOCK = 727_012_052;
const ENABLED_KEY = 'facebook.charts';

export type FacebookChartsStatus = {
  configured: boolean;
  page: { id: string; name: string | null } | null;
  pageError: string | null;
  enabled: boolean;
  lastPost: { week: string; postId: string | null; postedAt: string } | null;
};

export function chartCaption(type: MediaType, chart: ChartWeek) {
  return `Trending ${CHART_LABELS[type]} of ${weekRange(chart)} on Orbis!\n\nJoin the discussion: ${webUrl()}${chartShortPath(type, chart.week)}`;
}

@Injectable()
export class FacebookChartPostingService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(FacebookChartPostingService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private prisma: PrismaService,
    private charts: ChartShareService,
  ) {}

  onModuleInit() {
    if (!facebookPage()) return;
    this.timer = setInterval(() => void this.run(), POST_MS);
    this.timer.unref();
    void this.run();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async run() {
    const page = facebookPage();
    if (!page || this.running) return;
    this.running = true;
    try {
      await runLocked(this.prisma, POST_LOCK, POST_MS, () =>
        this.postDue(page),
      );
    } catch (error) {
      this.logger.warn(
        `Posting weekly charts to Facebook failed: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  async status(): Promise<FacebookChartsStatus> {
    const page = facebookPage();
    let name: string | null = null;
    let pageError: string | null = null;
    if (page) {
      try {
        name = await pageName(page);
      } catch (error) {
        pageError =
          error instanceof FacebookError
            ? error.message.replace(/\.$/, '')
            : 'Facebook didn’t answer';
      }
    }
    const lastPost = await this.prisma.facebookChartPost.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { week: true, postId: true, createdAt: true },
    });
    return {
      configured: page !== null,
      page: page && { id: page.id, name },
      pageError,
      enabled: await this.enabled(),
      lastPost: lastPost && {
        week: lastPost.week,
        postId: lastPost.postId,
        postedAt: lastPost.createdAt.toISOString(),
      },
    };
  }

  async setEnabled(enabled: boolean) {
    await this.prisma.setting.upsert({
      where: { key: ENABLED_KEY },
      create: { key: ENABLED_KEY, value: String(enabled) },
      update: { value: String(enabled) },
    });
    return this.status();
  }

  async sendNow() {
    const page = facebookPage();
    if (!page) throw new BadRequestException(NOT_SET_UP);

    const posted: MediaType[] = [];
    const postIds: string[] = [];
    for (const type of CHART_TYPES) {
      const chart = await this.charts.current(type);
      const image = await this.charts
        .image(type, chart)
        .catch((error: Error) => {
          this.logger.warn(
            `Couldn’t load the ${type} chart image: ${error.message}`,
          );
          throw new BadGatewayException(
            `${this.postedSoFar(posted)}Couldn’t make the ${CHART_LABELS[type]} chart image. Try again in a moment`,
          );
        });
      try {
        postIds.push(await postPhoto(page, image, chartCaption(type, chart)));
        posted.push(type);
      } catch (error) {
        this.logger.warn(
          `Posting the ${type} chart to Facebook failed: ${(error as Error).message}`,
        );
        throw new BadGatewayException(
          `${this.postedSoFar(posted)}${
            error instanceof FacebookError
              ? `Facebook said: ${error.message.replace(/\.$/, '')}`
              : 'Facebook didn’t answer. Check the Page before trying again, in case it was posted'
          }`,
        );
      }
    }
    return { postIds };
  }

  private postedSoFar(posted: MediaType[]) {
    return posted.length ? `Posted ${typeList(posted)}, then ` : '';
  }

  private async enabled() {
    const setting = await this.prisma.setting.findUnique({
      where: { key: ENABLED_KEY },
      select: { value: true },
    });
    return setting?.value !== 'false';
  }

  private async postDue(page: FacebookPage) {
    if (!(await this.enabled())) return;
    const started = await this.charts.startedToday(CHART_TYPES);
    const due = [...started].flatMap(([type, chart]) =>
      chart ? [{ type, chart }] : [],
    );
    if (due.length === 0) return;

    const posted = await this.prisma.facebookChartPost.findMany({
      where: {
        OR: due.map(({ type, chart }) => ({
          mediaType: type,
          week: chart.week,
        })),
      },
      select: { mediaType: true },
    });
    for (const { type, chart } of due) {
      if (posted.some(({ mediaType }) => mediaType === type)) continue;
      try {
        await this.post(page, type, chart);
      } catch (error) {
        this.logger.warn(
          `Posting the ${type} chart to Facebook failed: ${(error as Error).message}`,
        );
      }
    }
  }

  private async post(page: FacebookPage, type: MediaType, chart: ChartWeek) {
    const key = { mediaType: type, week: chart.week };
    const image = await this.charts.image(type, chart);
    try {
      await this.prisma.facebookChartPost.create({ data: key });
    } catch (error) {
      if (isUniqueViolation(error)) return;
      throw error;
    }

    let postId: string;
    try {
      postId = await postPhoto(page, image, chartCaption(type, chart));
    } catch (error) {
      if (error instanceof FacebookError) {
        await this.prisma.facebookChartPost.deleteMany({ where: key });
        throw error;
      }
      this.logger.warn(
        `Facebook didn’t answer when posting the ${type} chart for ${chart.week}, so it won’t be tried again in case it went through: ${(error as Error).message}`,
      );
      return;
    }
    await this.prisma.facebookChartPost.update({
      where: { mediaType_week: key },
      data: { postId },
    });
  }
}
