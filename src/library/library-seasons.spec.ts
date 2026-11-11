import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { LibraryService } from './library.service';
import { LibraryController } from './library.controller';
import { ALLOW_GUEST } from '../auth/allow-guest';
import { PrismaService } from '../prisma.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';
import { MediaType } from '../../prisma/generated/client';

const HOUR = 60 * 60 * 1000;

function media(sourceId: string) {
  return {
    id: `ANIME_${sourceId}`,
    type: 'ANIME',
    sourceId,
    title: `Title ${sourceId}`,
    coverImage: `${sourceId}.webp`,
    year: 2027,
    score: 8.1,
    status: 'NOT_YET_RELEASED',
    genres: ['Fantasy'],
    details: { episodes: 12 },
  };
}

const winter = {
  type: 'ANIME',
  season: 'winter',
  year: 2027,
  startsAt: '2027-01-01T00:00:00.000Z',
  endsAt: '2027-04-01T00:00:00.000Z',
  items: [media('1'), media('2')],
  updatedAt: '2026-11-10T08:00:00.000Z',
};

describe('Seasonal lists', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    libraryEntry: { findMany: jest.fn() },
  };
  let fetchMock: jest.SpyInstance;
  let library: LibraryService;
  let now: number;

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
    now = Date.parse('2026-11-11T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
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

  it('asks the library for the season, with 18+ titles only for people who show NSFW', async () => {
    respond(200, winter);
    await library.season(0, MediaType.anime, '2027-winter');
    expect(requested()).toMatch(/\/api\/seasons\/anime\/2027-winter$/);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();

    prisma.user.findUnique.mockResolvedValue({ showNsfw: true });
    respond(200, winter);
    await library.season(6, MediaType.manga, '2026-fall');
    expect(requested()).toMatch(
      /\/api\/seasons\/manga\/2026-fall\?adult=true$/,
    );
  });

  it('returns the season with each title shaped like a list item', async () => {
    respond(200, winter);
    prisma.libraryEntry.findMany.mockResolvedValue([
      { id: 9, mediaId: 'ANIME_2', status: 'planned', isPublic: true },
    ]);

    const result = await library.season(5, MediaType.anime, '2027-winter');

    expect(result).toMatchObject({
      type: 'anime',
      season: 'winter',
      year: 2027,
      startsAt: winter.startsAt,
      endsAt: winter.endsAt,
    });
    expect(result).not.toHaveProperty('updatedAt');
    expect(result.items[0]).toMatchObject({
      type: 'anime',
      sourceId: '1',
      genres: ['Fantasy'],
      releaseStatus: 'NOT_YET_RELEASED',
      inLibrary: false,
      entry: null,
    });
    expect(result.items[1]).toMatchObject({
      inLibrary: true,
      entry: { id: 9, status: 'planned', isPublic: true },
    });
  });

  it('refuses a malformed season without asking the library', async () => {
    for (const season of [
      'winter',
      '2027-autumn',
      '27-winter',
      '2027-Winter',
      '2027-winter?adult=true',
    ]) {
      await expect(library.season(5, MediaType.anime, season)).rejects.toThrow(
        new NotFoundException('Season not found'),
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a season the library doesn’t serve as not found', async () => {
    respond(404, { error: 'Not found' });

    await expect(
      library.season(5, MediaType.anime, '2020-winter'),
    ).rejects.toThrow(new NotFoundException('Season not found'));
  });

  it('keeps each season for an hour, apart per type and 18+ setting', async () => {
    respond(200, winter);
    await library.season(5, MediaType.anime, '2027-winter');
    now += HOUR / 2;
    await library.season(5, MediaType.anime, '2027-winter');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    respond(200, winter);
    await library.season(5, MediaType.manga, '2027-winter');
    prisma.user.findUnique.mockResolvedValue({ showNsfw: true });
    respond(200, winter);
    await library.season(5, MediaType.anime, '2027-winter');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    prisma.user.findUnique.mockResolvedValue({ showNsfw: false });
    now += HOUR;
    respond(200, winter);
    await library.season(5, MediaType.anime, '2027-winter');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('keeps showing the last copy while the library is down', async () => {
    respond(200, winter);
    await library.season(5, MediaType.anime, '2027-winter');
    now += 2 * HOUR;
    respond(502);

    const result = await library.season(5, MediaType.anime, '2027-winter');
    expect(result.items).toHaveLength(2);

    respond(502);
    await expect(
      library.season(5, MediaType.game, '2027-winter'),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('lets guests open it', () => {
    expect(
      Reflect.getMetadata(ALLOW_GUEST, LibraryController.prototype.season),
    ).toBe(true);
  });
});
