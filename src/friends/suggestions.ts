import type { LibraryStatus, MediaType } from '../../prisma/generated/client';
import { HOUR } from '../common/throttle';

export const SUGGESTION_LIMIT = 10;
export const MUTUAL_PREVIEW = 3;
export const SHARED_STATUSES: LibraryStatus[] = ['current', 'completed'];
export const DISMISSAL_DAYS = 30;

export function dismissedSince(now = new Date()) {
  return new Date(now.getTime() - DISMISSAL_DAYS * 24 * HOUR);
}

const WEIGHTS = { mutual: 3, community: 2, title: 1 };

export type SuggestionSlots = {
  suggestionSlots: number;
  suggestionSlotsAt: Date | null;
};

export const slotFields = {
  suggestionSlots: true,
  suggestionSlotsAt: true,
} as const;

function hoursSince(date: Date, now: Date) {
  return Math.floor((now.getTime() - date.getTime()) / HOUR);
}

export function availableSlots(
  { suggestionSlots, suggestionSlotsAt }: SuggestionSlots,
  now = new Date(),
) {
  const refilled = suggestionSlotsAt
    ? hoursSince(suggestionSlotsAt, now)
    : SUGGESTION_LIMIT;
  return Math.max(0, Math.min(SUGGESTION_LIMIT, suggestionSlots + refilled));
}

export function spendSlot(
  state: SuggestionSlots,
  now = new Date(),
): SuggestionSlots {
  const available = availableSlots(state, now);
  const suggestionSlots = Math.max(0, available - 1);
  if (available >= SUGGESTION_LIMIT || !state.suggestionSlotsAt) {
    return { suggestionSlots, suggestionSlotsAt: now };
  }
  const hours = hoursSince(state.suggestionSlotsAt, now);
  return {
    suggestionSlots,
    suggestionSlotsAt: new Date(
      state.suggestionSlotsAt.getTime() + hours * HOUR,
    ),
  };
}

export type Signals = {
  mutual: Map<number, number[]>;
  communities: Map<number, number>;
  titles: Map<number, number>;
};

export function rankCandidates({ mutual, communities, titles }: Signals) {
  const mutualCount = (id: number) => mutual.get(id)?.length ?? 0;
  const score = (id: number) =>
    mutualCount(id) * WEIGHTS.mutual +
    (communities.get(id) ?? 0) * WEIGHTS.community +
    (titles.get(id) ?? 0) * WEIGHTS.title;

  return [
    ...new Set([...mutual.keys(), ...communities.keys(), ...titles.keys()]),
  ].sort(
    (a, b) => score(b) - score(a) || mutualCount(b) - mutualCount(a) || b - a,
  );
}

const verbs: Record<MediaType, string> = {
  anime: 'watching',
  manga: 'reading',
  game: 'playing',
};

export function mutualReason(count: number) {
  return count === 1 ? '1 mutual friend' : `${count} mutual friends`;
}

export function communityReason(name: string) {
  return `In ${name}`;
}

export function titleReason({
  title,
  mediaType,
  status,
}: {
  title: string;
  mediaType: MediaType;
  status: LibraryStatus;
}) {
  return status === 'completed'
    ? `Also finished ${title}`
    : `Also ${verbs[mediaType]} ${title}`;
}
