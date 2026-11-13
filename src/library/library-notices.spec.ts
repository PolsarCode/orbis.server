import { LibraryNoticesService } from './library-notices.service';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');

function entry(
  id: number,
  mediaType: 'anime' | 'game',
  sourceId: string,
  extra: Partial<{ progress: number; createdAt: Date; userId: number }> = {},
) {
  return {
    id,
    userId: 4,
    mediaType,
    sourceId,
    title: `Title ${sourceId}`,
    coverImage: `${sourceId}.webp`,
    isAdult: false,
    progress: 0,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...extra,
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

describe('Catalog release notifications', () => {
  let anime: ReturnType<typeof entry>[];
  let games: ReturnType<typeof entry>[];
  let notices: { entryId: number; kind: string; key: string }[];
  let lastSeen: { entryId: number; key: string }[];
  let responses: Map<string, unknown>;
  const notify = jest.fn();
  const prisma = {
    libraryEntry: {
      findMany: jest.fn(({ where }) =>
        Promise.resolve(where.mediaType === 'anime' ? anime : games),
      ),
    },
    libraryNotice: {
      findMany: jest.fn(() => Promise.resolve(lastSeen)),
      upsert: jest.fn(),
      createManyAndReturn: jest.fn(({ data }) => {
        const fresh = data.filter(
          (row: { entryId: number; kind: string; key: string }) =>
            !notices.some(
              (notice) =>
                notice.entryId === row.entryId &&
                notice.kind === row.kind &&
                notice.key === row.key,
            ),
        );
        notices.push(...fresh);
        return Promise.resolve(fresh);
      }),
    },
  };
  let service: LibraryNoticesService;

  const sent = () =>
    notify.mock.calls.flatMap(([items]) =>
      items.map(({ type, message }: { type: string; message: string }) => [
        type,
        message,
      ]),
    );

  beforeEach(() => {
    jest.clearAllMocks();
    anime = [];
    games = [];
    notices = [];
    lastSeen = [];
    responses = new Map();
    jest.spyOn(Date, 'now').mockImplementation(() => NOW);
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      const body = responses.get(path);
      return {
        status: body === undefined ? 404 : 200,
        ok: body !== undefined,
        json: async () => body,
      } as Response;
    });
    service = new LibraryNoticesService(
      prisma as unknown as PrismaService,
      { notify } as unknown as NotificationsService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('tells watchers about a new episode once, with the cover and title link', async () => {
    anime = [entry(1, 'anime', '21', { progress: 5 })];
    responses.set('/api/schedule', {
      episodes: [
        { id: '21', episode: 5, airsAt: '2026-11-13T00:00:00.000Z' },
        { id: '21', episode: 6, airsAt: '2026-11-14T10:00:00.000Z' },
        { id: '21', episode: 7, airsAt: '2026-11-21T10:00:00.000Z' },
      ],
    });

    await service.check();
    await service.check();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toEqual([
      {
        userId: 4,
        actorId: null,
        type: 'episode_aired',
        message: 'Episode 6 of Title 21 is out',
        link: '/library/anime/21',
        imageUrl: expect.stringMatching(/\/api\/anime\/21\/cover$/),
      },
    ]);
  });

  it('skips episodes older than two days or from before the title was added', async () => {
    anime = [
      entry(1, 'anime', '21'),
      entry(2, 'anime', '22', {
        createdAt: new Date('2026-11-14T11:00:00.000Z'),
      }),
    ];
    responses.set('/api/schedule', {
      episodes: [
        { id: '21', episode: 1, airsAt: '2026-11-11T00:00:00.000Z' },
        { id: '22', episode: 1, airsAt: '2026-11-14T10:00:00.000Z' },
      ],
    });

    await service.check();

    expect(sent()).toEqual([]);
  });

  it('remembers a game’s first known date without telling anyone', async () => {
    games = [entry(1, 'game', '10')];
    responses.set(
      '/api/game/10',
      game('10', '2027-03-04T00:00:00.000Z', 'day'),
    );

    await service.check();

    expect(prisma.libraryNotice.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          entryId: 1,
          kind: 'game_date',
          key: 'day:2027-03-04T00:00:00.000Z',
        },
      }),
    );
    expect(sent()).toEqual([]);
  });

  it('announces when a planned game gets an exact date', async () => {
    games = [entry(1, 'game', '10')];
    lastSeen = [{ entryId: 1, key: 'quarter:2027-01-01T00:00:00.000Z' }];
    responses.set(
      '/api/game/10',
      game('10', '2027-03-04T00:00:00.000Z', 'day'),
    );

    await service.check();

    expect(sent()).toEqual([
      ['game_date', 'Title 10 comes out on Mar 4, 2027'],
    ]);
  });

  it('tells planners when a game comes out', async () => {
    games = [
      entry(1, 'game', '10'),
      entry(2, 'game', '11', {
        createdAt: new Date('2026-11-14T08:00:00.000Z'),
      }),
    ];
    lastSeen = [
      { entryId: 1, key: 'day:2026-11-14T00:00:00.000Z' },
      { entryId: 2, key: 'day:2026-11-14T00:00:00.000Z' },
    ];
    responses.set(
      '/api/game/10',
      game('10', '2026-11-14T00:00:00.000Z', 'day'),
    );
    responses.set(
      '/api/game/11',
      game('11', '2026-11-14T00:00:00.000Z', 'day'),
    );

    await service.check();

    expect(sent()).toEqual([['game_released', 'Title 10 is out now']]);
  });

  it('skips games the library can’t load', async () => {
    games = [entry(1, 'game', '404')];

    await service.check();

    expect(prisma.libraryNotice.upsert).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
