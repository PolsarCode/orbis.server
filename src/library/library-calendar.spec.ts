import { BadRequestException } from '@nestjs/common';
import { LibraryService } from './library.service';
import { PrismaService } from '../prisma.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';

function entry(id: number, mediaType: 'anime' | 'game', sourceId: string) {
  return {
    id,
    mediaType,
    sourceId,
    title: `Title ${sourceId}`,
    coverImage: `${sourceId}.webp`,
    isAdult: false,
  };
}

function game(
  sourceId: string,
  releaseDate: string | null,
  precision: string | null,
) {
  return {
    id: `GAME_${sourceId}`,
    type: 'GAME',
    sourceId,
    title: `Title ${sourceId}`,
    coverImage: null,
    year: null,
    score: null,
    details: { releaseDate, releaseDatePrecision: precision },
  };
}

describe('Library calendar', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    libraryEntry: { findMany: jest.fn() },
  };
  let fetchMock: jest.SpyInstance;
  let library: LibraryService;
  const responses = new Map<string, unknown>();

  const urls = () => fetchMock.mock.calls.map(([url]) => String(url));

  beforeEach(() => {
    jest.clearAllMocks();
    responses.clear();
    jest
      .spyOn(Date, 'now')
      .mockImplementation(() => Date.parse('2026-11-14T12:00:00.000Z'));
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      const body = responses.get(path);
      return {
        status: body === undefined ? 404 : 200,
        ok: body !== undefined,
        json: async () => body,
      } as Response;
    });
    library = new LibraryService(
      prisma as unknown as PrismaService,
      {} as DiscordChannelService,
    );
    prisma.user.findUnique.mockResolvedValue({ showNsfw: false });
    prisma.libraryEntry.findMany.mockResolvedValue([]);
  });

  afterEach(() => jest.restoreAllMocks());

  it('asks only for anime being watched and games planned', async () => {
    await library.calendar(4, '2026-11');
    expect(prisma.libraryEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 4,
          OR: [
            { mediaType: 'anime', status: 'current' },
            { mediaType: 'game', status: 'planned' },
          ],
        }),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('joins airing episodes to the anime in the library', async () => {
    prisma.libraryEntry.findMany.mockResolvedValue([
      entry(1, 'anime', '21'),
      entry(2, 'anime', '52991'),
    ]);
    responses.set('/api/schedule', {
      month: '2026-11',
      episodes: [
        { id: '21', episode: 1150, airsAt: '2026-11-15T00:30:00.000Z' },
        { id: '999', episode: 1, airsAt: '2026-11-16T00:30:00.000Z' },
      ],
    });

    const calendar = await library.calendar(4, '2026-11');

    expect(urls()).toEqual([
      expect.stringMatching(/\/api\/schedule\?month=2026-11&ids=21,52991$/),
    ]);
    expect(calendar.episodes).toEqual([
      {
        entryId: 1,
        sourceId: '21',
        title: 'Title 21',
        coverImage: expect.stringMatching(/\/api\/anime\/21\/cover$/),
        episode: 1150,
        airsAt: '2026-11-15T00:30:00.000Z',
      },
    ]);
  });

  it('keeps the schedule for an hour', async () => {
    prisma.libraryEntry.findMany.mockResolvedValue([entry(1, 'anime', '21')]);
    responses.set('/api/schedule', { episodes: [] });

    await library.calendar(4, '2026-11');
    await library.calendar(4, '2026-11');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the schedule for months the library has no schedule for', async () => {
    prisma.libraryEntry.findMany.mockResolvedValue([entry(1, 'anime', '21')]);

    const calendar = await library.calendar(4, '2027-06');

    expect(calendar.episodes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps only games that are not out yet', async () => {
    prisma.libraryEntry.findMany.mockResolvedValue([
      entry(1, 'game', '10'),
      entry(2, 'game', '11'),
      entry(3, 'game', '12'),
      entry(4, 'game', '13'),
      entry(5, 'game', '14'),
      entry(6, 'game', '15'),
    ]);
    responses.set(
      '/api/game/10',
      game('10', '2026-12-04T00:00:00.000Z', 'day'),
    );
    responses.set(
      '/api/game/11',
      game('11', '2026-11-01T00:00:00.000Z', 'month'),
    );
    responses.set(
      '/api/game/12',
      game('12', '2026-11-10T00:00:00.000Z', 'day'),
    );
    responses.set('/api/game/13', game('13', null, null));
    responses.set(
      '/api/game/14',
      game('14', '2026-01-01T00:00:00.000Z', 'year'),
    );

    const calendar = await library.calendar(4, '2026-11');

    expect(
      calendar.games.map(({ sourceId, releaseDate, precision }) => [
        sourceId,
        releaseDate,
        precision,
      ]),
    ).toEqual([
      ['10', '2026-12-04T00:00:00.000Z', 'day'],
      ['11', '2026-11-01T00:00:00.000Z', 'month'],
      ['13', null, null],
      ['14', '2026-01-01T00:00:00.000Z', 'year'],
    ]);
  });

  it('asks for 18+ titles only for people who show NSFW', async () => {
    prisma.user.findUnique.mockResolvedValue({ showNsfw: true });
    prisma.libraryEntry.findMany.mockResolvedValue([entry(1, 'anime', '21')]);
    responses.set('/api/schedule', { episodes: [] });

    await library.calendar(4, '2026-11');

    expect(urls()[0]).toMatch(/&adult=true$/);
  });

  it('refuses a malformed month', async () => {
    await expect(library.calendar(4, 'november')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(library.calendar(4, '2026-13')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
