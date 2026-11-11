import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CommunitiesService } from './communities.service';
import { CommunitiesController } from './communities.controller';
import { ALLOW_GUEST } from '../auth/allow-guest';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { TwitchLiveService } from '../friends/twitch-live.service';

const until = new Date('2026-11-11T00:00:00.000Z');
const weekAgo = new Date('2026-11-04T00:00:00.000Z');
const inWeek = { gte: weekAgo, lt: until };

function setup() {
  const prisma = {
    community: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    membership: {
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
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

const community = {
  id: 9,
  name: 'Reading club',
  description: 'We read things',
  iconUrl: 'https://cdn.example.test/communities/9.webp',
  coverUrl: null,
  isVerified: true,
  _count: { memberships: 42 },
};

describe('Community weekly growth', () => {
  it('shows a public community’s members and who joined in the week', async () => {
    const { prisma, service } = setup();
    prisma.community.findFirst.mockResolvedValue(community);
    prisma.membership.count.mockResolvedValue(5);

    await expect(service.weekly(9, until)).resolves.toEqual({
      id: 9,
      name: 'Reading club',
      description: 'We read things',
      iconUrl: 'https://cdn.example.test/communities/9.webp',
      coverUrl: null,
      isVerified: true,
      members: 42,
      gained: 5,
      startsAt: '2026-11-04T00:00:00.000Z',
      endsAt: '2026-11-11T00:00:00.000Z',
    });
    expect(prisma.community.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 9, isPublic: true } }),
    );
    expect(prisma.membership.count).toHaveBeenCalledWith({
      where: { communityId: 9, joinedAt: inWeek },
    });
  });

  it('treats private, missing and out-of-range communities as not found', async () => {
    const { prisma, service } = setup();

    await expect(service.weekly(9, until)).rejects.toThrow(
      new NotFoundException('Community not found'),
    );
    for (const id of [0, -1, 2147483648]) {
      await expect(service.weekly(id, until)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
    expect(prisma.community.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.membership.count).not.toHaveBeenCalled();
  });

  describe('route', () => {
    const communities = { weekly: jest.fn() };
    const controller = new CommunitiesController(
      communities as unknown as CommunitiesService,
    );

    beforeEach(() =>
      jest.useFakeTimers({ now: new Date('2026-11-11T09:00Z') }),
    );
    afterEach(() => jest.useRealTimers());

    it('lets guests open it, ending today unless a date is given', () => {
      expect(
        Reflect.getMetadata(
          ALLOW_GUEST,
          CommunitiesController.prototype.weekly,
        ),
      ).toBe(true);

      void controller.weekly(9);
      expect(communities.weekly).toHaveBeenLastCalledWith(9, until);
      void controller.weekly(9, '2026-11-01');
      expect(communities.weekly).toHaveBeenLastCalledWith(
        9,
        new Date('2026-11-01T00:00:00.000Z'),
      );
      expect(() => controller.weekly(9, '2026-1-1')).toThrow(
        BadRequestException,
      );
    });
  });
});

describe('Fastest-growing community', () => {
  const joined = (communityId: number, count: number) => ({
    communityId,
    _count: { communityId: count },
  });

  it('counts joins in the week for public communities, leaving out the ones given', async () => {
    const { prisma, service } = setup();

    await service.topGrowing(until, [3, 7]);

    expect(prisma.membership.groupBy).toHaveBeenCalledWith({
      by: ['communityId'],
      where: {
        joinedAt: inWeek,
        communityId: { notIn: [3, 7] },
        community: { isPublic: true },
      },
      _count: { communityId: true },
    });
  });

  it('returns nothing when nobody joined anything', async () => {
    const { prisma, service } = setup();

    await expect(service.topGrowing(until, [])).resolves.toBeNull();
    expect(prisma.community.findFirst).not.toHaveBeenCalled();
  });

  it('picks the most joins, breaking ties by more members, then the lower id', async () => {
    const { prisma, service } = setup();
    prisma.membership.groupBy.mockResolvedValue([
      joined(4, 3),
      joined(8, 6),
      joined(2, 6),
      joined(5, 1),
    ]);
    prisma.community.findFirst.mockResolvedValue({ id: 8 });

    await expect(service.topGrowing(until, [])).resolves.toEqual({
      id: 8,
      gained: 6,
    });
    expect(prisma.community.findFirst).toHaveBeenCalledWith({
      where: { id: { in: [8, 2] } },
      orderBy: [{ memberships: { _count: 'desc' } }, { id: 'asc' }],
      select: { id: true },
    });
  });
});
