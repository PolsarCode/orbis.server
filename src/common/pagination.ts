import { BadRequestException } from '@nestjs/common';
import { MAX_INT } from '../communities/community-member.guard';

export const PAGE_SIZE = 10;

export type Page<T> = { items: T[]; nextCursor: string | null };

export type TimeCursor = { createdAt: Date; id: number };

export function parseTimeCursor(raw?: string): TimeCursor | undefined {
  if (raw === undefined) return undefined;

  const match = /^(\d{1,15})_(\d{1,10})$/.exec(raw);
  const id = Number(match?.[2]);
  if (!match || id < 1 || id > MAX_INT) {
    throw new BadRequestException('Invalid cursor');
  }

  return { createdAt: new Date(Number(match[1])), id };
}

export function createdBefore(cursor?: TimeCursor) {
  if (!cursor) return {};
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

export function cursorPage<T extends TimeCursor>(rows: T[]): Page<T> {
  const items = rows.slice(0, PAGE_SIZE);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      rows.length > PAGE_SIZE ? `${last.createdAt.getTime()}_${last.id}` : null,
  };
}
