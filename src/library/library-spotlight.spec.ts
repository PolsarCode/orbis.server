import { LibraryService } from './library.service';
import { getMedia } from './library-api';
import { PrismaService } from '../prisma.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';

jest.mock('./library-api', () => ({
  ...jest.requireActual('./library-api'),
  getMedia: jest.fn(),
}));

const media = getMedia as jest.Mock;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 29, 12);

type Saved = {
  items: { sourceId: string; addedAt: number }[];
  retired: string[];
  checkedAt: number;
};

describe('Anime spotlight', () => {
  const prisma = {
    setting: { findUnique: jest.fn(), upsert: jest.fn() },
    libraryEntry: { findMany: jest.fn() },
  };
  const library = new LibraryService(
    prisma as unknown as PrismaService,
    {} as DiscordChannelService,
  );

  function stored(list: Saved | null) {
    prisma.setting.findUnique.mockResolvedValue(
      list && { value: JSON.stringify(list) },
    );
  }

  function saved(): Saved {
    const [{ update }] = prisma.setting.upsert.mock.calls.at(-1) as [
      { update: { value: string } },
    ];
    return JSON.parse(update.value) as Saved;
  }

  function item(sourceId: string, addedAt = NOW) {
    return {
      type: 'anime',
      sourceId,
      title: sourceId,
      coverImage: `${sourceId}.webp`,
      bannerImage: `${sourceId}-banner.webp`,
      addedAt,
    };
  }

  function candidates(...ids: string[]) {
    prisma.libraryEntry.findMany.mockResolvedValue(
      ids.map((sourceId) => ({ sourceId, title: sourceId, coverImage: null })),
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    media.mockImplementation((_type: string, sourceId: string) =>
      sourceId === 'broken'
        ? Promise.reject(new Error('unavailable'))
        : Promise.resolve({
            title: `Title ${sourceId}`,
            isAdult: sourceId === 'adult',
            coverImage: `${sourceId}.webp`,
            bannerImage: `${sourceId}-banner.webp`,
          }),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('fills an empty list with 10 recent anime that roll off one at a time', async () => {
    stored(null);
    candidates('1', 'adult', 'broken', ...'23456789'.split(''), '10', '11');

    await library.spotlight();

    const list = saved();
    const ids = list.items.map(({ sourceId }) => sourceId);
    expect(ids).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(media).toHaveBeenCalledTimes(12);
    expect(prisma.libraryEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          mediaType: 'anime',
          isPublic: true,
          isAdult: false,
          user: { isPublic: true },
          sourceId: { notIn: [] },
        },
        distinct: ['sourceId'],
      }),
    );
    const ages = list.items.map(({ addedAt }) => NOW - addedAt);
    expect(new Set(ages).size).toBe(10);
    expect(Math.max(...ages)).toBe(DAY * 0.9);
  });

  it('leaves a fresh list alone and asks nothing', async () => {
    const items = Array.from({ length: 10 }, (_, i) => item(`a${i}`));
    stored({ items, retired: [], checkedAt: NOW });

    const spotlight = await library.spotlight();

    expect(spotlight?.sourceId).toMatch(/^a\d$/);
    expect(spotlight).not.toHaveProperty('addedAt');
    expect(prisma.libraryEntry.findMany).not.toHaveBeenCalled();
    expect(media).not.toHaveBeenCalled();
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });

  it('swaps only the oldest after 24 hours, without duplicates or bringing it straight back', async () => {
    const items = [
      ...Array.from({ length: 9 }, (_, i) => item(`a${i}`, NOW - HOUR)),
      item('old', NOW - DAY),
    ];
    stored({ items, retired: [], checkedAt: NOW - HOUR });
    candidates('old', 'new');

    await library.spotlight();

    expect(prisma.libraryEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceId: { notIn: items.slice(0, 9).map((i) => i.sourceId) },
        }),
      }),
    );
    expect(media).toHaveBeenCalledTimes(1);
    expect(media).toHaveBeenCalledWith('anime', 'new', false);
    const list = saved();
    const ids = list.items.map(({ sourceId }) => sourceId);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    expect(ids).toContain('new');
    expect(ids).not.toContain('old');
    expect(list.retired).toEqual(['old']);
    expect(list.items.find((i) => i.sourceId === 'new')?.addedAt).toBe(NOW);
  });

  it('brings a retired anime back only when nothing else is available', async () => {
    const items = [
      ...Array.from({ length: 9 }, (_, i) => item(`a${i}`, NOW - HOUR)),
      item('old', NOW - DAY),
    ];
    stored({ items, retired: [], checkedAt: NOW - HOUR });
    candidates('old');

    await library.spotlight();

    expect(saved().items.map(({ sourceId }) => sourceId)).toContain('old');
  });

  it('waits an hour before asking again when nothing could be added', async () => {
    stored({ items: [], retired: [], checkedAt: 0 });
    candidates('broken');

    await expect(library.spotlight()).resolves.toBeNull();
    expect(saved()).toEqual({ items: [], retired: [], checkedAt: NOW });

    stored({ items: [], retired: [], checkedAt: NOW - HOUR / 2 });
    prisma.libraryEntry.findMany.mockClear();
    await expect(library.spotlight()).resolves.toBeNull();
    expect(prisma.libraryEntry.findMany).not.toHaveBeenCalled();

    stored({ items: [], retired: [], checkedAt: NOW - HOUR });
    await library.spotlight();
    expect(prisma.libraryEntry.findMany).toHaveBeenCalledTimes(1);
  });
});
