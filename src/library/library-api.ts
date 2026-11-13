import {
  BadGatewayException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MediaType } from '../../prisma/generated/client';

export type Media = {
  id: string;
  type: 'ANIME' | 'MANGA' | 'GAME';
  sourceId: string;
  title: string;
  coverImage: string | null;
  year: number | null;
  score: number | null;
  isAdult?: boolean;
  synopsis?: string | null;
  bannerImage?: string | null;
  status?: string | null;
  genres?: string[];
  altTitles?: string[];
  source?: { provider: string; url: string };
  details?: Record<string, unknown>;
};

export const ADULT_CONTENT =
  'This title is 18+. Turn on Show NSFW content in Settings to see it';

const baseUrl = () =>
  (process.env.LIBRARY_API_URL ?? 'https://library.boseriko.com').replace(
    /\/$/,
    '',
  );

export function imageUrl(
  type: MediaType,
  sourceId: string,
  image: 'cover' | 'banner',
  adult = false,
) {
  return `${baseUrl()}/api/${type}/${sourceId}/${image}${adult ? '?adult=true' : ''}`;
}

export function coverUrl(entry: {
  mediaType: MediaType;
  sourceId: string;
  coverImage: string | null;
  isAdult: boolean;
}) {
  return entry.coverImage
    ? imageUrl(entry.mediaType, entry.sourceId, 'cover', entry.isAdult)
    : null;
}

async function request<T>(
  path: string,
  notFound = 'Title not found',
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new BadGatewayException('The library service is unavailable');
  }
  if (res.status === 404) throw new NotFoundException(notFound);
  if (res.status === 403) throw new ForbiddenException(ADULT_CONTENT);
  if (!res.ok) {
    throw new BadGatewayException('The library service is unavailable');
  }
  return (await res.json()) as T;
}

export async function searchMedia(q: string, adult: boolean) {
  const query = new URLSearchParams({ q, limit: '6' });
  if (adult) query.set('adult', 'true');
  const { results } = await request<{
    results: Record<'anime' | 'manga' | 'game', Media[]>;
  }>(`/api/search?${query}`);
  return results;
}

export type SteamMatch = {
  id: string;
  sourceId: string;
  title: string;
  coverImage: string | null;
  year: number | null;
  isAdult: boolean;
};

export async function matchSteamGames(appIds: string[]) {
  const { results } = await request<{ results: Record<string, SteamMatch> }>(
    `/api/steam?ids=${appIds.join(',')}`,
  );
  return results;
}

export const MEDIA_LISTS = ['trending', 'season', 'top', 'upcoming'] as const;

export type MediaList = (typeof MEDIA_LISTS)[number];

export async function getMediaList(
  type: MediaType,
  list: MediaList,
  adult: boolean,
) {
  const { items } = await request<{ items: Media[] }>(
    `/api/lists/${type}/${list}${adult ? '?adult=true' : ''}`,
  );
  return items;
}

export type SeasonName = 'winter' | 'spring' | 'summer' | 'fall';

export type Season = {
  type: Media['type'];
  season: SeasonName;
  year: number;
  startsAt: string;
  endsAt: string;
  items: Media[];
  updatedAt: string;
};

export function getSeason(type: MediaType, season: string, adult: boolean) {
  return request<Season>(
    `/api/seasons/${type}/${season}${adult ? '?adult=true' : ''}`,
    'Season not found',
  );
}

export type ChartEntry = {
  rank: number;
  previousRank: number | null;
  movement: 'up' | 'down' | 'same' | 'new';
  weeksOnChart: number;
  peak: number;
  media: Media;
};

export type Chart = {
  type: Media['type'];
  week: string;
  startsAt: string;
  endsAt: string;
  previousWeek: string | null;
  nextWeek: string | null;
  entries: ChartEntry[];
  updatedAt: string;
};

export function getChart(
  type: MediaType,
  week: string | undefined,
  adult: boolean,
) {
  const query = new URLSearchParams();
  if (week) query.set('week', week);
  if (adult) query.set('adult', 'true');
  const search = query.toString();
  return request<Chart>(
    `/api/charts/${type}${search && `?${search}`}`,
    'Chart not found',
  );
}

export function getMedia(type: MediaType, sourceId: string, adult: boolean) {
  return request<Media>(
    `/api/${type}/${sourceId}${adult ? '?adult=true' : ''}`,
  );
}

export type AiringEpisode = {
  id: string;
  episode: number;
  airsAt: string;
};

export type Schedule = {
  month: string;
  startsAt: string;
  endsAt: string;
  episodes: AiringEpisode[];
};

export const SCHEDULE_BATCH = 50;

export async function getSchedule(
  month: string,
  ids: string[],
  adult: boolean,
) {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += SCHEDULE_BATCH) {
    batches.push(ids.slice(i, i + SCHEDULE_BATCH));
  }
  const schedules = await Promise.all(
    batches.map((batch) =>
      request<Schedule>(
        `/api/schedule?month=${month}&ids=${batch.join(',')}${adult ? '&adult=true' : ''}`,
      ),
    ),
  );
  return schedules.flatMap((schedule) => schedule.episodes);
}
