import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  LibraryStatus,
  MediaType,
  Prisma,
} from '../../prisma/generated/client';
import { author } from '../common/author';
import { isUniqueViolation } from '../common/prisma-errors';
import { AddLibraryEntryDto } from './dto/add-library-entry.dto';
import { UpdateLibraryEntryDto } from './dto/update-library-entry.dto';
import {
  coverUrl,
  Chart,
  getChart,
  getMedia,
  getMediaList,
  getSeason,
  imageUrl,
  Media,
  MEDIA_LISTS,
  searchMedia,
  Season,
} from './library-api';
import { GUEST_USER_ID } from '../auth/allow-guest';
import { nsfwEntries, showsNsfw } from '../users/nsfw';
import { notSuspended } from '../users/suspension';
import { notBlockedWith } from '../safety/blocks';
import { loadSteamLinks, SteamLink } from '../steam/steam-links';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';
import { windowRange } from '../common/weekly-window';

const PROGRESS_MERGE_WINDOW = 5 * 60 * 1000;
const SPOTLIGHT_KEY = 'anime-spotlight';
const SPOTLIGHT_SIZE = 10;
const SPOTLIGHT_CANDIDATES = 40;
const SPOTLIGHT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const SPOTLIGHT_RETRY_MS = 60 * 60 * 1000;
const PUBLIC_UPDATES = 6;
const LIST_LIFETIME_MS = 60 * 60 * 1000;
const LIST_RETRY_MS = 5 * 60 * 1000;
const PAST_CHART_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MOST_ADDED = 5;

export type Spotlight = {
  type: 'anime';
  sourceId: string;
  title: string;
  coverImage: string | null;
  bannerImage: string | null;
};

export type MostAdded = {
  startsAt: string;
  endsAt: string;
  items: {
    media: {
      type: MediaType;
      sourceId: string;
      title: string;
      coverImage: string | null;
    };
    adds: number;
  }[];
};

type StoredSpotlight = Spotlight & { addedAt: number };

type SpotlightList = {
  items: StoredSpotlight[];
  retired: string[];
  checkedAt: number;
};

const entrySelect = {
  id: true,
  mediaId: true,
  mediaType: true,
  sourceId: true,
  title: true,
  coverImage: true,
  year: true,
  status: true,
  progress: true,
  total: true,
  isPublic: true,
  isAdult: true,
  steamAppId: true,
  createdAt: true,
  updatedAt: true,
} as const;

type EntryRow = Prisma.LibraryEntryGetPayload<{ select: typeof entrySelect }>;

export type LibraryEntryView = Omit<EntryRow, 'steamAppId' | 'isAdult'> & {
  steam: SteamLink | null;
};

function totalOf(media: Media) {
  const count =
    media.details?.[media.type === 'MANGA' ? 'chapters' : 'episodes'];
  return media.type !== 'GAME' && typeof count === 'number' && count > 0
    ? count
    : null;
}

function withImageUrls({ addedAt, ...spotlight }: StoredSpotlight): Spotlight {
  return {
    ...spotlight,
    coverImage:
      spotlight.coverImage && imageUrl('anime', spotlight.sourceId, 'cover'),
    bannerImage:
      spotlight.bannerImage && imageUrl('anime', spotlight.sourceId, 'banner'),
  };
}

const toResult = (media: Media) => ({
  id: media.id,
  type: media.type.toLowerCase() as 'anime' | 'manga' | 'game',
  sourceId: media.sourceId,
  title: media.title,
  coverImage: media.coverImage,
  year: media.year,
  score: media.score,
});

function chartLifetime(chart: Chart, now: number) {
  const endsIn = Date.parse(chart.endsAt) - now;
  if (endsIn > 0) return Math.min(endsIn, LIST_LIFETIME_MS);
  return chart.nextWeek ? PAST_CHART_LIFETIME_MS : LIST_LIFETIME_MS;
}

class ExpiringCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();

  async get(
    key: string,
    load: () => Promise<T>,
    lifetime: (value: T, now: number) => number,
  ) {
    const now = Date.now();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) return cached.value;

    try {
      const value = await load();
      this.entries.set(key, { value, expiresAt: now + lifetime(value, now) });
      return value;
    } catch (error) {
      if (!cached) throw error;
      this.entries.set(key, {
        value: cached.value,
        expiresAt: now + LIST_RETRY_MS,
      });
      return cached.value;
    }
  }
}

@Injectable()
export class LibraryService {
  private lists = new ExpiringCache<Media[]>();
  private charts = new ExpiringCache<Chart>();
  private seasons = new ExpiringCache<Season>();

