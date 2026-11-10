import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { runLocked } from '../common/locked-job';
import { fetchImage } from '../common/fetch-image';
import { isUniqueViolation } from '../common/prisma-errors';
import { MINUTE } from '../common/throttle';
import { webUrl } from '../common/web-url';
import { PrismaService } from '../prisma.service';
import {
  FacebookError,
  FacebookPage,
  facebookPage,
  NOT_SET_UP,
  postPhoto,
} from './facebook-page';

const CHECK_MS = 30 * MINUTE;
const POST_LOCK = 727_012_053;
const ENABLED_KEY = 'facebook.releases';
const CHANGELOG_TIMEOUT_MS = 10_000;
const IMAGE_TIMEOUT_MS = 30_000;
const SHOWN_CHANGES = 8;
const UNCONFIRMED_AFTER_MS = 2 * MINUTE;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MARKS = { new: '✨', improved: '💄', fixed: '🐛' } as const;

type ChangeType = keyof typeof MARKS;

export type ChangelogDay = {
  date: string;
  versions: string[];
  entries: { type: ChangeType; title: string }[];
};

export type FacebookReleasesStatus = {
  enabled: boolean;
  lastPost: {
    date: string;
    version: string | null;
    postId: string | null;
    postedAt: string;
  } | null;
};

export type ReleasePost = {
  postId: string;
  date: string;
  version: string | null;
};

class UnclearPostError extends Error {}
class ReleaseImageError extends Error {}

export function releaseVersion(days: ChangelogDay[]) {
  return days[0]?.versions.at(-1) ?? null;
}

export function releaseLink(days: ChangelogDay[]) {
  return days.length === 1
    ? `${webUrl()}/changelog/${days[0].date}`
    : `${webUrl()}/changelog`;
}

export function releaseImageUrl(days: ChangelogDay[]) {
  const params = new URLSearchParams({ date: days[0].date });
  if (days.length > 1) params.set('from', days[days.length - 1].date);
  return `${webUrl()}/changelog/image?${params}`;
}

export function releaseMessage(days: ChangelogDay[]) {
  const version = releaseVersion(days);
  const changes = days.flatMap((day) => day.entries);
  const lines = changes
    .slice(0, SHOWN_CHANGES)
    .map(({ type, title }) => `${MARKS[type]} ${title}`);
  if (changes.length > SHOWN_CHANGES) {
    lines.push(`…and ${changes.length - SHOWN_CHANGES} more`);
  }
  return [
    `What’s new in Orbis${version ? ` ${version}` : ''}`,
    lines.join('\n'),
    `See all the changes: ${releaseLink(days)}`,
  ].join('\n\n');
}

function changelogDay(value: unknown): ChangelogDay | null {
  if (!value || typeof value !== 'object') return null;
  const { date, versions, entries } = value as Record<string, unknown>;
  if (typeof date !== 'string' || !DAY.test(date) || !Array.isArray(entries)) {
    return null;
  }
  const changes = entries.flatMap((entry) => {
    const { type, title } = (entry ?? {}) as Record<string, unknown>;
    return typeof title === 'string' &&
      title.trim() &&
      typeof type === 'string' &&
      type in MARKS
      ? [{ type: type as ChangeType, title: title.trim() }]
      : [];
  });
  if (changes.length === 0) return null;
  return {
    date,
    versions: Array.isArray(versions)
      ? versions.filter(
          (version): version is string => typeof version === 'string',
        )
      : [],
    entries: changes,
  };
}

