import { BadRequestException } from '@nestjs/common';
import { DAY } from './throttle';

export const WINDOW_DAYS = 7;
const PAST_DAYS = 60;

export function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function startOfDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export function windowRange(until: Date) {
  return {
    startsAt: new Date(until.getTime() - WINDOW_DAYS * DAY),
    endsAt: until,
  };
}

export function parseUntil(raw: string | undefined, now = new Date()) {
  const today = startOfDay(now);
  if (!raw) return today;

  const until = new Date(`${raw}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(raw) ||
    Number.isNaN(until.getTime()) ||
    dayKey(until) !== raw ||
    until.getTime() > today.getTime() + DAY ||
    until.getTime() < now.getTime() - PAST_DAYS * DAY
  ) {
    throw new BadRequestException('That date isn’t available');
  }
  return until;
}
