import { plainText } from '../discord-channel/discord-message';
import { DAY } from '../common/throttle';

export const PHRASE_MAX = 50;

export const MAX_KEYWORD_FILTERS = 100;

export const FILTER_DURATIONS = ['forever', 'day', 'week', 'month'] as const;

export type FilterDuration = (typeof FILTER_DURATIONS)[number];

const DURATION_DAYS: Record<FilterDuration, number | null> = {
  forever: null,
  day: 1,
  week: 7,
  month: 30,
};

export function expiryOf(duration: FilterDuration, now = new Date()) {
  const days = DURATION_DAYS[duration];
  return days === null ? null : new Date(now.getTime() + days * DAY);
}

const BOUNDARY = '[\\p{L}\\p{N}_]';

export function normalizePhrase(raw: string) {
  return raw.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export type PhraseMatcher = { phrase: string; pattern: RegExp };

function patternFor(phrase: string) {
  const escaped = phrase
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/ /g, '\\s+');
  return CJK.test(phrase)
    ? new RegExp(escaped, 'u')
    : new RegExp(`(?<!${BOUNDARY})${escaped}(?!${BOUNDARY})`, 'u');
}

export function compilePhrases(phrases: string[]): PhraseMatcher[] {
  return phrases.map((phrase) => ({ phrase, pattern: patternFor(phrase) }));
}

export function filteredPhrase(
  matchers: PhraseMatcher[],
  html: string,
  ...notes: (string | null | undefined)[]
) {
  if (matchers.length === 0) return null;
  const text = [plainText(html), ...notes]
    .filter(Boolean)
    .join('\n')
    .normalize('NFC')
    .toLowerCase();
  return matchers.find(({ pattern }) => pattern.test(text))?.phrase ?? null;
}
