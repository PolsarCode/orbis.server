import { ForbiddenException } from '@nestjs/common';
import { CommunitiesService } from './communities.service';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { TwitchLiveService } from '../friends/twitch-live.service';

describe('Deleting a community', () => {
  const prisma = {
    membership: { findUnique: jest.fn() },
    discordChannel: { findUnique: jest.fn() },
    post: { findMany: jest.fn() },
    comment: { findMany: jest.fn(), deleteMany: jest.fn() },
    like: { deleteMany: jest.fn() },
    contentReport: { deleteMany: jest.fn() },
    notification: { deleteMany: jest.fn() },
    community: { delete: jest.fn() },
    $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
  };
  const storage = { keyFor: jest.fn(() => null), delete: jest.fn() };
  const service = new CommunitiesService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    {} as PresenceGateway,
    {} as TwitchLiveService,
  );

  function ownedBy(ownerId: number) {
    prisma.membership.findUnique.mockResolvedValue({
      community: { ownerId },
      roles: [],
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.discordChannel.findUnique.mockResolvedValue(null);
    prisma.post.findMany.mockResolvedValue([{ id: 10 }, { id: 11 }]);
    prisma.comment.findMany.mockResolvedValue([{ id: 20 }]);
    prisma.community.delete.mockResolvedValue({
      id: 3,
      iconUrl: null,
      coverUrl: null,
      backgroundUrl: null,
    });
  });

  it('also deletes likes, reports and notifications that pointed into it', async () => {
    ownedBy(1);

    await service.remove(1, 3);

    expect(prisma.community.delete).toHaveBeenCalledWith({ where: { id: 3 } });
    expect(prisma.like.deleteMany).toHaveBeenCalledWith({
      where: { likeableType: 'post', likeableId: { in: [10, 11] } },
    });
    expect(prisma.like.deleteMany).toHaveBeenCalledWith({
      where: { likeableType: 'comment', likeableId: { in: [20] } },
    });
    expect(prisma.contentReport.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { targetType: 'community', targetId: 3 },
          { targetType: 'post', targetId: { in: [10, 11] } },
          { targetType: 'comment', targetId: { in: [20] } },
        ],
      },
    });
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { link: '/communities/3' },
          { link: { startsWith: '/communities/3?' } },
          { link: { startsWith: '/communities/3/' } },
        ],
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('lets only the owner delete it', async () => {
    ownedBy(1);

    await expect(service.remove(2, 3)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.community.delete).not.toHaveBeenCalled();
    expect(prisma.notification.deleteMany).not.toHaveBeenCalled();
  });
});
