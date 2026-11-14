import { CommunitiesService } from './communities.service';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { TwitchLiveService } from '../friends/twitch-live.service';

const friend = { id: 7, username: 'nami', name: 'Nami', avatarUrl: null };

const row = (id: number, joined = false) => ({
  id,
  name: `Community ${id}`,
  description: null,
  iconUrl: null,
  coverUrl: null,
  isVerified: false,
  _count: { memberships: 10 },
  memberships: joined ? [{ userId: 4 }] : [],
});

function setup() {
  const prisma = {
    community: { findMany: jest.fn().mockResolvedValue([]) },
    membership: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    friendship: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ requesterId: 4, addresseeId: friend.id }]),
    },
  };
  const service = new CommunitiesService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    {} as PresenceGateway,
    {} as TwitchLiveService,
  );
  return { prisma, service };
}

describe('Exploring communities', () => {
  it('lists public communities you aren’t banned from, most members first', async () => {
    const { prisma, service } = setup();

    await service.explore(4, {}, 1);

    expect(prisma.community.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isPublic: true, bans: { none: { userId: 4 } } },
        orderBy: [{ memberships: { _count: 'desc' } }, { id: 'desc' }],
        skip: 0,
        take: 21,
      }),
    );
  });

  it('sorts by newest, hides joined communities, and pages by 20', async () => {
    const { prisma, service } = setup();
    prisma.community.findMany.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => row(index + 1)),
    );

    const page = await service.explore(
      4,
      { sort: 'newest', hideJoined: 'true' },
      2,
    );

    expect(prisma.community.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          memberships: { none: { userId: 4 } },
        }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 20,
      }),
    );
    expect(page.items).toHaveLength(20);
    expect(page.nextPage).toBe(3);
  });

  it('ends paging on the last page', async () => {
    const { prisma, service } = setup();
    prisma.community.findMany.mockResolvedValue([row(1, true)]);

    const page = await service.explore(4, {}, 1);

    expect(page.nextPage).toBeNull();
    expect(page.items[0]).toMatchObject({ id: 1, joined: true });
  });
});

describe('Searching communities', () => {
  it('matches names and descriptions', async () => {
    const { prisma, service } = setup();

    await service.search(4, { q: ' anime ' });

    expect(prisma.community.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isPublic: true,
          OR: [
            { name: { contains: 'anime', mode: 'insensitive' } },
            { description: { contains: 'anime', mode: 'insensitive' } },
          ],
        },
      }),
    );
  });
});

describe('Communities your friends joined', () => {
  it('ranks unjoined public communities by how many friends are in them', async () => {
    const { prisma, service } = setup();
    prisma.membership.groupBy.mockResolvedValue([
      { communityId: 3, _count: { userId: 2 } },
      { communityId: 8, _count: { userId: 1 } },
    ]);
    prisma.community.findMany.mockResolvedValue([row(8), row(3)]);
    prisma.membership.findMany.mockImplementation(({ where }) =>
      Promise.resolve(where.userId ? [{ communityId: 3, user: friend }] : []),
    );

    const picks = await service.friendPicks(4);

    expect(prisma.membership.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: { in: [friend.id] },
          community: {
            isPublic: true,
            memberships: { none: { userId: 4 } },
            bans: { none: { userId: 4 } },
          },
        },
        take: 6,
      }),
    );
    expect(picks.map(({ id }) => id)).toEqual([3, 8]);
    expect(picks[0]).toMatchObject({ mutuals: [friend], mutualCount: 1 });
    expect(prisma.friendship.findMany).toHaveBeenCalledTimes(1);
  });

  it('returns nothing without friends', async () => {
    const { prisma, service } = setup();
    prisma.friendship.findMany.mockResolvedValue([]);

    await expect(service.friendPicks(4)).resolves.toEqual([]);
    expect(prisma.membership.groupBy).not.toHaveBeenCalled();
  });
});
