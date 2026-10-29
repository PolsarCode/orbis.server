import { validate } from 'class-validator';
import { LibraryService } from './library.service';
import { getMedia, type Media } from './library-api';
import { AddLibraryEntryDto } from './dto/add-library-entry.dto';
import { PrismaService } from '../prisma.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';

jest.mock('./library-api', () => ({ getMedia: jest.fn() }));

const discordChannel = {
  entryChanged: jest.fn(),
  activitiesDeleted: jest.fn(),
} as unknown as DiscordChannelService;

const media: Media = {
  id: 'anime:1',
  type: 'ANIME',
  sourceId: '1',
  title: 'Cowboy Bebop',
  coverImage: null,
  year: 1998,
  score: null,
  details: { episodes: 26 },
};

describe('Adding library progress', () => {
  const create = jest.fn();
  const findUser = jest.fn();
  const findSteamGame = jest.fn().mockResolvedValue(null);
  const service = new LibraryService(
    {
      libraryEntry: { create },
      user: { findUnique: findUser },
      steamGame: { findFirst: findSteamGame },
    } as unknown as PrismaService,
    discordChannel,
  );
  beforeEach(() => {
    jest.clearAllMocks();
    findUser.mockResolvedValue({ showNsfw: false });
    jest.mocked(getMedia).mockResolvedValue(media);
    create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 7, ...data }),
    );
  });

  it('stores the initial episode count with the entry', async () => {
    const result = await service.add(1, {
      type: 'anime',
      sourceId: '1',
      status: 'current',
      progress: 5,
      isPublic: false,
    });
    expect(result).toMatchObject({
      progress: 5,
      total: 26,
      status: 'current',
      isPublic: false,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('stores chapter progress when the manga total is unknown', async () => {
    jest.mocked(getMedia).mockResolvedValue({
      ...media,
      type: 'MANGA',
      details: { chapters: null },
    });
    expect(
      await service.add(1, { type: 'manga', sourceId: '1', progress: 120 }),
    ).toMatchObject({ progress: 120, total: null });
  });

  it('keeps existing defaults for clients that omit progress', async () => {
    expect(
      await service.add(1, { type: 'anime', sourceId: '1' }),
    ).toMatchObject({ progress: 0, status: 'planned', isPublic: true });
  });

  it('caps progress at the known total', async () => {
    expect(
      await service.add(1, { type: 'anime', sourceId: '1', progress: 100 }),
    ).toMatchObject({ progress: 26 });
  });

  it('fills the known total for completed titles', async () => {
    expect(
      await service.add(1, {
        type: 'anime',
        sourceId: '1',
        status: 'completed',
        progress: 5,
      }),
    ).toMatchObject({ progress: 26 });
  });

  it('allows an entered count for completed titles without a known total', async () => {
    jest.mocked(getMedia).mockResolvedValue({ ...media, details: {} });
    expect(
      await service.add(1, {
        type: 'anime',
        sourceId: '1',
        status: 'completed',
        progress: 12,
      }),
    ).toMatchObject({ progress: 12, total: null });
  });

  it('keeps games at zero progress', async () => {
    jest
      .mocked(getMedia)
      .mockResolvedValue({ ...media, type: 'GAME', details: {} });
    expect(
      await service.add(1, { type: 'game', sourceId: '1', progress: 10 }),
    ).toMatchObject({ progress: 0, total: null });
  });

  it.each([-1, 1.5, 100001, '5'])(
    'rejects invalid progress %s',
    async (progress) => {
      const dto = Object.assign(new AddLibraryEntryDto(), {
        type: 'anime',
        sourceId: '1',
        progress,
      });
      expect(
        (await validate(dto)).some(({ property }) => property === 'progress'),
      ).toBe(true);
    },
  );

  it.each([0, 5, 100000, undefined])(
    'accepts valid progress %s',
    async (progress) => {
      const dto = Object.assign(new AddLibraryEntryDto(), {
        type: 'anime',
        sourceId: '1',
        progress,
      });
      expect(await validate(dto)).toHaveLength(0);
    },
  );
});

describe('Listing the library', () => {
  const findMany = jest.fn().mockResolvedValue([]);
  const findUser = jest.fn();
  const service = new LibraryService(
    {
      libraryEntry: { findMany },
      user: { findUnique: findUser },
    } as unknown as PrismaService,
    discordChannel,
  );

  beforeEach(() => jest.clearAllMocks());

  it('puts the most recently updated titles first', async () => {
    findUser.mockResolvedValue({ showNsfw: true });

    await service.list(1);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 1 },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('hides 18+ titles unless NSFW is turned on', async () => {
    findUser.mockResolvedValue({ showNsfw: false });

    await service.list(1);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 1, isAdult: false } }),
    );
  });
});

describe('Adding 18+ titles', () => {
  const create = jest.fn(({ data }) => Promise.resolve({ id: 7, ...data }));
  const findUser = jest.fn();
  const findSteamGame = jest.fn().mockResolvedValue(null);
  const steamGames = jest.fn().mockResolvedValue([]);
  const steamAccounts = jest.fn().mockResolvedValue([]);
  const service = new LibraryService(
    {
      libraryEntry: { create },
      user: { findUnique: findUser },
      steamGame: { findFirst: findSteamGame, findMany: steamGames },
      steamAccount: { findMany: steamAccounts },
    } as unknown as PrismaService,
    discordChannel,
  );

  beforeEach(() => jest.clearAllMocks());

  it('links a game you own on Steam and shows your playtime', async () => {
    findUser.mockResolvedValue({ showNsfw: false });
    jest.mocked(getMedia).mockResolvedValue({
      ...media,
      id: 'GAME_14593',
      type: 'GAME',
      sourceId: '14593',
    });
    findSteamGame.mockResolvedValueOnce({ appId: '367520' });
    steamGames.mockResolvedValueOnce([
      {
        userId: 1,
        appId: '367520',
        minutes: 754,
        achieved: 12,
        achievementTotal: 63,
      },
    ]);
    steamAccounts.mockResolvedValueOnce([
      { userId: 1, steamId: '76561197960287930' },
    ]);

    const entry = await service.add(1, { type: 'game', sourceId: '14593' });

    expect(findSteamGame).toHaveBeenCalledWith({
      where: { userId: 1, igdbId: '14593' },
      select: { appId: true },
    });
    expect(create.mock.calls[0][0].data.steamAppId).toBe('367520');
    expect(entry.steam).toEqual({
      appId: '367520',
      minutes: 754,
      steamId: '76561197960287930',
      achievements: { achieved: 12, total: 63 },
    });
  });

  it('asks for 18+ titles and remembers them when NSFW is on', async () => {
    findUser.mockResolvedValue({ showNsfw: true });
    jest.mocked(getMedia).mockResolvedValue({ ...media, isAdult: true });

    const entry = await service.add(1, { type: 'anime', sourceId: '1' });

    expect(getMedia).toHaveBeenCalledWith('anime', '1', true);
    expect(entry).toMatchObject({ isAdult: true });
  });

  it('keeps 18+ titles out when NSFW is off', async () => {
    findUser.mockResolvedValue({ showNsfw: false });
    jest.mocked(getMedia).mockResolvedValue(media);

    await service.add(1, { type: 'anime', sourceId: '1' });

    expect(getMedia).toHaveBeenCalledWith('anime', '1', false);
  });
});
