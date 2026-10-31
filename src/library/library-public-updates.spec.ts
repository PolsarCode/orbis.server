import { LibraryService } from './library.service';
import { PrismaService } from '../prisma.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';

describe('Public library updates', () => {
  const prisma = { libraryActivity: { findMany: jest.fn() } };
  const library = new LibraryService(
    prisma as unknown as PrismaService,
    {} as DiscordChannelService,
  );
  const createdAt = new Date('2026-11-01T08:00:00Z');
  const user = { id: 3, username: 'nami', name: 'Nami', avatarUrl: null };
  const entry = {
    mediaType: 'anime',
    sourceId: '21',
    title: 'ONE PIECE',
    coverImage: 'one-piece.webp',
    year: 1999,
    user,
  };

  beforeEach(() => jest.clearAllMocks());

  it('only shows public, non-18+ entries from public profiles that aren’t suspended', async () => {
    prisma.libraryActivity.findMany.mockResolvedValue([]);

    await library.publicUpdates();

    const [{ where, take }] = prisma.libraryActivity.findMany.mock.calls[0] as [
      { where: { entry: Record<string, unknown> }; take: number },
    ];
    expect(take).toBe(6);
    expect(where.entry).toMatchObject({
      isPublic: true,
      isAdult: false,
      user: { isPublic: true },
    });
    expect(where.entry.user).toHaveProperty('OR');
  });

  it('returns who did what, with progress when episodes or chapters changed', async () => {
    prisma.libraryActivity.findMany.mockResolvedValue([
      {
        id: 7,
        createdAt,
        status: 'current',
        progressFrom: 3,
        progressTo: 5,
        entry,
      },
      {
        id: 6,
        createdAt,
        status: 'completed',
        progressFrom: null,
        progressTo: null,
        entry,
      },
    ]);

    const updates = await library.publicUpdates();

    expect(updates[0]).toEqual({
      id: 7,
      createdAt,
      status: 'current',
      progress: { from: 3, to: 5 },
      author: user,
      media: {
        type: 'anime',
        sourceId: '21',
        title: 'ONE PIECE',
        coverImage: 'one-piece.webp',
        year: 1999,
      },
    });
    expect(updates[1].progress).toBeNull();
  });
});
