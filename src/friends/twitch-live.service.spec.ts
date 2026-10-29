import { PrismaService } from '../prisma.service';
import { PresenceGateway } from './presence.gateway';
import { TwitchLiveService } from './twitch-live.service';

describe('TwitchLiveService', () => {
  const prisma = {
    oAuthAccount: { findMany: jest.fn() },
    community: { findMany: jest.fn() },
  };
  const presence = { updateLive: jest.fn(), updateLiveCommunities: jest.fn() };
  const fetchMock = jest.fn();
  const service = new TwitchLiveService(
    prisma as unknown as PrismaService,
    presence as unknown as PresenceGateway,
  );

  beforeAll(() => {
    process.env.TWITCH_CLIENT_ID = 'client';
    process.env.TWITCH_CLIENT_SECRET = 'secret';
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.community.findMany.mockResolvedValue([]);
  });

  it('marks connected accounts that are live on Twitch', async () => {
    prisma.oAuthAccount.findMany.mockResolvedValue([
      { userId: 1, providerAccountId: 'a' },
      { userId: 2, providerAccountId: 'b' },
    ]);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'app-token', expires_in: 3600 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ user_id: 'b', type: 'live' }] }),
      });

    await service.poll();

    expect(prisma.oAuthAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider: 'twitch', showLive: true },
      }),
    );
    expect(fetchMock.mock.calls[1][0]).toContain('user_id=a&user_id=b');
    expect(presence.updateLive).toHaveBeenCalledWith(new Set([2]));
  });

  it('keeps the current live list when Twitch can’t be reached', async () => {
    prisma.oAuthAccount.findMany.mockResolvedValue([
      { userId: 1, providerAccountId: 'a' },
    ]);
    fetchMock.mockRejectedValue(new Error('offline'));

    await service.poll();

    expect(presence.updateLive).not.toHaveBeenCalled();
  });

  it('marks communities whose Twitch channel is live', async () => {
    prisma.oAuthAccount.findMany.mockResolvedValue([
      { userId: 1, providerAccountId: 'a' },
    ]);
    prisma.community.findMany.mockResolvedValue([
      { id: 12, twitchUserId: 'c' },
      { id: 13, twitchUserId: 'd' },
    ]);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ user_id: 'c', type: 'live' }] }),
    });

    await service.poll();

    expect(presence.updateLive).toHaveBeenCalledWith(new Set());
    expect(presence.updateLiveCommunities).toHaveBeenCalledWith(new Set([12]));
    expect(prisma.community.findMany).toHaveBeenCalledWith({
      where: { twitchUserId: { not: null }, showTwitchLive: true },
      select: { id: true, twitchUserId: true },
    });
  });
});

describe('Twitch stream schedule', () => {
  const fetchMock = jest.fn();
  const tokenResponse = {
    ok: true,
    json: async () => ({ access_token: 'app-token', expires_in: 3600 }),
  };
  let service: TwitchLiveService;

  beforeAll(() => {
    process.env.TWITCH_CLIENT_ID = 'client';
    process.env.TWITCH_CLIENT_SECRET = 'secret';
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  beforeEach(() => {
    fetchMock.mockReset();
    service = new TwitchLiveService({} as PrismaService, {} as PresenceGateway);
  });

  it('finds the next stream, skipping canceled and vacation days', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          broadcaster_name: 'BosEriko',
          segments: [
            {
              start_time: '2099-01-01T18:00:00Z',
              end_time: '2099-01-01T20:00:00Z',
              title: 'Canceled',
              canceled_until: '2099-01-01T20:00:00Z',
            },
            {
              start_time: '2099-01-03T18:00:00Z',
              end_time: '2099-01-03T20:00:00Z',
              title: 'Away',
              canceled_until: null,
            },
            {
              start_time: '2099-01-08T18:00:00Z',
              end_time: '2099-01-08T20:00:00Z',
              title: 'Watch party',
              canceled_until: null,
            },
          ],
          vacation: {
            start_time: '2099-01-02T00:00:00Z',
            end_time: '2099-01-05T00:00:00Z',
          },
        },
      }),
    });

    const expected = {
      startsAt: '2099-01-08T18:00:00Z',
      endsAt: '2099-01-08T20:00:00Z',
      title: 'Watch party',
      channel: 'BosEriko',
    };
    await expect(service.nextStream('141981764')).resolves.toEqual(expected);
    expect(fetchMock.mock.calls[1][0]).toContain('broadcaster_id=141981764');

    await expect(service.nextStream('141981764')).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns nothing for a channel without a schedule', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse)
      .mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(service.nextStream('141981764')).resolves.toBeNull();
  });

  it('returns nothing when Twitch can’t be reached', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    await expect(service.nextStream('141981764')).resolves.toBeNull();
  });
});
