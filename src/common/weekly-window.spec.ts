import { BadRequestException } from '@nestjs/common';
import {
  dayKey,
  parseUntil,
  startOfDay,
  WINDOW_DAYS,
  windowRange,
} from './weekly-window';

const now = new Date('2026-11-11T15:30:00.000Z');
const refused = new BadRequestException('That date isn’t available');

describe('Weekly windows', () => {
  it('names and starts days in UTC', () => {
    const late = new Date('2026-11-11T23:59:59.999Z');
    expect(dayKey(late)).toBe('2026-11-11');
    expect(startOfDay(late)).toEqual(new Date('2026-11-11T00:00:00.000Z'));
    expect(startOfDay(new Date('2026-11-12T00:00:00.000Z'))).toEqual(
      new Date('2026-11-12T00:00:00.000Z'),
    );
  });

  it('covers the seven days before the end date', () => {
    const until = new Date('2026-11-11T00:00:00.000Z');
    expect(WINDOW_DAYS).toBe(7);
    expect(windowRange(until)).toEqual({
      startsAt: new Date('2026-11-04T00:00:00.000Z'),
      endsAt: until,
    });
  });
});

describe('Choosing the end date', () => {
  it('ends at the start of today when no date is given', () => {
    const today = new Date('2026-11-11T00:00:00.000Z');
    expect(parseUntil(undefined, now)).toEqual(today);
    expect(parseUntil('', now)).toEqual(today);
  });

  it('accepts a day from tomorrow back to 60 days ago, at midnight UTC', () => {
    expect(parseUntil('2026-11-12', now)).toEqual(
      new Date('2026-11-12T00:00:00.000Z'),
    );
    expect(parseUntil('2026-11-11', now)).toEqual(
      new Date('2026-11-11T00:00:00.000Z'),
    );
    expect(parseUntil('2026-09-13', now)).toEqual(
      new Date('2026-09-13T00:00:00.000Z'),
    );
  });

  it('refuses days after tomorrow or more than 60 days ago', () => {
    expect(() => parseUntil('2026-11-13', now)).toThrow(refused);
    expect(() => parseUntil('2026-09-12', now)).toThrow(refused);
  });

  it('refuses anything that isn’t a real calendar date', () => {
    for (const raw of [
      '2026-11-1',
      '11-11-2026',
      '2026-11-11T00:00:00Z',
      '2026-11-11 ',
      '2026-13-01',
      '2026-02-30',
      'today',
    ]) {
      expect(() => parseUntil(raw, now)).toThrow(refused);
    }
  });

  it('accepts leap days only in leap years', () => {
    const leap = new Date('2028-03-01T12:00:00.000Z');
    expect(parseUntil('2028-02-29', leap)).toEqual(
      new Date('2028-02-29T00:00:00.000Z'),
    );
    expect(() =>
      parseUntil('2027-02-29', new Date('2027-03-01T12:00:00.000Z')),
    ).toThrow(refused);
  });
});
