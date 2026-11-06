import { CommunitiesService } from './communities.service';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { TwitchLiveService } from '../friends/twitch-live.service';

describe('Community member list across blocks', () => {
  const user = (id: number, username: string) => ({
    id,
    username,
    name: null,
    avatarUrl: null,
    coverUrl: null,
    isVerified: false,
    appearOffline: false,
    status: 'online' as const,
  });
  const prisma = {
    community: {
      findUnique: jest.fn().mockResolvedValue({
        ownerId: 1,
        memberships: [1, 2, 3].map((id) => ({
          nickname: null,
          joinedAt: new Date('2026-10-24T12:00:00Z'),
          user: user(id, ['', 'naruto', 'sasuke', 'sakura'][id]),
          roles: [],
        })),
      }),
    },
    block: {
      findMany: jest.fn().mockResolvedValue([{ blockerId: 3, blockedId: 1 }]),
    },
  };
  const live = new Set([2, 3]);
  const presence = {
    isOnline: () => true,
    statusOf: (id: number, { appearOffline }: { appearOffline: boolean }) =>
      appearOffline ? 'offline' : live.has(id) ? 'streaming' : 'online',
    playingOf: (id: number, { appearOffline }: { appearOffline: boolean }) =>
      appearOffline ? null : 'Elden Ring',
    twitchOf: (id: number, { appearOffline }: { appearOffline: boolean }) =>
      appearOffline || !live.has(id) ? null : `twitch${id}`,
  };
  const service = new CommunitiesService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    presence as unknown as PresenceGateway,
    {} as TwitchLiveService,
  );

  it('shows someone blocked either way as offline, with nothing playing or streaming', async () => {
    const members = await service.findMembers(1, 7);

    expect(prisma.block.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { blockerId: 1, blockedId: { in: [1, 2, 3] } },
          { blockedId: 1, blockerId: { in: [1, 2, 3] } },
        ],
      },
      select: { blockerId: true, blockedId: true },
    });
    expect(
      members.map(({ userId, online, status, playing, twitchLogin }) => [
        userId,
        online,
        status,
        playing,
        twitchLogin,
      ]),
    ).toEqual([
      [1, true, 'online', 'Elden Ring', null],
      [2, true, 'streaming', 'Elden Ring', 'twitch2'],
      [3, false, 'offline', null, null],
    ]);
  });
});
