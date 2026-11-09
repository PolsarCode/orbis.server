import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { LibraryService } from './library.service';
import { LibraryController } from './library.controller';
import { ALLOW_GUEST } from '../auth/allow-guest';
import { PrismaService } from '../prisma.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';
import { MediaType } from '../../prisma/generated/client';

function media(sourceId: string) {
  return {
    id: `ANIME_${sourceId}`,
    type: 'ANIME',
    sourceId,
    title: `Title ${sourceId}`,
    coverImage: `${sourceId}.webp`,
    year: 2026,
    score: 8.5,
    status: 'RELEASING',
    genres: ['Action'],
    details: { episodes: 12 },
  };
}

const chart = {
  type: 'ANIME',
  week: '2026-W45',
  startsAt: '2026-11-02T00:00:00.000Z',
  endsAt: '2026-11-09T00:00:00.000Z',
  previousWeek: '2026-W44',
  nextWeek: null,
  updatedAt: '2026-11-02T08:00:00.000Z',
  entries: [
    {
      rank: 1,
      previousRank: 3,
      movement: 'up',
      weeksOnChart: 2,
      peak: 1,
      media: media('1'),
    },
    {
      rank: 2,
      previousRank: null,
      movement: 'new',
      weeksOnChart: 1,
      peak: 2,
      media: media('2'),
    },
  ],
};

