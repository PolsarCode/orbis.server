import { MediaType } from '../../prisma/generated/client';
import { DAY } from '../common/throttle';
import { webUrl } from '../common/web-url';
import { startOfDay } from '../common/weekly-window';
import { chartShortPath } from '../library/chart-link';
import { CHART_LABELS, CHART_TYPES } from '../library/chart-share.service';

export const FACEBOOK_POST_KINDS = [
  'cover',
  'spotlight',
  'debate',
  'most-added',
  'hashtags',
  'community',
  'tip',
  'season',
  'coming',
] as const;

export type FacebookPostKind = (typeof FACEBOOK_POST_KINDS)[number];
export type SeasonKind = Extract<FacebookPostKind, 'season' | 'coming'>;
export type WeeklyKind = Exclude<FacebookPostKind, SeasonKind>;

export type Season = { id: string; title: string; startsAt: Date };

export type Tip = {
  id: string;
  title: string;
  body: string;
  href: string | null;
};

const POSTS_FROM_HOUR = 4;
const EXCERPT_LENGTH = 220;
const SEASON_NAMES = ['winter', 'spring', 'summer', 'fall'] as const;

const WEEKDAYS: Record<WeeklyKind, number> = {
  tip: 0,
  cover: 1,
  spotlight: 2,
  debate: 3,
  'most-added': 4,
  hashtags: 5,
  community: 6,
};

const DAYS_AFTER_START: Record<MediaType, number> = {
  anime: 0,
  manga: 1,
  game: 2,
};

const DAYS_BEFORE_START: Record<MediaType, number> = {
  anime: 14,
  game: 13,
  manga: 12,
};

const SEASON_LINES: Record<MediaType, (season: string) => string> = {
  anime: (season) =>
    `${season} anime is here! The most popular new shows this season.`,
  manga: (season) =>
    `${season} manga is here! The most popular new manga this season.`,
  game: (season) =>
    `${season} games are here! The most popular games out this season.`,
};

export function isFacebookPostKind(value: string): value is FacebookPostKind {
  return (FACEBOOK_POST_KINDS as readonly string[]).includes(value);
}

export function isSeasonKind(kind: FacebookPostKind): kind is SeasonKind {
  return kind === 'season' || kind === 'coming';
}

export function postingStarted(now: Date) {
  return now.getUTCHours() >= POSTS_FROM_HOUR;
}

export function weeklyDue(kind: WeeklyKind, now: Date) {
  return postingStarted(now) && now.getUTCDay() === WEEKDAYS[kind];
}

export function seasonFor(kind: SeasonKind, now: Date): Season {
  const index = Math.floor(now.getUTCMonth() / 3) + (kind === 'coming' ? 1 : 0);
  const year = now.getUTCFullYear() + Math.floor(index / 4);
  const name = SEASON_NAMES[index % 4];
  return {
    id: `${year}-${name}`,
    title: `${name[0].toUpperCase()}${name.slice(1)} ${year}`,
    startsAt: new Date(Date.UTC(year, (index % 4) * 3, 1)),
  };
}

export function seasonTypesDue(kind: SeasonKind, now: Date): MediaType[] {
  if (!postingStarted(now)) return [];
  const days =
    (startOfDay(now).getTime() - seasonFor(kind, now).startsAt.getTime()) / DAY;
  return CHART_TYPES.filter((type) =>
    kind === 'season'
      ? days === DAYS_AFTER_START[type]
      : -days === DAYS_BEFORE_START[type],
  );
}

export function rotation(week: string) {
  const start = Number(week.slice(6));
  return CHART_TYPES.map(
    (_type, index) => CHART_TYPES[(start + index) % CHART_TYPES.length],
  );
}

export function facebookImage(path: string, params?: Record<string, string>) {
  return `${webUrl()}/facebook/${path}/image${params ? `?${new URLSearchParams(params)}` : ''}`;
}

export function typeLabel(type: MediaType) {
  return CHART_LABELS[type].toLowerCase();
}

export function discoverLink(type: MediaType) {
  const params = new URLSearchParams({ tab: 'discover' });
  if (type !== MediaType.anime) params.set('type', type);
  return `${webUrl()}/library?${params}`;
}

export function excerpt(text: string) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= EXCERPT_LENGTH) return clean;
  const cut = clean.slice(0, EXCERPT_LENGTH + 1);
  const end = cut.lastIndexOf(' ');
  const kept = end > 0 ? cut.slice(0, end) : cut.slice(0, EXCERPT_LENGTH);
  return `${kept.replace(/[\s.,;:!?–—-]+$/u, '')}…`;
}

export function spotlightCaption(
  type: MediaType,
  media: { sourceId: string; title: string; synopsis: string },
) {
  return `${CHART_LABELS[type]} spotlight: ${media.title}\n\n${excerpt(media.synopsis)}\n\nSee it on Orbis: ${webUrl()}/library/${type}/${encodeURIComponent(media.sourceId)}`;
}

export function debateCaption(type: MediaType, week: string, comments: number) {
  return `${comments.toLocaleString('en-US')} comments on this week’s ${typeLabel(type)} chart so far. Does #1 deserve it?\n\nJoin the debate: ${webUrl()}${chartShortPath(type, week)}`;
}

export function mostAddedCaption(type: MediaType, titles: string[]) {
  const lines = titles.map((title, index) => `${index + 1}. ${title}`);
  return `The most added ${typeLabel(type)} on Orbis this week:\n${lines.join('\n')}\n\nKeep track of yours: ${discoverLink(type)}`;
}

export function hashtagsCaption(tags: { name: string; display: string }[]) {
  const listed = tags.map(({ display }) => `#${display}`).join(', ');
  return `Trending on Orbis this week: ${listed}\n\n${webUrl()}/tags/${encodeURIComponent(tags[0].name)}`;
}

export function communityCaption(community: {
  id: number;
  name: string;
  description: string | null;
}) {
  const about = community.description?.trim()
    ? `${excerpt(community.description)}\n\n`
    : '';
  return `Community of the week: ${community.name}!\n\n${about}Join them on Orbis: ${webUrl()}/communities/${community.id}`;
}

export function tipCaption(tip: Tip) {
  return `Tip of the week: ${tip.title}\n\n${tip.body}\n\n${webUrl()}${tip.href ?? ''}`;
}

export function seasonCaption(type: MediaType, season: Season) {
  return `${SEASON_LINES[type](season.title)}\n\nFind them on Orbis: ${discoverLink(type)}`;
}

export function comingCaption(type: MediaType, season: Season) {
  return `Coming in ${season.title}: the ${typeLabel(type)} everyone’s waiting for.\n\nGet ready on Orbis: ${discoverLink(type)}`;
}
