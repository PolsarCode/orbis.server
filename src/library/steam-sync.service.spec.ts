import { PrismaService } from '../prisma.service';
import { getAchievements, getOwnedGames } from '../steam/steam-api';
import { matchSteamGames } from './library-api';
import { LibraryService } from './library.service';
import { SteamSyncService } from './steam-sync.service';

jest.mock('../steam/steam-api', () => ({
  steamApiKey: () => 'key',
  getOwnedGames: jest.fn(),
  getAchievements: jest.fn(),
}));
jest.mock('./library-api', () => ({ matchSteamGames: jest.fn() }));

const hollowKnight = {
  id: 'GAME_14593',
  sourceId: '14593',
  title: 'Hollow Knight',
  coverImage: 'https://images.igdb.com/cover.jpg',
  year: 2017,
  isAdult: false,
};

describe('Checking Steam games', () => {
  const prisma = {
    steamAccount: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    steamGame: {
      findMany: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
    },
    libraryEntry: { findMany: jest.fn(), createMany: jest.fn() },
    user: { findUnique: jest.fn() },
    $transaction: jest.fn(async (operations: unknown[]) => operations),
    $executeRaw: jest.fn(),
  };
  const library = { add: jest.fn() };
  const service = new SteamSyncService(
    prisma as unknown as PrismaService,
    library as unknown as LibraryService,
  );
  const checkedBefore = new Date('2026-10-01T00:00:00Z');
  const anHourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

  function account(overrides: Record<string, unknown> = {}) {
    prisma.steamAccount.findUnique.mockResolvedValue({
      steamId: '76561198000000001',
      trackGames: true,
      baselineAt: checkedBefore,
      ...overrides,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.steamAccount.updateMany.mockResolvedValue({ count: 1 });
    prisma.steamGame.findMany.mockResolvedValue([]);
    prisma.libraryEntry.findMany.mockResolvedValue([]);
    jest.mocked(matchSteamGames).mockResolvedValue({});
  });

  it('checks at most once every 15 minutes', async () => {
    prisma.steamAccount.updateMany.mockResolvedValue({ count: 0 });

    await service.sync(1);

    expect(getOwnedGames).not.toHaveBeenCalled();
  });

  it('treats the first check as the baseline', async () => {
    account({ baselineAt: null });
    jest.mocked(getOwnedGames).mockResolvedValue([
      {
        appId: '367520',
        minutes: 754,
        lastPlayedAt: null,
      },
    ]);
    jest.mocked(matchSteamGames).mockResolvedValue({ '367520': hollowKnight });

    await service.sync(1);

    expect(library.add).not.toHaveBeenCalled();
    expect(prisma.steamGame.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          appId: '367520',
          minutes: 754,
          igdbId: '14593',
        }),
      ],
      skipDuplicates: true,
    });
    expect(prisma.steamAccount.update).toHaveBeenCalledWith({
      where: { userId: 1 },
      data: expect.objectContaining({ baselineAt: expect.any(Date) }),
    });
  });

  it('adds a game as Playing the first time it is played', async () => {
    account();
    prisma.steamGame.findMany
      .mockResolvedValueOnce([
        { appId: '367520', minutes: 0, matchedAt: checkedBefore },
      ])
      .mockResolvedValueOnce([{ igdbId: '14593' }]);
    jest.mocked(getOwnedGames).mockResolvedValue([
      {
        appId: '367520',
        minutes: 30,
        lastPlayedAt: anHourAgo(),
      },
    ]);

    await service.sync(1);

    expect(library.add).toHaveBeenCalledWith(1, {
      type: 'game',
      sourceId: '14593',
      status: 'current',
    });
  });

  it('doesn’t count an old game showing up with playtime as just started', async () => {
    account();
    prisma.steamGame.findMany
      .mockResolvedValueOnce([
        { appId: '19680', minutes: 0, matchedAt: checkedBefore },
      ])
      .mockResolvedValueOnce([{ igdbId: '1063' }]);
    jest.mocked(getOwnedGames).mockResolvedValue([
      {
        appId: '19680',
        minutes: 640,
        lastPlayedAt: new Date('2019-03-02T00:00:00Z'),
      },
    ]);

    await service.sync(1);

    expect(library.add).not.toHaveBeenCalled();
  });

  it('doesn’t count a game without a last-played date as just started', async () => {
    account();
    prisma.steamGame.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ igdbId: '1063' }]);
    jest
      .mocked(getOwnedGames)
      .mockResolvedValue([
        { appId: '19680', minutes: 640, lastPlayedAt: null },
      ]);

    await service.sync(1);

    expect(library.add).not.toHaveBeenCalled();
  });

  it('leaves the library alone when adding is turned off', async () => {
    account({ trackGames: false });
    prisma.steamGame.findMany.mockResolvedValueOnce([
      { appId: '367520', minutes: 0, matchedAt: checkedBefore },
    ]);
    jest.mocked(getOwnedGames).mockResolvedValue([
      {
        appId: '367520',
        minutes: 30,
        lastPlayedAt: anHourAgo(),
      },
    ]);

    await service.sync(1);

    expect(library.add).not.toHaveBeenCalled();
  });

  it('skips games that are already in the library', async () => {
    account();
    prisma.steamGame.findMany
      .mockResolvedValueOnce([
        { appId: '367520', minutes: 0, matchedAt: checkedBefore },
      ])
      .mockResolvedValueOnce([{ igdbId: '14593' }]);
    prisma.libraryEntry.findMany.mockResolvedValue([{ sourceId: '14593' }]);
    jest.mocked(getOwnedGames).mockResolvedValue([
      {
        appId: '367520',
        minutes: 30,
        lastPlayedAt: anHourAgo(),
      },
    ]);

    await service.sync(1);

    expect(library.add).not.toHaveBeenCalled();
  });

  it('saves achievement progress again after the game is played', async () => {
    account({ trackGames: false });
    prisma.steamGame.findMany
      .mockResolvedValueOnce([
        {
          appId: '367520',
          minutes: 0,
          matchedAt: checkedBefore,
        },
      ])
      .mockResolvedValueOnce([{ appId: '367520' }]);
    jest.mocked(getOwnedGames).mockResolvedValue([
      {
        appId: '367520',
        minutes: 30,
        lastPlayedAt: anHourAgo(),
      },
    ]);
    jest.mocked(getAchievements).mockResolvedValue({ achieved: 12, total: 63 });

    await service.sync(1);

    const where = { userId_appId: { userId: 1, appId: '367520' } };
    expect(prisma.steamGame.update).toHaveBeenCalledWith({
      where,
      data: expect.objectContaining({ minutes: 30, achievementsAt: null }),
    });
    expect(getAchievements).toHaveBeenCalledWith('76561198000000001', '367520');
    expect(prisma.steamGame.update).toHaveBeenCalledWith({
      where,
      data: {
        achieved: 12,
        achievementTotal: 63,
        achievementsAt: expect.any(Date),
      },
    });
  });

  it('remembers when Steam game details are private', async () => {
    account();
    jest.mocked(getOwnedGames).mockResolvedValue(null);

    await service.sync(1);

    expect(prisma.steamAccount.update).toHaveBeenCalledWith({
      where: { userId: 1 },
      data: { gamesPrivate: true },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('saves nothing when matching fails, so the next check tries again', async () => {
    account();
    jest.mocked(getOwnedGames).mockResolvedValue([
      {
        appId: '367520',
        minutes: 30,
        lastPlayedAt: anHourAgo(),
      },
    ]);
    jest.mocked(matchSteamGames).mockRejectedValue(new Error('down'));

    await expect(service.sync(1)).rejects.toThrow('down');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  describe('importing played games', () => {
    const recently = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const longAgo = new Date('2024-01-01T00:00:00Z');

    beforeEach(() => {
      jest.spyOn(service, 'refresh').mockResolvedValue(undefined);
      prisma.user.findUnique.mockResolvedValue({ showNsfw: false });
      prisma.libraryEntry.createMany.mockImplementation(({ data }) =>
        Promise.resolve({ count: data.length }),
      );
    });

    it('adds played games without posting anything to feeds', async () => {
      prisma.steamGame.findMany.mockResolvedValue([
        { appId: '367520', igdbId: '14593', lastPlayedAt: recently },
        { appId: '413150', igdbId: '17000', lastPlayedAt: longAgo },
      ]);
      jest.mocked(matchSteamGames).mockResolvedValue({
        '367520': hollowKnight,
        '413150': {
          ...hollowKnight,
          id: 'GAME_17000',
          sourceId: '17000',
          title: 'Stardew Valley',
        },
      });

      await expect(service.importPlayed(1)).resolves.toBe(2);

      const { data } = prisma.libraryEntry.createMany.mock.calls[0][0];
      expect(data).toEqual([
        expect.objectContaining({
          sourceId: '14593',
          status: 'current',
          steamAppId: '367520',
          updatedAt: recently,
        }),
        expect.objectContaining({
          sourceId: '17000',
          status: 'on_hold',
          steamAppId: '413150',
          updatedAt: longAgo,
        }),
      ]);
      expect(data[0]).not.toHaveProperty('activities');
    });

    it('skips games already in the library and 18+ games when NSFW is off', async () => {
      prisma.steamGame.findMany.mockResolvedValue([
        { appId: '367520', igdbId: '14593', lastPlayedAt: recently },
        { appId: '339800', igdbId: '9999', lastPlayedAt: recently },
      ]);
      prisma.libraryEntry.findMany.mockResolvedValue([{ sourceId: '14593' }]);
      jest.mocked(matchSteamGames).mockResolvedValue({
        '339800': {
          ...hollowKnight,
          id: 'GAME_9999',
          sourceId: '9999',
          isAdult: true,
        },
      });

      await expect(service.importPlayed(1)).resolves.toBe(0);
      expect(matchSteamGames).toHaveBeenCalledWith(['339800']);
    });
  });
});
