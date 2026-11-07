import { Subject } from 'rxjs';
import { PrismaService } from '../prisma.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { SteamSyncService } from '../library/steam-sync.service';
import { getPlayingGames } from './steam-api';
import { SteamPlayingService } from './steam-playing.service';

jest.mock('./steam-api', () => ({
  steamApiKey: () => 'key',
  getPlayingGames: jest.fn(),
}));

describe('Steam games being played', () => {
  const prisma = { steamAccount: { findMany: jest.fn() } };
  const presence = {
    updatePlaying: jest.fn(),
    cameOnline: new Subject<number>(),
  };
  const steamSync = { refresh: jest.fn() };
  let service: SteamPlayingService;

  function playing(games: Record<string, string>) {
    jest
      .mocked(getPlayingGames)
      .mockResolvedValueOnce(new Map(Object.entries(games)));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    prisma.steamAccount.findMany.mockResolvedValue([
      { userId: 1, steamId: 'a' },
      { userId: 2, steamId: 'b' },
    ]);
    service = new SteamPlayingService(
      prisma as unknown as PrismaService,
      presence as unknown as PresenceGateway,
      steamSync as unknown as SteamSyncService,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('shares what people who allow it are playing', async () => {
    playing({ b: 'NBA 2K26' });

    await service.poll();

    expect(prisma.steamAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { showPlaying: true } }),
    );
    expect(getPlayingGames).toHaveBeenCalledWith(['a', 'b']);
    expect(presence.updatePlaying).toHaveBeenCalledWith(
      new Map([[2, 'NBA 2K26']]),
    );
  });

  it('keeps the current games when Steam can’t be reached', async () => {
    jest.mocked(getPlayingGames).mockRejectedValue(new Error('down'));

    await service.poll();

    expect(presence.updatePlaying).not.toHaveBeenCalled();
  });

  it('checks the library a few minutes after a game session ends', async () => {
    playing({ a: 'Hades' });
    await service.poll();
    playing({});
    await service.poll();

    jest.advanceTimersByTime(5 * 60_000 - 1);
    expect(steamSync.refresh).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(steamSync.refresh).toHaveBeenCalledTimes(1);
    expect(steamSync.refresh).toHaveBeenCalledWith(1, { force: true });
  });

  it('treats switching games as the end of a session', async () => {
    playing({ a: 'Hades' });
    await service.poll();
    playing({ a: 'Celeste' });
    await service.poll();

    jest.advanceTimersByTime(5 * 60_000);
    expect(steamSync.refresh).toHaveBeenCalledWith(1, { force: true });
  });

  it('waits for games found on the first check instead of syncing right away', async () => {
    playing({ a: 'Hades' });
    await service.poll();
    playing({ a: 'Hades' });
    await service.poll();

    jest.advanceTimersByTime(10 * 60_000);
    expect(steamSync.refresh).not.toHaveBeenCalled();
  });

  it('checks once for several sessions that end close together', async () => {
    playing({ a: 'Hades' });
    await service.poll();
    playing({ a: 'Celeste' });
    await service.poll();
    playing({});
    await service.poll();

    jest.advanceTimersByTime(5 * 60_000);
    expect(steamSync.refresh).toHaveBeenCalledTimes(1);
  });

  it('doesn’t count a failed check as the end of a session', async () => {
    playing({ a: 'Hades' });
    await service.poll();
    jest.mocked(getPlayingGames).mockRejectedValueOnce(new Error('down'));
    await service.poll();

    jest.advanceTimersByTime(10 * 60_000);
    expect(steamSync.refresh).not.toHaveBeenCalled();
  });

  it('checks the library when someone comes online', () => {
    jest.mocked(getPlayingGames).mockResolvedValue(new Map());
    service.onModuleInit();

    presence.cameOnline.next(7);

    expect(steamSync.refresh).toHaveBeenCalledWith(7);
  });

  it('stops listening when the module shuts down', () => {
    jest.mocked(getPlayingGames).mockResolvedValue(new Map());
    service.onModuleInit();
    service.onModuleDestroy();

    presence.cameOnline.next(7);

    expect(steamSync.refresh).not.toHaveBeenCalled();
  });
});