@Injectable()
export class FacebookReleasePostingService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(FacebookReleasePostingService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    if (!facebookPage()) return;
    this.timer = setInterval(() => void this.run(), CHECK_MS);
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
      await runLocked(this.prisma, POST_LOCK, CHECK_MS, () =>
        this.postDue(page),
      );
    } catch (error) {
      this.logger.warn(
        `Posting the latest update to Facebook failed: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  async status(): Promise<FacebookReleasesStatus> {
    const lastPost = await this.prisma.facebookReleasePost.findFirst({
      orderBy: { date: 'desc' },
      select: { date: true, version: true, postId: true, createdAt: true },
    });
    return {
      enabled: await this.enabled(),
      lastPost: lastPost && {
        date: lastPost.date,
        version: lastPost.version,
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
    if (enabled) await this.run();
    return this.status();
  }

  async sendNow(): Promise<ReleasePost> {
    const page = facebookPage();
    if (!page) throw new BadRequestException(NOT_SET_UP);

    const days = await this.changelog().catch((error: Error) => {
      this.logger.warn(`Couldn’t load the changelog: ${error.message}`);
      throw new BadGatewayException(
        'Couldn’t load the changelog from the website. Try again in a moment',
      );
    });
    if (days.length === 0) {
      throw new BadRequestException(
        'The changelog is empty, so there’s nothing to post yet',
      );
    }
    await this.prisma.facebookReleasePost.deleteMany({
      where: {
        postId: null,
        createdAt: { lt: new Date(Date.now() - UNCONFIRMED_AFTER_MS) },
      },
    });
    const due = await this.due(days);
    if (due.length === 0) {
      const version = releaseVersion(days);
      throw new BadRequestException(
        `There’s no new update to post. The newest one${version ? `, ${version},` : ''} is already on Facebook`,
      );
    }

    try {
      const posted = await this.post(page, due);
      if (!posted) {
        throw new BadRequestException(
          'This update was just posted. Check the Page',
        );
      }
      return posted;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if (error instanceof ReleaseImageError) {
        throw new BadGatewayException(
          'Couldn’t make the update image. Try again in a moment',
        );
      }
      throw new BadGatewayException(
        error instanceof FacebookError
          ? `Facebook said: ${error.message.replace(/\.$/, '')}`
          : 'Facebook didn’t answer. Check the Page before trying again, in case it was posted',
      );
    }
  }

  private async enabled() {
    const setting = await this.prisma.setting.findUnique({
      where: { key: ENABLED_KEY },
      select: { value: true },
    });
    return setting?.value === 'true';
  }

  private async changelog() {
    const response = await fetch(`${webUrl()}/changelog.json`, {
      signal: AbortSignal.timeout(CHANGELOG_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`The website responded with ${response.status}`);
    }
    const body = (await response.json()) as { days?: unknown };
    if (!Array.isArray(body?.days)) {
      throw new Error('The changelog had no days');
    }
    return body.days
      .flatMap((day) => {
        const parsed = changelogDay(day);
        return parsed ? [parsed] : [];
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  private async due(days: ChangelogDay[]) {
    const last = await this.prisma.facebookReleasePost.findFirst({
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    return last ? days.filter((day) => day.date > last.date) : days.slice(0, 1);
  }

  private async postDue(page: FacebookPage) {
    if (!(await this.enabled())) return;
    const due = await this.due(await this.changelog());
    if (due.length === 0) return;
    await this.post(page, due).catch((error: Error) => {
      if (!(error instanceof UnclearPostError)) throw error;
    });
  }

  private async post(
    page: FacebookPage,
    days: ChangelogDay[],
  ): Promise<ReleasePost | null> {
    const { date } = days[0];
    const version = releaseVersion(days);
    const data = await fetchImage(
      releaseImageUrl(days),
      IMAGE_TIMEOUT_MS,
    ).catch((error: Error) => {
      this.logger.warn(
        `Couldn’t load the update image for ${date}: ${error.message}`,
      );
      throw new ReleaseImageError(error.message);
    });
    try {
      await this.prisma.facebookReleasePost.create({
        data: { date, version },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }

    let postId: string;
    try {
      postId = await postPhoto(
        page,
        { filename: `orbis-update-${date}.png`, data },
        releaseMessage(days),
      );
    } catch (error) {
      if (error instanceof FacebookError) {
        await this.prisma.facebookReleasePost.deleteMany({ where: { date } });
        throw error;
      }
      this.logger.warn(
        `Facebook didn’t answer when posting the update for ${date}, so it won’t be tried again in case it went through: ${(error as Error).message}`,
      );
      throw new UnclearPostError((error as Error).message);
    }
    await this.prisma.facebookReleasePost.update({
      where: { date },
      data: { postId },
    });
    return { postId, date, version };
  }
}
