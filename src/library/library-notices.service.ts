import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '../../prisma/generated/client';
import { runLocked } from '../common/locked-job';
import { DAY, HOUR, MINUTE } from '../common/throttle';
import { notSuspended } from '../users/suspension';
import {
  NewNotification,
  NotificationsService,
} from '../notifications/notifications.service';
import { coverUrl, getMedia, getSchedule, Media } from './library-api';
import { ExpiringCache } from './library.service';

const NOTICE_MS = 15 * MINUTE;
const NOTICE_LOCK = 727_012_056;
const RECENT_MS = 2 * DAY;
const GAME_LIFETIME_MS = 6 * HOUR;
const ANNOUNCED = 'announced:';

const entrySelect = {
  id: true,
  userId: true,
  mediaType: true,
  sourceId: true,
  title: true,
  coverImage: true,
  isAdult: true,
  progress: true,
  createdAt: true,
} as const;

type NoticeEntry = Prisma.LibraryEntryGetPayload<{
  select: typeof entrySelect;
}>;

type Candidate = {
  entry: NoticeEntry;
  kind: 'episode_aired' | 'game_released' | 'game_date';
  key: string;
  message: string;
};

const pad = (value: number) => String(value).padStart(2, '0');
const monthOf = (date: Date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;

function scheduleMonths(now: Date) {
  const months = [monthOf(now)];
  if (now.getUTCDate() <= 2) {
    months.unshift(
      monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1))),
    );
  }
  return months;
}

function releaseOf(media: Media) {
  const date = media.details?.releaseDate;
  const precision = media.details?.releaseDatePrecision;
  return {
    date: typeof date === 'string' ? date : null,
    precision: typeof precision === 'string' ? precision : null,
  };
}

const longDate = (date: string) =>
  new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

@Injectable()
export class LibraryNoticesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LibraryNoticesService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private games = new ExpiringCache<Media>();

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.run(), NOTICE_MS);
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
      await runLocked(this.prisma, NOTICE_LOCK, NOTICE_MS, () => this.check());
    } catch (error) {
      this.logger.warn(
        `Catalog release check failed: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  async check() {
    const now = new Date(Date.now());
    const [episodes, games] = await Promise.all([
      this.episodes(now),
      this.releases(now),
    ]);
    await this.send([...episodes, ...games]);
  }

  private entries(mediaType: 'anime' | 'game') {
    return this.prisma.libraryEntry.findMany({
      where: {
        mediaType,
        status: mediaType === 'anime' ? 'current' : 'planned',
        user: notSuspended(),
      },
      select: entrySelect,
    });
  }

  private async episodes(now: Date): Promise<Candidate[]> {
    const entries = await this.entries('anime');
    if (entries.length === 0) return [];
    const ids = [...new Set(entries.map((entry) => entry.sourceId))];
    const schedules = await Promise.all(
      scheduleMonths(now).map((month) => getSchedule(month, ids, true)),
    );
    const aired = schedules.flat().filter(({ airsAt }) => {
      const time = Date.parse(airsAt);
      return time <= now.getTime() && time > now.getTime() - RECENT_MS;
    });

    return entries.flatMap((entry) =>
      aired
        .filter(
          ({ id, episode, airsAt }) =>
            id === entry.sourceId &&
            episode > entry.progress &&
            Date.parse(airsAt) > entry.createdAt.getTime(),
        )
        .map(({ episode }) => ({
          entry,
          kind: 'episode_aired' as const,
          key: String(episode),
          message: `Episode ${episode} of ${entry.title} is out`,
        })),
    );
  }

  private async releases(now: Date): Promise<Candidate[]> {
    const entries = await this.entries('game');
    if (entries.length === 0) return [];
    const ids = [...new Set(entries.map((entry) => entry.sourceId))];
    const profiles = new Map<string, Media>();
    await Promise.all(
      ids.map(async (id) => {
        try {
          profiles.set(
            id,
            await this.games.get(
              id,
              () => getMedia('game', id, true),
              () => GAME_LIFETIME_MS,
            ),
          );
        } catch {
          return;
        }
      }),
    );

    const seen = await this.prisma.libraryNotice.findMany({
      where: {
        kind: 'game_date',
        entryId: { in: entries.map((entry) => entry.id) },
        NOT: { key: { startsWith: ANNOUNCED } },
      },
      orderBy: { createdAt: 'desc' },
      distinct: ['entryId'],
      select: { entryId: true, key: true },
    });
    const lastSeen = new Map(seen.map(({ entryId, key }) => [entryId, key]));
    const candidates: Candidate[] = [];

    for (const entry of entries) {
      const profile = profiles.get(entry.sourceId);
      if (!profile) continue;
      const { date, precision } = releaseOf(profile);
      const state = `${precision ?? 'none'}:${date ?? ''}`;
      const previous = lastSeen.get(entry.id);

      if (previous !== state) {
        await this.prisma.libraryNotice.upsert({
          where: {
            entryId_kind_key: {
              entryId: entry.id,
              kind: 'game_date',
              key: state,
            },
          },
          create: { entryId: entry.id, kind: 'game_date', key: state },
          update: { createdAt: now },
        });
        if (
          previous !== undefined &&
          precision === 'day' &&
          date &&
          Date.parse(date) > now.getTime()
        ) {
          candidates.push({
            entry,
            kind: 'game_date',
            key: `${ANNOUNCED}${date}`,
            message: `${entry.title} comes out on ${longDate(date)}`,
          });
        }
      }

      if (precision !== 'day' || !date) continue;
      const releasesAt = Date.parse(date);
      if (
        releasesAt <= now.getTime() &&
        releasesAt > now.getTime() - RECENT_MS &&
        releasesAt > entry.createdAt.getTime()
      ) {
        candidates.push({
          entry,
          kind: 'game_released',
          key: date,
          message: `${entry.title} is out now`,
        });
      }
    }
    return candidates;
  }

  private async send(candidates: Candidate[]) {
    if (candidates.length === 0) return;
    const created = await this.prisma.libraryNotice.createManyAndReturn({
      data: candidates.map(({ entry, kind, key }) => ({
        entryId: entry.id,
        kind,
        key,
      })),
      skipDuplicates: true,
      select: { entryId: true, kind: true, key: true },
    });
    const fresh = new Set(
      created.map(({ entryId, kind, key }) => `${entryId}:${kind}:${key}`),
    );
    const notifications: NewNotification[] = candidates
      .filter(({ entry, kind, key }) => fresh.has(`${entry.id}:${kind}:${key}`))
      .map(({ entry, kind, message }) => ({
        userId: entry.userId,
        actorId: null,
        type: kind,
        message,
        link: `/library/${entry.mediaType}/${entry.sourceId}`,
        imageUrl: coverUrl(entry),
      }));
    if (notifications.length > 0) {
      await this.notifications.notify(notifications);
    }
  }
}
