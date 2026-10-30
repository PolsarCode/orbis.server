import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  CommunitiesService,
  MAX_JOINED_COMMUNITIES,
} from './communities.service';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { TwitchLiveService } from '../friends/twitch-live.service';

describe('Leaving a community', () => {
  const prisma = {
    community: { findUnique: jest.fn() },
    membership: { deleteMany: jest.fn(), count: jest.fn() },
  };
  const service = new CommunitiesService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    {} as PresenceGateway,
    {} as TwitchLiveService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.community.findUnique.mockResolvedValue({ ownerId: 1 });
    prisma.membership.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('removes the membership, along with its roles', async () => {
    await service.leave(2, 5);

    expect(prisma.membership.deleteMany).toHaveBeenCalledWith({
      where: { userId: 2, communityId: 5 },
    });
  });

  it('tells the owner why they can’t leave', async () => {
    await expect(service.leave(1, 5)).rejects.toThrow(
      new BadRequestException(
        'You own this community, so you can’t leave it. Delete it in its settings instead',
      ),
    );
    expect(prisma.membership.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses people who aren’t members, and unknown communities', async () => {
    prisma.membership.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.leave(2, 5)).rejects.toBeInstanceOf(NotFoundException);

    prisma.community.findUnique.mockResolvedValue(null);
    await expect(service.leave(2, 999)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.leave(2, 0)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('frees a slot under the join limit', async () => {
    prisma.membership.count.mockResolvedValueOnce(MAX_JOINED_COMMUNITIES);
    await expect(service.requireRoomToJoin(2)).rejects.toThrow(
      'Leave one to join another',
    );

    await service.leave(2, 5);
    prisma.membership.count.mockResolvedValueOnce(MAX_JOINED_COMMUNITIES - 1);
    await expect(service.requireRoomToJoin(2)).resolves.toBeUndefined();
  });
});
