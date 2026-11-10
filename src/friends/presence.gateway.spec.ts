import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { Prisma } from '../../prisma/generated/client';
import { PrismaService } from '../prisma.service';
import { PresenceGateway } from './presence.gateway';

describe('PresenceGateway', () => {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    friendship: { findMany: jest.fn().mockResolvedValue([]) },
    membership: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const jwt = { verifyAsync: jest.fn().mockResolvedValue({ sub: 7 }) };
  const visible = { appearOffline: false, status: 'online' as const };
  let gateway: PresenceGateway;

  const connect = async (platform?: unknown, idle?: unknown) => {
    const client = {
      handshake: { auth: { token: 'token', platform, idle } },
      connected: true,
      data: {},
      join: jest.fn(),
      disconnect: jest.fn(),
    } as unknown as Socket;
    await gateway.handleConnection(client);
    return client;
  };

  beforeEach(() => {
    gateway = new PresenceGateway(
      jwt as unknown as JwtService,
      prisma as unknown as PrismaService,
    );
  });

  afterEach(() => jest.useRealTimers());

  const atTime = (now: number) =>
    jest.useFakeTimers({
      now,
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });

  it('turns away a suspended account', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      suspendedAt: new Date(),
      suspendedUntil: null,
      suspensionReason: null,
    });

    const client = await connect();

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(gateway.statusOf(7, visible)).toBe('offline');
  });

  it('turns away an account waiting to be deleted and tokens from before signing out everywhere', async () => {
    const account = {
      suspendedAt: null,
      suspendedUntil: null,
      suspensionReason: null,
    };
    prisma.user.findUnique.mockResolvedValueOnce({
      ...account,
      deleteAt: new Date('2026-12-07T00:00:00Z'),
      sessionsRevokedAt: new Date('2026-11-07T00:00:00Z'),
    });
    expect((await connect()).disconnect).toHaveBeenCalledWith(true);

    jwt.verifyAsync.mockResolvedValueOnce({
      sub: 7,
      iat: new Date('2026-11-06T00:00:00Z').getTime() / 1000,
    });
    prisma.user.findUnique.mockResolvedValueOnce({
      ...account,
      deleteAt: null,
      sessionsRevokedAt: new Date('2026-11-07T00:00:00Z'),
    });
    expect((await connect()).disconnect).toHaveBeenCalledWith(true);
    expect(gateway.statusOf(7, visible)).toBe('offline');
  });

  describe('when the database is unreachable', () => {
    const unreachable = () =>
      new Prisma.PrismaClientKnownRequestError('Can’t reach database server', {
        code: 'ECONNREFUSED',
        clientVersion: 'test',
      });
    let warning: jest.SpyInstance;

    beforeEach(() => {
      warning = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
    });

    afterEach(() => warning.mockRestore());

    it('turns the connection away with a warning instead of crashing', async () => {
      prisma.user.findUnique.mockRejectedValueOnce(unreachable());
      const client = await connect();
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(gateway.statusOf(7, visible)).toBe('offline');

      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(unreachable());
      expect((await connect()).disconnect).toHaveBeenCalledWith(true);
      expect(warning).toHaveBeenCalledTimes(2);
    });

    it('still lets a connection go with a warning', async () => {
      const client = await connect();
      prisma.user.findUnique.mockRejectedValueOnce(unreachable());

      await expect(gateway.handleDisconnect(client)).resolves.toBeUndefined();
      expect(gateway.statusOf(7, visible)).toBe('offline');
      expect(warning).toHaveBeenCalledTimes(1);
    });
  });

  it('is offline without a connection or when appearing offline', async () => {
    expect(gateway.statusOf(7, visible)).toBe('offline');

    await connect();
    expect(gateway.statusOf(7, { ...visible, appearOffline: true })).toBe(
      'offline',
    );
  });

  it('shows busy over online and idle', async () => {
    const client = await connect();
    await gateway.setIdle(client, true);

    expect(gateway.statusOf(7, { ...visible, status: 'busy' })).toBe('busy');
  });

  it('stays idle when idle is chosen, even while active', async () => {
    await connect();

    expect(gateway.statusOf(7, { ...visible, status: 'idle' })).toBe('idle');
  });

  it('shows a live stream even without a connection', async () => {
    await gateway.updateLive(new Map([[7, 'naruto_live']]));

    expect(gateway.statusOf(7, visible)).toBe('streaming');
  });

  it('keeps appear offline over a live stream', async () => {
    await gateway.updateLive(new Map([[7, 'naruto_live']]));

    expect(gateway.statusOf(7, { ...visible, appearOffline: true })).toBe(
      'offline',
    );
  });

  it('shares the Twitch channel only while someone is visibly live', async () => {
    await gateway.updateLive(new Map([[7, 'naruto_live']]));

    expect(gateway.twitchOf(7, visible)).toBe('naruto_live');
    expect(gateway.twitchOf(7, { ...visible, appearOffline: true })).toBeNull();
    expect(gateway.twitchOf(8, visible)).toBeNull();

    await gateway.updateLive(new Map());
    expect(gateway.twitchOf(7, visible)).toBeNull();
  });

  it('stops showing a stream once it ends', async () => {
    await gateway.updateLive(new Map([[7, 'naruto_live']]));
    await gateway.updateLive(new Map());

    expect(gateway.statusOf(7, visible)).toBe('offline');
  });

  it('is idle only when every connection is idle', async () => {
    const first = await connect();
    const second = await connect();

    await gateway.setIdle(first, true);
    expect(gateway.statusOf(7, visible)).toBe('online');

    await gateway.setIdle(second, true);
    expect(gateway.statusOf(7, visible)).toBe('idle');

    await gateway.setIdle(first, false);
    expect(gateway.statusOf(7, visible)).toBe('online');
  });

  it('stops being idle when an active connection is left', async () => {
    const idle = await connect();
    const active = await connect();
    await gateway.setIdle(idle, true);

    await gateway.handleDisconnect(active);
    expect(gateway.statusOf(7, visible)).toBe('idle');

    await gateway.handleDisconnect(idle);
    expect(gateway.statusOf(7, visible)).toBe('offline');
  });

  it('announces someone coming online only on their first connection', async () => {
    const cameOnline = jest.fn();
    gateway.cameOnline.subscribe(cameOnline);

    const first = await connect();
    const second = await connect();
    expect(cameOnline).toHaveBeenCalledTimes(1);
    expect(cameOnline).toHaveBeenCalledWith(7);

    await gateway.handleDisconnect(first);
    await gateway.handleDisconnect(second);
    await connect();
    expect(cameOnline).toHaveBeenCalledTimes(2);
  });

  it('shares the Steam game someone is playing only while they are online', async () => {
    await gateway.updatePlaying(new Map([[7, 'NBA 2K26']]));
    expect(gateway.playingOf(7, visible)).toBeNull();

    await connect();
    expect(gateway.playingOf(7, visible)).toBe('NBA 2K26');
    expect(
      gateway.playingOf(7, { ...visible, appearOffline: true }),
    ).toBeNull();

    await gateway.stopPlaying(7);
    expect(gateway.playingOf(7, visible)).toBeNull();
  });

  it('tells friends when someone starts playing a game', async () => {
    const emit = jest.fn();
    gateway.server = { to: jest.fn(() => ({ emit })) } as unknown as Server;
    await connect();
    prisma.user.findUnique.mockResolvedValueOnce(visible);
    prisma.friendship.findMany.mockResolvedValueOnce([
      { requesterId: 7, addresseeId: 8 },
    ]);

    await gateway.updatePlaying(new Map([[7, 'NBA 2K26']]));

    expect(emit).toHaveBeenCalledWith('presence', {
      userId: 7,
      online: true,
      status: 'online',
      device: 'web',
      playing: 'NBA 2K26',
      twitchLogin: null,
    });
  });

  it.each([
    ['desktop', 'desktop'],
    ['mobile', 'mobile'],
    ['tablet', 'web'],
    [42, 'web'],
    [undefined, 'web'],
  ])(
    'reads the platform %p from the handshake as %p',
    async (platform, device) => {
      await connect(platform);

      expect(gateway.deviceOf(7, visible)).toBe(device);
    },
  );

  it('shows the most recently active device, ranking idle connections lower', async () => {
    atTime(1000);
    const desktop = await connect('desktop');
    jest.setSystemTime(2000);
    const phone = await connect('mobile');
    expect(gateway.deviceOf(7, visible)).toBe('mobile');

    await gateway.setIdle(phone, true);
    expect(gateway.deviceOf(7, visible)).toBe('desktop');

    jest.setSystemTime(3000);
    await gateway.setIdle(phone, false);
    expect(gateway.deviceOf(7, visible)).toBe('mobile');

    await gateway.setIdle(phone, true);
    await gateway.setIdle(desktop, true);
    expect(gateway.deviceOf(7, visible)).toBe('mobile');
  });

  it('counts a connection that is idle in the handshake as idle, without taking over the device', async () => {
    atTime(1000);
    await connect('mobile', true);
    expect(gateway.statusOf(7, visible)).toBe('idle');
    expect(gateway.deviceOf(7, visible)).toBe('mobile');

    jest.setSystemTime(2000);
    const desktop = await connect('desktop');
    expect(gateway.statusOf(7, visible)).toBe('online');
    expect(gateway.deviceOf(7, visible)).toBe('desktop');

    jest.setSystemTime(3000);
    await connect('mobile', true);
    expect(gateway.deviceOf(7, visible)).toBe('desktop');

    await gateway.setIdle(desktop, true);
    jest.setSystemTime(4000);
    await connect('mobile', true);
    expect(gateway.statusOf(7, visible)).toBe('idle');
    expect(gateway.deviceOf(7, visible)).toBe('desktop');
  });

  it('counts typing as activity on that device', async () => {
    atTime(1000);
    const desktop = await connect('desktop');
    jest.setSystemTime(2000);
    await connect('mobile');

    jest.setSystemTime(3000);
    await gateway.markActive(desktop);
    expect(gateway.deviceOf(7, visible)).toBe('desktop');
  });

  it('tells friends when someone switches to another device', async () => {
    atTime(1000);
    await connect('desktop');
    const emit = jest.fn();
    gateway.server = { to: jest.fn(() => ({ emit })) } as unknown as Server;
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(visible);
    prisma.friendship.findMany.mockResolvedValueOnce([
      { requesterId: 7, addresseeId: 8 },
    ]);

    jest.setSystemTime(2000);
    await connect('mobile');
    expect(emit).toHaveBeenCalledWith('presence', {
      userId: 7,
      online: true,
      status: 'online',
      device: 'mobile',
      playing: null,
      twitchLogin: null,
    });

    jest.setSystemTime(3000);
    await connect('mobile');
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('shares no device while appearing offline or disconnected', async () => {
    await gateway.updateLive(new Map([[7, 'naruto_live']]));
    expect(gateway.deviceOf(7, visible)).toBeNull();

    const client = await connect('desktop');
    expect(gateway.deviceOf(7, { appearOffline: true })).toBeNull();

    const emit = jest.fn();
    gateway.server = { to: jest.fn(() => ({ emit })) } as unknown as Server;
    prisma.user.findUnique.mockResolvedValueOnce({
      ...visible,
      appearOffline: true,
    });
    prisma.friendship.findMany.mockResolvedValueOnce([
      { requesterId: 7, addresseeId: 8 },
    ]);
    await gateway.broadcastPresence(7);
    expect(emit).toHaveBeenCalledWith(
      'presence',
      expect.objectContaining({ online: false, device: null }),
    );

    await gateway.handleDisconnect(client);
    expect(gateway.deviceOf(7, visible)).toBeNull();
  });
});