  constructor(
    private prisma: PrismaService,
    private discordChannel: DiscordChannelService,
  ) {}

  async publicUpdates() {
    const activities = await this.prisma.libraryActivity.findMany({
      where: {
        entry: {
          isPublic: true,
          isAdult: false,
          user: { isPublic: true, ...notSuspended() },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PUBLIC_UPDATES,
      include: {
        entry: {
          select: {
            mediaType: true,
            sourceId: true,
            title: true,
            coverImage: true,
            isAdult: true,
            year: true,
            user: author,
          },
        },
      },
    });

    return activities.map(({ entry, ...activity }) => ({
      id: activity.id,
      createdAt: activity.createdAt,
      status: activity.status,
      progress:
        activity.progressTo === null
          ? null
          : {
              from: activity.progressFrom ?? activity.progressTo,
              to: activity.progressTo,
            },
      author: entry.user,
      media: {
        type: entry.mediaType,
        sourceId: entry.sourceId,
        title: entry.title,
        coverImage: coverUrl(entry),
        year: entry.year,
      },
    }));
  }

  async mediaList(userId: number, type: MediaType, list: string) {
    const name = MEDIA_LISTS.find((value) => value === list);
    if (!name) throw new NotFoundException('List not found');

    const adult = await showsNsfw(this.prisma, userId);
    const items = await this.lists.get(
      `${type}:${name}:${adult}`,
      () => getMediaList(type, name, adult),
      () => LIST_LIFETIME_MS,
    );
    return this.listItems(userId, items);
  }

  async season(userId: number, type: MediaType, season: string) {
    if (!/^\d{4}-(winter|spring|summer|fall)$/.test(season)) {
      throw new NotFoundException('Season not found');
    }

    const adult = await showsNsfw(this.prisma, userId);
    const found = await this.seasons.get(
      `${type}:${season}:${adult}`,
      () => getSeason(type, season, adult),
      () => LIST_LIFETIME_MS,
    );
    return {
      type,
      season: found.season,
      year: found.year,
      startsAt: found.startsAt,
      endsAt: found.endsAt,
      items: await this.listItems(userId, found.items),
    };
  }

  async mostAdded(type: MediaType, until: Date): Promise<MostAdded> {
    const { startsAt, endsAt } = windowRange(until);
    const where = {
      mediaType: type,
      isPublic: true,
      isAdult: false,
      createdAt: { gte: startsAt, lt: endsAt },
      user: { isPublic: true, ...notSuspended() },
    } satisfies Prisma.LibraryEntryWhereInput;
    const counts = await this.prisma.libraryEntry.groupBy({
      by: ['sourceId'],
      where,
      _count: { sourceId: true },
      orderBy: [
        { _count: { sourceId: 'desc' } },
        { _max: { createdAt: 'desc' } },
        { sourceId: 'asc' },
      ],
      take: MOST_ADDED,
    });
    const latest =
      counts.length === 0
        ? []
        : await this.prisma.libraryEntry.findMany({
            where: {
              ...where,
              sourceId: { in: counts.map(({ sourceId }) => sourceId) },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            distinct: ['sourceId'],
            select: {
              mediaType: true,
              sourceId: true,
              title: true,
              coverImage: true,
              isAdult: true,
            },
          });
    const bySource = new Map(latest.map((entry) => [entry.sourceId, entry]));

    return {
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      items: counts.flatMap(({ sourceId, _count }) => {
        const entry = bySource.get(sourceId);
        return entry
          ? [
              {
                media: {
                  type: entry.mediaType,
                  sourceId,
                  title: entry.title,
                  coverImage: coverUrl(entry),
                },
                adds: _count.sourceId,
              },
            ]
          : [];
      }),
    };
  }

  private async loadChart(userId: number, type: MediaType, week?: string) {
    if (week && !/^\d{4}-W\d{2}$/.test(week)) {
      throw new NotFoundException('Chart not found');
    }

    const adult = await showsNsfw(this.prisma, userId);
    return this.charts.get(
      `${type}:${week || 'current'}:${adult}`,
      () => getChart(type, week, adult),
      chartLifetime,
    );
  }

  async chart(userId: number, type: MediaType, week?: string) {
    const chart = await this.loadChart(userId, type, week);
    const items = await this.listItems(
      userId,
      chart.entries.map(({ media }) => media),
    );

    return {
      ...chart,
      entries: chart.entries.map((entry, index) => ({
        ...entry,
        media: items[index],
      })),
    };
  }

  async chartDiscussion(userId: number, type: MediaType, week?: string) {
    if (!week) throw new NotFoundException('Chart not found');
    const chart = await this.loadChart(userId, type, week);
    const key = { mediaType: type, week: chart.week };
    return this.prisma.chartDiscussion.upsert({
      where: { mediaType_week: key },
      create: key,
      update: {},
      select: { id: true, commentCount: true },
    });
  }

  private async listItems(userId: number, items: Media[]) {
    const saved =
      userId === GUEST_USER_ID
        ? []
        : await this.prisma.libraryEntry.findMany({
            where: { userId, mediaId: { in: items.map(({ id }) => id) } },
            select: { id: true, mediaId: true, status: true, isPublic: true },
          });
    const entries = new Map(
      saved.map(({ mediaId, ...entry }) => [mediaId, entry]),
    );

    return items.map((media) => ({
      ...toResult(media),
      synopsis: media.synopsis ?? null,
      bannerImage: media.bannerImage ?? null,
      releaseStatus: media.status ?? null,
      genres: media.genres ?? [],
      details: media.details ?? {},
      inLibrary: entries.has(media.id),
      entry: entries.get(media.id) ?? null,
    }));
  }

  async spotlight(): Promise<Spotlight | null> {
    const { items } = await this.rollSpotlights(Date.now());
    if (items.length === 0) return null;
    return withImageUrls(items[Math.floor(Math.random() * items.length)]);
  }

  async spotlights(): Promise<Spotlight[]> {
    const { items } = await this.rollSpotlights(Date.now());
    return items.map(withImageUrls);
  }

  private async rollSpotlights(now: number): Promise<SpotlightList> {
    const stored = await this.readSpotlights();
    const fresh = stored.items.filter(
      (item) => now - item.addedAt < SPOTLIGHT_LIFETIME_MS,
    );
    const expired = stored.items.filter((item) => !fresh.includes(item));
    const missing = SPOTLIGHT_SIZE - fresh.length;
    const retry = now - stored.checkedAt >= SPOTLIGHT_RETRY_MS;
    if (expired.length === 0 && (missing === 0 || !retry)) return stored;

    const retired = [
      ...expired.map((item) => item.sourceId),
      ...stored.retired,
    ].slice(0, SPOTLIGHT_SIZE);
    const added =
      missing > 0 && (expired.length > 0 || retry)
        ? await this.nextSpotlights(
            missing,
            fresh.map((item) => item.sourceId),
            retired,
          )
        : [];
    const step = SPOTLIGHT_LIFETIME_MS / SPOTLIGHT_SIZE;
    const list: SpotlightList = {
      items: [
        ...fresh,
        ...added.map((spotlight, index) => ({
          ...spotlight,
          addedAt: now - index * step,
        })),
      ],
      retired,
      checkedAt: now,
    };
    await this.prisma.setting.upsert({
      where: { key: SPOTLIGHT_KEY },
      create: { key: SPOTLIGHT_KEY, value: JSON.stringify(list) },
      update: { value: JSON.stringify(list) },
    });
    return list;
  }

  private async readSpotlights(): Promise<SpotlightList> {
    const setting = await this.prisma.setting.findUnique({
      where: { key: SPOTLIGHT_KEY },
      select: { value: true },
    });
    try {
      const list = JSON.parse(setting?.value ?? '') as Partial<SpotlightList>;
      return {
        items: Array.isArray(list.items) ? list.items : [],
        retired: Array.isArray(list.retired) ? list.retired : [],
        checkedAt: typeof list.checkedAt === 'number' ? list.checkedAt : 0,
      };
    } catch {
      return { items: [], retired: [], checkedAt: 0 };
    }
  }

  private async nextSpotlights(
    count: number,
    current: string[],
    retired: string[],
  ): Promise<Spotlight[]> {
    const entries = await this.prisma.libraryEntry.findMany({
      where: {
        mediaType: 'anime',
        isPublic: true,
        isAdult: false,
        user: { isPublic: true },
        sourceId: { notIn: current },
      },
      orderBy: { updatedAt: 'desc' },
      distinct: ['sourceId'],
      take: SPOTLIGHT_CANDIDATES,
      select: { sourceId: true, title: true, coverImage: true },
    });
    const candidates = [
      ...entries.filter((entry) => !retired.includes(entry.sourceId)),
      ...entries.filter((entry) => retired.includes(entry.sourceId)),
    ];
    const added: Spotlight[] = [];
    for (const entry of candidates) {
      if (added.length === count) break;
      const spotlight = await this.toSpotlight(entry);
      if (spotlight) added.push(spotlight);
    }
    return added;
  }

  private async toSpotlight(entry: {
    sourceId: string;
    title: string;
    coverImage: string | null;
  }): Promise<Spotlight | null> {
    try {
      const media = await getMedia('anime', entry.sourceId, false);
      if (media.isAdult) return null;
      const coverImage = media.coverImage ?? entry.coverImage;
      const bannerImage = media.bannerImage ?? null;
      if (!coverImage && !bannerImage) return null;
      return {
        type: 'anime',
        sourceId: entry.sourceId,
        title: media.title || entry.title,
        coverImage,
        bannerImage,
      };
    } catch {
      return null;
    }
  }

  async search(userId: number, q?: string) {
    const query = q?.trim() ?? '';
    if (query.length < 2 || query.length > 100) {
      throw new BadRequestException('Search for 2 to 100 characters');
    }

    const results = await searchMedia(
      query,
      await showsNsfw(this.prisma, userId),
    );
    const all = [...results.anime, ...results.manga, ...results.game];
    const saved = await this.prisma.libraryEntry.findMany({
      where: { userId, mediaId: { in: all.map(({ id }) => id) } },
      select: { mediaId: true },
    });
    const savedIds = new Set(saved.map(({ mediaId }) => mediaId));
    const mark = (list: Media[]) =>
      list.map((media) => ({
        ...toResult(media),
        inLibrary: savedIds.has(media.id),
      }));

    return {
      anime: mark(results.anime),
      manga: mark(results.manga),
      game: mark(results.game),
    };
  }

  async media(userId: number, type: MediaType, sourceId: string) {
    if (!/^\d{1,12}$/.test(sourceId)) {
      throw new NotFoundException('Title not found');
    }

    const media = await getMedia(
      type,
      sourceId,
      await showsNsfw(this.prisma, userId),
    );
    const [entry, others] = await Promise.all([
      this.prisma.libraryEntry.findUnique({
        where: { userId_mediaId: { userId, mediaId: media.id } },
        select: entrySelect,
      }),
      this.prisma.libraryEntry.findMany({
        where: {
          mediaId: media.id,
          isPublic: true,
          userId: { not: userId },
          user: {
            ...notBlockedWith(userId),
            memberships: {
              some: { community: { memberships: { some: { userId } } } },
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 12,
        select: { status: true, user: author },
      }),
    ]);

    return {
      ...toResult(media),
      altTitles: media.altTitles ?? [],
      synopsis: media.synopsis ?? null,
      bannerImage: media.bannerImage ?? null,
      releaseStatus: media.status ?? null,
      genres: media.genres ?? [],
      source: media.source ?? null,
      details: media.details ?? {},
      entry: entry && (await this.toView(userId, entry)),
      members: others.map(({ status, user }) => ({ status, user })),
    };
  }

  async list(userId: number): Promise<LibraryEntryView[]> {
    const entries = await this.prisma.libraryEntry.findMany({
      where: {
        userId,
        ...nsfwEntries(await showsNsfw(this.prisma, userId)),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: entrySelect,
    });
    return this.toViews(userId, entries);
  }

  async add(
    userId: number,
    {
      type,
      sourceId,
      status = 'planned',
      isPublic = true,
      progress = 0,
    }: AddLibraryEntryDto,
  ): Promise<LibraryEntryView> {
    const media = await getMedia(
      type,
      sourceId,
      await showsNsfw(this.prisma, userId),
    );
    const total = totalOf(media);
    const steam =
      type === 'game'
        ? await this.prisma.steamGame.findFirst({
            where: { userId, igdbId: media.sourceId },
            select: { appId: true },
          })
        : null;
    const initialProgress =
      type === 'game'
        ? 0
        : status === 'completed' && total !== null
          ? total
          : Math.min(progress, total ?? progress);

    try {
      const entry = await this.prisma.libraryEntry.create({
        data: {
          userId,
          mediaId: media.id,
          mediaType: type,
          sourceId: media.sourceId,
          title: media.title,
          coverImage: media.coverImage,
          year: media.year,
          status,
          progress: initialProgress,
          total,
          isPublic,
          isAdult: media.isAdult ?? false,
          steamAppId: steam?.appId ?? null,
          activities: { create: { status } },
        },
        select: entrySelect,
      });
      this.discordChannel.entryChanged(entry.id);
      return await this.toView(userId, entry);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('Already in your library');
      }
      throw e;
    }
  }

  async update(
    userId: number,
    id: number,
    { status, isPublic, progress }: UpdateLibraryEntryDto,
  ): Promise<LibraryEntryView> {
    const entry = await this.prisma.libraryEntry.findFirst({
      where: { id, userId },
      select: {
        status: true,
        progress: true,
        total: true,
        mediaType: true,
        isPublic: true,
      },
    });
    if (!entry) throw new NotFoundException('Library entry not found');

    let nextProgress =
      progress === undefined
        ? undefined
        : Math.min(progress, entry.total ?? progress);
    let nextStatus = status;
    if (status === 'completed' && entry.total !== null) {
      nextProgress = entry.total;
    } else if (
      status === undefined &&
      nextProgress !== undefined &&
      entry.total !== null &&
      nextProgress >= entry.total
    ) {
      nextStatus = 'completed';
    } else if (
      status === undefined &&
      nextProgress !== undefined &&
      nextProgress > 0 &&
      entry.status === 'planned'
    ) {
      nextStatus = 'current';
    }

    const statusChanged =
      nextStatus !== undefined && nextStatus !== entry.status;
    const updated = await this.prisma.libraryEntry.update({
      where: { id },
      data: {
        status: nextStatus,
        progress: nextProgress,
        isPublic,
        ...(statusChanged && {
          activities: { create: { status: nextStatus } },
        }),
      },
      select: entrySelect,
    });

    if (entry.mediaType !== 'game' && updated.progress !== entry.progress) {
      await this.logProgress(
        id,
        updated.status,
        entry.progress,
        updated.progress,
      );
    }
    this.discordChannel.entryChanged(
      id,
      isPublic !== undefined && isPublic !== entry.isPublic,
    );
    return this.toView(userId, updated);
  }

  private async logProgress(
    entryId: number,
    status: LibraryStatus,
    before: number,
    after: number,
  ) {
    const recent = await this.prisma.libraryActivity.findFirst({
      where: {
        entryId,
        progressTo: { not: null },
        createdAt: { gte: new Date(Date.now() - PROGRESS_MERGE_WINDOW) },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, progressFrom: true },
    });

    if (recent) {
      if (after < recent.progressFrom!) {
        await this.deleteActivities([recent.id]);
      } else {
        await this.prisma.libraryActivity.update({
          where: { id: recent.id },
          data: { progressTo: after, status, createdAt: new Date() },
        });
      }
    } else if (after > before) {
      await this.prisma.libraryActivity.create({
        data: { entryId, status, progressFrom: before + 1, progressTo: after },
      });
    }
  }

  async remove(userId: number, id: number) {
    await this.ownEntry(userId, id);
    const activities = await this.prisma.libraryActivity.findMany({
      where: { entryId: id },
      select: { id: true },
    });
    await this.deleteActivities(activities.map((activity) => activity.id));
    await this.prisma.libraryEntry.delete({ where: { id } });
  }

  private async deleteActivities(ids: number[]) {
    if (ids.length === 0) return;
    const comments = await this.prisma.comment.findMany({
      where: { commentableType: 'activity', commentableId: { in: ids } },
      select: { id: true },
    });
    await this.prisma.$transaction([
      this.prisma.like.deleteMany({
        where: {
          likeableType: 'comment',
          likeableId: { in: comments.map((comment) => comment.id) },
        },
      }),
      this.prisma.comment.deleteMany({
        where: { commentableType: 'activity', commentableId: { in: ids } },
      }),
      this.prisma.like.deleteMany({
        where: { likeableType: 'activity', likeableId: { in: ids } },
      }),
      this.prisma.libraryActivity.deleteMany({ where: { id: { in: ids } } }),
    ]);
    void this.discordChannel.activitiesDeleted(ids);
  }

  private async ownEntry(userId: number, id: number) {
    const entry = await this.prisma.libraryEntry.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!entry) throw new NotFoundException('Library entry not found');
  }

  private async toViews(
    userId: number,
    entries: EntryRow[],
  ): Promise<LibraryEntryView[]> {
    const steamOf = await loadSteamLinks(
      this.prisma,
      entries.map((entry) => ({ userId, appId: entry.steamAppId })),
    );
    return entries.map(({ steamAppId, isAdult, ...entry }) => ({
      ...entry,
      coverImage: coverUrl({ ...entry, isAdult }),
      steam: steamOf(userId, steamAppId),
    }));
  }

  private async toView(userId: number, entry: EntryRow) {
    const [view] = await this.toViews(userId, [entry]);
    return view;
  }
}