describe('Weekly charts', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    libraryEntry: { findMany: jest.fn() },
    chartDiscussion: { upsert: jest.fn() },
  };
  let fetchMock: jest.SpyInstance;
  let library: LibraryService;

  function respond(status: number, body: unknown = {}) {
    fetchMock.mockResolvedValueOnce({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    } as Response);
  }

  const requested = () => String(fetchMock.mock.calls.at(-1)?.[0]);

  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('No response queued'));
    library = new LibraryService(
      prisma as unknown as PrismaService,
      {} as DiscordChannelService,
    );
    prisma.user.findUnique.mockResolvedValue({ showNsfw: false });
    prisma.libraryEntry.findMany.mockResolvedValue([]);
  });

  afterEach(() => jest.restoreAllMocks());

  it('asks the library for the chart, passing the week and 18+ setting through', async () => {
    respond(200, chart);
    await library.chart(0, MediaType.anime);
    expect(requested()).toMatch(/\/api\/charts\/anime$/);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();

    respond(200, chart);
    await library.chart(5, MediaType.manga, '2026-W45');
    expect(requested()).toMatch(/\/api\/charts\/manga\?week=2026-W45$/);

    prisma.user.findUnique.mockResolvedValue({ showNsfw: true });
    respond(200, chart);
    await library.chart(6, MediaType.game, '2026-W44');
    expect(requested()).toMatch(
      /\/api\/charts\/game\?week=2026-W44&adult=true$/,
    );
  });

  it('keeps the chart as it is and shapes each title like a list item', async () => {
    respond(200, chart);
    prisma.libraryEntry.findMany.mockResolvedValue([
      { id: 9, mediaId: 'ANIME_2', status: 'current', isPublic: false },
    ]);

    const result = await library.chart(5, MediaType.anime);

    expect(result).toMatchObject({
      week: '2026-W45',
      startsAt: chart.startsAt,
      endsAt: chart.endsAt,
      previousWeek: '2026-W44',
      nextWeek: null,
    });
    expect(
      result.entries.map(({ rank, movement, previousRank }) => [
        rank,
        movement,
        previousRank,
      ]),
    ).toEqual([
      [1, 'up', 3],
      [2, 'new', null],
    ]);
    expect(result.entries[0].media).toMatchObject({
      type: 'anime',
      sourceId: '1',
      genres: ['Action'],
      releaseStatus: 'RELEASING',
      details: { episodes: 12 },
      inLibrary: false,
      entry: null,
    });
    expect(result.entries[1].media).toMatchObject({
      inLibrary: true,
      entry: { id: 9, status: 'current', isPublic: false },
    });
  });

  it('skips the library lookup for guests', async () => {
    respond(200, chart);

    const result = await library.chart(0, MediaType.anime);

    expect(prisma.libraryEntry.findMany).not.toHaveBeenCalled();
    expect(result.entries.every(({ media }) => !media.inLibrary)).toBe(true);
  });

  it('reports a week the library doesn’t have as not found', async () => {
    respond(404, { error: 'Not found' });

    await expect(library.chart(5, MediaType.anime, '2020-W01')).rejects.toThrow(
      new NotFoundException('Chart not found'),
    );
  });

  it('refuses a malformed week without asking the library', async () => {
    await expect(
      library.chart(5, MediaType.anime, '2026-45&adult=true'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports other library failures as unavailable', async () => {
    respond(502, { error: 'Upstream failed' });

    await expect(library.chart(5, MediaType.anime)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  describe('caching', () => {
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;
    const thisWeek = {
      ...chart,
      week: '2026-W46',
      startsAt: '2026-11-09T00:00:00.000Z',
      endsAt: '2026-11-16T00:00:00.000Z',
      previousWeek: '2026-W45',
      nextWeek: null,
    };
    let now: number;

    beforeEach(() => {
      now = Date.parse('2026-11-12T12:00:00.000Z');
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    it('keeps this week’s chart for an hour, but never past the end of the week', async () => {
      respond(200, thisWeek);
      await library.chart(5, MediaType.anime);
      now += HOUR / 2;
      await library.chart(5, MediaType.anime);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      now += HOUR;
      respond(200, thisWeek);
      await library.chart(5, MediaType.anime);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      now = Date.parse(thisWeek.endsAt) - 10 * 60 * 1000;
      respond(200, thisWeek);
      await library.chart(5, MediaType.anime);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      now += 11 * 60 * 1000;
      respond(200, { ...thisWeek, week: '2026-W47' });
      const next = await library.chart(5, MediaType.anime);
      expect(next.week).toBe('2026-W47');
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('keeps a past week for days once it links to the next week', async () => {
      respond(200, { ...chart, nextWeek: '2026-W46' });
      await library.chart(5, MediaType.anime, '2026-W45');
      now += 3 * DAY;
      await library.chart(5, MediaType.anime, '2026-W45');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('asks again hourly about a past week with no next week yet', async () => {
      respond(200, chart);
      await library.chart(5, MediaType.anime, '2026-W45');
      now += HOUR / 2;
      await library.chart(5, MediaType.anime, '2026-W45');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      now += HOUR;
      respond(200, { ...chart, nextWeek: '2026-W46' });
      const result = await library.chart(5, MediaType.anime, '2026-W45');
      expect(result.nextWeek).toBe('2026-W46');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps each week and 18+ variant apart', async () => {
      respond(200, thisWeek);
      await library.chart(5, MediaType.anime);
      respond(200, thisWeek);
      await library.chart(5, MediaType.anime, '2026-W46');
      prisma.user.findUnique.mockResolvedValue({ showNsfw: true });
      respond(200, thisWeek);
      await library.chart(5, MediaType.anime);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('keeps showing the last copy while the library is down', async () => {
      respond(200, thisWeek);
      await library.chart(5, MediaType.anime);
      now += 2 * HOUR;
      respond(502);

      const result = await library.chart(5, MediaType.anime);
      expect(result.week).toBe('2026-W46');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      respond(502);
      await expect(library.chart(5, MediaType.manga)).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });
  });

  describe('discussion', () => {
    beforeEach(() => {
      prisma.chartDiscussion.upsert.mockResolvedValue({
        id: 4,
        commentCount: 2,
      });
    });

    it('opens one thread per media type and week, returning its id and comment count', async () => {
      respond(200, chart);

      const first = await library.chartDiscussion(
        0,
        MediaType.anime,
        '2026-W45',
      );
      const second = await library.chartDiscussion(
        5,
        MediaType.anime,
        '2026-W45',
      );

      expect(first).toEqual({ id: 4, commentCount: 2 });
      expect(second).toEqual(first);
      const key = { mediaType: 'anime', week: '2026-W45' };
      expect(prisma.chartDiscussion.upsert).toHaveBeenNthCalledWith(1, {
        where: { mediaType_week: key },
        create: key,
        update: {},
        select: { id: true, commentCount: true },
      });
      expect(prisma.chartDiscussion.upsert.mock.calls[1]).toEqual(
        prisma.chartDiscussion.upsert.mock.calls[0],
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(prisma.libraryEntry.findMany).not.toHaveBeenCalled();
    });

    it('lets guests open it', () => {
      expect(
        Reflect.getMetadata(
          ALLOW_GUEST,
          LibraryController.prototype.chartDiscussion,
        ),
      ).toBe(true);
    });

    it('won’t open a thread for a week the library doesn’t have', async () => {
      respond(404, { error: 'Not found' });

      await expect(
        library.chartDiscussion(5, MediaType.manga, '2020-W01'),
      ).rejects.toThrow(new NotFoundException('Chart not found'));
      expect(prisma.chartDiscussion.upsert).not.toHaveBeenCalled();
    });

    it('needs a well-formed week and doesn’t ask the library otherwise', async () => {
      for (const week of [undefined, '', '2026-45', '2026-W45&adult=true']) {
        await expect(
          library.chartDiscussion(5, MediaType.anime, week),
        ).rejects.toThrow(new NotFoundException('Chart not found'));
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(prisma.chartDiscussion.upsert).not.toHaveBeenCalled();
    });
  });
});
