import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
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

  const connect = async () => {
    const client = {
      handshake: { auth: { token: 'token' } },
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
      playing: 'NBA 2K26',
      twitchLogin: null,
    });
  });
});
