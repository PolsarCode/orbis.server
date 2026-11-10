import { MediaType } from '../../prisma/generated/client';

const SHORT_TYPES: MediaType[] = [
  MediaType.anime,
  MediaType.manga,
  MediaType.game,
];
const FIRST_YEAR = 2020;
const WEEKS = 53;
const HALF = 216;
const ROUND_KEYS = [151, 37, 199, 88];
const ALPHABET = 'k7q2xm9fa0z4cvh1tjr8bwn5gyps3due6loi';

const mix = (value: number, key: number) =>
  ((value + key) * (value + key) * 7 + key) % HALF;

export function chartPath(type: MediaType, week: string) {
  const params = new URLSearchParams({ tab: 'charts' });
  if (type !== MediaType.anime) params.set('type', type);
  params.set('week', week);
  return `/library?${params}#discussion`;
}

export function chartShortPath(type: MediaType, week: string) {
  const weekIndex =
    (Number(week.slice(0, 4)) - FIRST_YEAR) * WEEKS + Number(week.slice(6)) - 1;
  const index = weekIndex * SHORT_TYPES.length + SHORT_TYPES.indexOf(type);
  let left = Math.floor(index / HALF);
  let right = index % HALF;
  for (const key of ROUND_KEYS) {
    [left, right] = [right, (left + mix(right, key)) % HALF];
  }
  const scrambled = left * HALF + right;
  const code = [36 * 36, 36, 1]
    .map((place) => ALPHABET[Math.floor(scrambled / place) % 36])
    .join('');
  return `/c/${code}`;
}
