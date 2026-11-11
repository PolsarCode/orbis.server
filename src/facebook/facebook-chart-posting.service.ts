import {
  BadGatewayException,
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { MediaType } from '../../prisma/generated/client';
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
  pageFollowers,
  pageName,
  postPhoto,
} from './facebook-page';
import {
  FacebookPostingJob,
  postFailed,
  UnclearPostError,
} from './facebook-posting-job';
import { readSwitch, saveSwitch } from './facebook-switch';

const POST_MS = 10 * MINUTE;
const POST_LOCK = 727_012_052;
const ENABLED_KEY = 'facebook.charts';

export type FacebookChartsStatus = {
  configured: boolean;
  page: { id: string; name: string | null; followers: number | null } | null;
  pageError: string | null;
  followersError: string | null;
  enabled: boolean;
  lastPost: { week: string; postId: string | null; postedAt: string } | null;
};

type Lookup<T> = { value: T | null; error: string | null };

const UNASKED = { value: null, error: null };

async function lookup<T>(request: Promise<T>): Promise<Lookup<T>> {
  try {
    return { value: await request, error: null };
  } catch (error) {
    return {
      value: null,
      error:
        error instanceof FacebookError
          ? error.message.replace(/\.$/, '')
          : 'Facebook didn’t answer',
    };
  }
}

export function chartCaption(type: MediaType, chart: ChartWeek) {
  return `Trending ${CHART_LABELS[type]} of ${weekRange(chart)} on Orbis!\n\nJoin the discussion: ${webUrl()}${chartShortPath(type, chart.week)}`;
}

@Injectable()
export class FacebookChartPostingService extends FacebookPostingJob {
  constructor(
    prisma: PrismaService,
    private charts: ChartShareService,
  ) {
    super(prisma, {
      every: POST_MS,
      lock: POST_LOCK,
      failure: 'Posting weekly charts to Facebook failed',
    });
  }

  async status(): Promise<FacebookChartsStatus> {
    const page = facebookPage();
    const [name, followers] = page
      ? await Promise.all([lookup(pageName(page)), lookup(pageFollowers(page))])
      : [UNASKED, UNASKED];
    const lastPost = await this.prisma.facebookChartPost.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { week: true, postId: true, createdAt: true },
    });
    return {
      configured: page !== null,
      page: page && {
        id: page.id,
        name: name.value,
        followers: followers.value,
      },
      pageError: name.error,
      followersError: followers.error,
      enabled: await this.enabled(),
      lastPost: lastPost && {
        week: lastPost.week,
        postId: lastPost.postId,
        postedAt: lastPost.createdAt.toISOString(),
      },
    };
  }

  async setEnabled(enabled: boolean) {
    await saveSwitch(this.prisma, ENABLED_KEY, enabled);
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
        throw postFailed(error, this.postedSoFar(posted));
      }
    }
    return { postIds };
  }

  private postedSoFar(posted: MediaType[]) {
    return posted.length ? `Posted ${typeList(posted)}, then ` : '';
  }

  private enabled() {
    return readSwitch(this.prisma, ENABLED_KEY, true);
  }

  protected async postDue(page: FacebookPage) {
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
    await this.postOnce({
      page,
      image,
      message: chartCaption(type, chart),
      label: `the ${type} chart for ${chart.week}`,
      claim: () => this.prisma.facebookChartPost.create({ data: key }),
      release: () => this.prisma.facebookChartPost.deleteMany({ where: key }),
      confirm: (postId) =>
        this.prisma.facebookChartPost.update({
          where: { mediaType_week: key },
          data: { postId },
        }),
    }).catch((error: Error) => {
      if (!(error instanceof UnclearPostError)) throw error;
    });
  }
}
