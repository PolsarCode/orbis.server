import { Injectable, Logger } from '@nestjs/common';
import { MediaType } from '../../prisma/generated/client';
import { GUEST_USER_ID } from '../auth/allow-guest';
import { fetchImage } from '../common/fetch-image';
import { DAY } from '../common/throttle';
import { webUrl } from '../common/web-url';
import { LibraryService } from './library.service';

const POSTING_WINDOW_MS = DAY;
const IMAGE_TIMEOUT_MS = 30_000;

export const CHART_TYPES = Object.values(MediaType);

export const CHART_LABELS: Record<MediaType, string> = {
  anime: 'Anime',
  manga: 'Manga',
  game: 'Games',
};

export type ChartWeek = { week: string; startsAt: string; endsAt: string };
export type ChartImage = {
  filename: string;
  data: Buffer;
  description: string;
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

export function fullDate(date: string) {
  return dayWithYear.format(new Date(date));
}

export function weekRange({ startsAt, endsAt }: ChartWeek) {
  const start = new Date(startsAt);
  const end = new Date(Date.parse(endsAt) - 1);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  return `${(sameYear ? day : dayWithYear).format(start)} – ${dayWithYear.format(end)}`;
}

export function typeList(types: MediaType[]) {
  const labels = types.map((type) => CHART_LABELS[type]);
  const last = labels.pop();
  return labels.length ? `${labels.join(', ')} and ${last}` : (last ?? '');
}

@Injectable()
export class ChartShareService {
  private readonly logger = new Logger(ChartShareService.name);
  private images = new Map<MediaType, { week: string; data: Buffer }>();

  constructor(private library: LibraryService) {}

  current(type: MediaType) {
    return this.library.chart(GUEST_USER_ID, type);
  }

  async startedToday(types: MediaType[]) {
    const charts = new Map<MediaType, ChartWeek | null>();
    for (const type of types) {
      try {
        const chart = await this.current(type);
        const sinceStart = Date.now() - Date.parse(chart.startsAt);
        if (sinceStart >= 0 && sinceStart < POSTING_WINDOW_MS) {
          charts.set(type, chart);
        }
      } catch (error) {
        this.logger.warn(
          `Couldn’t load the ${type} chart: ${(error as Error).message}`,
        );
        charts.set(type, null);
      }
    }
    return charts;
  }

  async image(type: MediaType, chart: ChartWeek): Promise<ChartImage> {
    return {
      filename: `orbis-${type}-chart-${chart.startsAt.slice(0, 10)}.png`,
      data: await this.imageData(type, chart.week),
      description: `${CHART_LABELS[type]} chart · ${weekRange(chart)}`,
    };
  }

  private async imageData(type: MediaType, week: string) {
    const cached = this.images.get(type);
    if (cached?.week === week) return cached.data;

    const data = await fetchImage(
      `${webUrl()}/charts/${type}/image?${new URLSearchParams({ week })}`,
      IMAGE_TIMEOUT_MS,
    );
    this.images.set(type, { week, data });
    return data;
  }
}
