import { CommunitiesService } from './communities.service';
import { ADMINISTRATOR } from './permissions';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { TwitchLiveService } from '../friends/twitch-live.service';

describe('Your role in each joined community', () => {
  const prisma = { membership: { findMany: jest.fn() } };
  const service = new CommunitiesService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    { isCommunityLive: () => false } as unknown as PresenceGateway,
    {} as TwitchLiveService,
  );

  const membership = (
    id: number,
    ownerId: number,
    permissions: bigint[] = [],
  ) => ({
    community: { id, ownerId, showTwitchLive: false },
    roles: permissions.map((value) => ({ role: { permissions: value } })),
  });

  it('marks you as owner, admin, or member', async () => {
    prisma.membership.findMany.mockResolvedValue([
      membership(1, 2),
      membership(2, 9, [BigInt(0), ADMINISTRATOR]),
      membership(3, 9, [BigInt(0)]),
    ]);

    const communities = await service.findForMember(2);

    expect(communities.map(({ id, role }) => [id, role])).toEqual([
      [1, 'owner'],
      [2, 'admin'],
      [3, 'member'],
    ]);
  });
});
