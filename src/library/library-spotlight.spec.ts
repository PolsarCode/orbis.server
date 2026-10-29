import { LibraryService } from './library.service';
import { getMedia } from './library-api';
import { PrismaService } from '../prisma.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';

jest.mock('./library-api', () => ({
  ...jest.requireActual('./library-api'),
  getMedia: jest.fn(),
}));

const media = getMedia as jest.Mock;

describe('Anime spotlight', () => {
  const prisma = { libraryEntry: { findMany: jest.fn() } };

  function service() {
    return new LibraryService(
      prisma as unknown as PrismaService,
      {} as DiscordChannelService,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    prisma.libraryEntry.findMany.mockResolvedValue([
      { sourceId: '154587', title: 'Frieren', coverImage: 'small.jpg' },
      { sourceId: '999', title: 'Adult title', coverImage: 'adult.jpg' },
      { sourceId: '404', title: 'Gone', coverImage: 'gone.jpg' },
    ]);
    media.mockImplementation((_type: string, sourceId: string) => {
      if (sourceId === '404') return Promise.reject(new Error('missing'));
      return Promise.resolve({
        title: sourceId === '999' ? 'Adult title' : 'Sousou no Frieren',
        isAdult: sourceId === '999',
        coverImage: 'cover.webp',
        bannerImage: 'banner.webp',
      });
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('picks a recently updated public anime that is not 18+', async () => {
    const spotlight = await service().spotlight();

    expect(prisma.libraryEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          mediaType: 'anime',
          isPublic: true,
          isAdult: false,
          user: { isPublic: true },
        },
        orderBy: { updatedAt: 'desc' },
        distinct: ['sourceId'],
      }),
    );
    expect(media).toHaveBeenCalledWith('anime', '154587', false);
    expect(spotlight).toEqual({
      type: 'anime',
      sourceId: '154587',
      title: 'Sousou no Frieren',
      coverImage: 'cover.webp',
      bannerImage: 'banner.webp',
    });
  });

  it('never returns a title the library marks as 18+ or that fails to load', async () => {
    const library = service();

    for (const pick of [0, 0.5, 0.99]) {
      jest.spyOn(Math, 'random').mockReturnValue(pick);
      expect((await library.spotlight())?.sourceId).toBe('154587');
    }
  });

  it('reuses the shortlist instead of asking again on every visit', async () => {
    const library = service();

    await library.spotlight();
    await library.spotlight();

    expect(prisma.libraryEntry.findMany).toHaveBeenCalledTimes(1);
  });

  it('returns nothing when there is no anime to show', async () => {
    prisma.libraryEntry.findMany.mockResolvedValue([]);

    await expect(service().spotlight()).resolves.toBeNull();
  });
});
