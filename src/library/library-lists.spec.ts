import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { LibraryService } from './library.service';
import { getMediaList } from './library-api';
import { PrismaService } from '../prisma.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';
import { MediaType } from '../../prisma/generated/client';

jest.mock('./library-api', () => ({
  ...jest.requireActual('./library-api'),
  getMediaList: jest.fn(),
}));

const fetchList = getMediaList as jest.Mock;
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 31, 12);

function media(sourceId: string) {
  return {
    id: `ANIME_${sourceId}`,
    type: 'ANIME',
    sourceId,
    title: `Title ${sourceId}`,
    coverImage: `${sourceId}.webp`,
    bannerImage: null,
    year: 2026,
    score: 8.5,
    status: 'RELEASING',
    genres: ['Action'],
    details: { episodes: 12 },
  };
}

describe('Media lists', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    libraryEntry: { findMany: jest.fn() },
  };
  let library: LibraryService;
  let now = NOW;

  beforeEach(() => {
    jest.clearAllMocks();
    now = NOW;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    library = new LibraryService(
      prisma as unknown as PrismaService,
      {} as DiscordChannelService,
    );
    prisma.user.findUnique.mockResolvedValue({ showNsfw: false });
    prisma.libraryEntry.findMany.mockResolvedValue([]);
    fetchList.mockResolvedValue([media('1'), media('2')]);
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps each list for an hour before asking the library again', async () => {
    await library.mediaList(5, MediaType.anime, 'trending');
    now += HOUR / 2;
    await library.mediaList(5, MediaType.anime, 'trending');
    expect(fetchList).toHaveBeenCalledTimes(1);

    await library.mediaList(5, MediaType.game, 'trending');
    expect(fetchList).toHaveBeenCalledTimes(2);

    now += HOUR;
    await library.mediaList(5, MediaType.anime, 'trending');
    expect(fetchList).toHaveBeenCalledTimes(3);
  });

  it('asks for 18+ titles only for people who show NSFW', async () => {
    await library.mediaList(5, MediaType.anime, 'top');
    expect(fetchList).toHaveBeenLastCalledWith(MediaType.anime, 'top', false);

    prisma.user.findUnique.mockResolvedValue({ showNsfw: true });
    await library.mediaList(6, MediaType.anime, 'top');
    expect(fetchList).toHaveBeenLastCalledWith(MediaType.anime, 'top', true);
    expect(fetchList).toHaveBeenCalledTimes(2);
  });

  it('marks titles already in the viewer’s library, and skips the lookup for guests', async () => {
    prisma.libraryEntry.findMany.mockResolvedValue([
      { id: 9, mediaId: 'ANIME_2', status: 'current', isPublic: false },
    ]);

    const items = await library.mediaList(5, MediaType.anime, 'season');

    expect(
      items.map(({ sourceId, inLibrary }) => [sourceId, inLibrary]),
    ).toEqual([
      ['1', false],
      ['2', true],
    ]);
    expect(items[0].entry).toBeNull();
    expect(items[1].entry).toEqual({
      id: 9,
      status: 'current',
      isPublic: false,
    });
    expect(items[0]).toMatchObject({
      type: 'anime',
      genres: ['Action'],
      releaseStatus: 'RELEASING',
      details: { episodes: 12 },
    });

    prisma.libraryEntry.findMany.mockClear();
    await library.mediaList(0, MediaType.anime, 'season');
    expect(prisma.libraryEntry.findMany).not.toHaveBeenCalled();
  });

  it('keeps showing the last copy while the library service is down', async () => {
    await library.mediaList(5, MediaType.anime, 'upcoming');
    now += 2 * HOUR;
    fetchList.mockRejectedValue(new BadGatewayException());

    const items = await library.mediaList(5, MediaType.anime, 'upcoming');
    expect(items).toHaveLength(2);

    await library.mediaList(5, MediaType.manga, 'upcoming').catch(() => null);
    await expect(
      library.mediaList(5, MediaType.manga, 'upcoming'),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('refuses unknown lists', async () => {
    await expect(
      library.mediaList(5, MediaType.anime, 'popular'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(fetchList).not.toHaveBeenCalled();
  });
});
