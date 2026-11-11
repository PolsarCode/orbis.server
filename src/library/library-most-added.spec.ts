import { BadRequestException } from '@nestjs/common';
import { LibraryService } from './library.service';
import { LibraryController } from './library.controller';
import { SteamSyncService } from './steam-sync.service';
import { ALLOW_GUEST } from '../auth/allow-guest';
import { PrismaService } from '../prisma.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';
import { MediaType } from '../../prisma/generated/client';

const now = new Date('2026-11-11T15:30:00.000Z');
const until = new Date('2026-11-11T00:00:00.000Z');
const weekAgo = new Date('2026-11-04T00:00:00.000Z');

beforeEach(() => jest.useFakeTimers({ now }));
afterEach(() => jest.useRealTimers());

function setup() {
  const prisma = {
    libraryEntry: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const library = new LibraryService(
    prisma as unknown as PrismaService,
    {} as DiscordChannelService,
  );
  return { prisma, library };
}

const counted = (sourceId: string, adds: number) => ({
  sourceId,
  _count: { sourceId: adds },
});

const entry = (sourceId: string, coverImage: string | null = 'cover.webp') => ({
  mediaType: 'anime',
  sourceId,
  title: `Title ${sourceId}`,
  coverImage,
  isAdult: false,
});

describe('Most added titles', () => {
  it('only counts public, non-18+ adds of the type from public profiles that aren’t suspended, in the week', async () => {
    const { prisma, library } = setup();

    await library.mostAdded(MediaType.manga, until);

    const [{ where }] = prisma.libraryEntry.groupBy.mock.calls[0] as [
      { where: Record<string, unknown> & { user: Record<string, unknown> } },
    ];
    expect(where).toMatchObject({
      mediaType: 'manga',
      isPublic: true,
      isAdult: false,
      createdAt: { gte: weekAgo, lt: until },
      user: {
        isPublic: true,
        deleteAt: null,
        OR: [
          { suspendedAt: null },
          { suspendedUntil: { lte: expect.any(Date) } },
        ],
      },
    });
  });

  it('ranks titles by adds, then the latest add, then source id, keeping five', async () => {
    const { prisma, library } = setup();

    await library.mostAdded(MediaType.anime, until);

    expect(prisma.libraryEntry.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['sourceId'],
        _count: { sourceId: true },
        orderBy: [
          { _count: { sourceId: 'desc' } },
          { _max: { createdAt: 'desc' } },
          { sourceId: 'asc' },
        ],
        take: 5,
      }),
    );
  });

  it('names each title and its cover after its latest add, in ranked order', async () => {
    const { prisma, library } = setup();
    prisma.libraryEntry.groupBy.mockResolvedValue([
      counted('21', 4),
      counted('5114', 2),
      counted('9253', 2),
    ]);
    prisma.libraryEntry.findMany.mockResolvedValue([
      entry('9253', null),
      entry('21'),
      entry('5114'),
    ]);

    const result = await library.mostAdded(MediaType.anime, until);

    expect(result).toEqual({
      startsAt: '2026-11-04T00:00:00.000Z',
      endsAt: '2026-11-11T00:00:00.000Z',
      items: [
        {
          media: {
            type: 'anime',
            sourceId: '21',
            title: 'Title 21',
            coverImage: 'https://library.boseriko.com/api/anime/21/cover',
          },
          adds: 4,
        },
        {
          media: {
            type: 'anime',
            sourceId: '5114',
            title: 'Title 5114',
            coverImage: 'https://library.boseriko.com/api/anime/5114/cover',
          },
          adds: 2,
        },
        {
          media: {
            type: 'anime',
            sourceId: '9253',
            title: 'Title 9253',
            coverImage: null,
          },
          adds: 2,
        },
      ],
    });
    const [{ where: groupWhere }] = prisma.libraryEntry.groupBy.mock
      .calls[0] as [{ where: object }];
    expect(prisma.libraryEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ...groupWhere, sourceId: { in: ['21', '5114', '9253'] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        distinct: ['sourceId'],
      }),
    );
  });

  it('returns an empty week without looking up titles', async () => {
    const { prisma, library } = setup();

    await expect(library.mostAdded(MediaType.game, until)).resolves.toEqual({
      startsAt: '2026-11-04T00:00:00.000Z',
      endsAt: '2026-11-11T00:00:00.000Z',
      items: [],
    });
    expect(prisma.libraryEntry.findMany).not.toHaveBeenCalled();
  });

  describe('route', () => {
    const service = { mostAdded: jest.fn() };
    const controller = new LibraryController(
      service as unknown as LibraryService,
      {} as SteamSyncService,
    );

    beforeEach(() => service.mostAdded.mockClear());

    it('lets guests open it', () => {
      expect(
        Reflect.getMetadata(ALLOW_GUEST, LibraryController.prototype.mostAdded),
      ).toBe(true);
    });

    it('ends the week at the start of today unless a date is given', () => {
      controller.mostAdded(MediaType.anime);
      expect(service.mostAdded).toHaveBeenLastCalledWith(
        MediaType.anime,
        until,
      );

      controller.mostAdded(MediaType.anime, '2026-11-01');
      expect(service.mostAdded).toHaveBeenLastCalledWith(
        MediaType.anime,
        new Date('2026-11-01T00:00:00.000Z'),
      );
    });

    it('refuses dates that aren’t available', () => {
      expect(() => controller.mostAdded(MediaType.anime, '2026-11-20')).toThrow(
        BadRequestException,
      );
      expect(service.mostAdded).not.toHaveBeenCalled();
    });
  });
});
