import { NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { TwitchLiveService } from '../friends/twitch-live.service';

describe('Profiles across a block or mute', () => {
  const prisma = {
    block: { count: jest.fn(), findMany: jest.fn() },
    mute: { count: jest.fn() },
    user: { findUnique: jest.fn() },
    friendship: { findMany: jest.fn(), findFirst: jest.fn() },
    post: { count: jest.fn() },
    libraryEntry: { findMany: jest.fn() },
  };
  const service = new UsersService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    {} as PresenceGateway,
    { nextStream: jest.fn() } as unknown as TwitchLiveService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(
        'username' in where
          ? {
              id: 2,
              username: 'vegeta',
              name: 'Vegeta',
              avatarUrl: 'https://cdn.test/vegeta.png',
              coverUrl: 'https://cdn.test/cover.png',
              backgroundUrl: null,
              email: 'vegeta@anime.test',
              isAdmin: false,
              isVerified: false,
              appearOffline: false,
              status: 'online',
              isPublic: true,
              createdAt: new Date('2026-10-01T00:00:00.000Z'),
              oauthAccounts: [],
              memberships: [
                {
                  community: {
                    id: 3,
                    name: 'Capsule Corp',
                    iconUrl: null,
                    coverUrl: null,
                    isVerified: false,
                    ownerId: 2,
                    isPublic: true,
                    _count: { memberships: 4 },
                    memberships: [],
                  },
                },
              ],
            }
          : { showNsfw: false },
      ),
    );
    prisma.block.findMany.mockResolvedValue([]);
    prisma.block.count.mockResolvedValue(0);
    prisma.mute.count.mockResolvedValue(0);
    prisma.friendship.findMany.mockResolvedValue([]);
    prisma.friendship.findFirst.mockResolvedValue(null);
    prisma.post.count.mockResolvedValue(12);
    prisma.libraryEntry.findMany.mockResolvedValue([]);
  });

  it('acts as if the profile doesn’t exist for someone its owner blocked', async () => {
    prisma.block.findMany.mockResolvedValue([{ blockerId: 2 }]);

    await expect(service.publicProfile(1, 'vegeta')).rejects.toThrow(
      new NotFoundException('This profile isn’t available'),
    );
    expect(prisma.block.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { blockerId: 1, blockedId: 2 },
          { blockerId: 2, blockedId: 1 },
        ],
      },
      select: { blockerId: true },
    });
    expect(prisma.friendship.findMany).not.toHaveBeenCalled();
  });

  it('shows the blocker only the name and avatar of someone they blocked', async () => {
    prisma.block.findMany.mockResolvedValue([{ blockerId: 1 }]);

    const profile = await service.publicProfile(1, 'vegeta');

    expect(profile).toMatchObject({
      userId: 2,
      username: 'vegeta',
      name: 'Vegeta',
      avatarUrl: 'https://cdn.test/vegeta.png',
      coverUrl: null,
      blocked: true,
      muted: false,
      restricted: true,
      postCount: 0,
      friendCount: 0,
      friends: [],
      library: [],
      communities: [],
    });
    expect(prisma.friendship.findMany).not.toHaveBeenCalled();
    expect(prisma.libraryEntry.findMany).not.toHaveBeenCalled();
  });

  it('says whether the viewer muted the person', async () => {
    prisma.mute.count.mockResolvedValue(1);

    const profile = await service.publicProfile(1, 'vegeta');

    expect(profile).toMatchObject({
      blocked: false,
      muted: true,
      restricted: false,
      postCount: 12,
    });
    expect(prisma.mute.count).toHaveBeenCalledWith({
      where: { muterId: 1, mutedId: 2 },
    });
  });

  it('flags neither when there’s no block or mute, and leaves out friends blocked with the viewer', async () => {
    const profile = await service.publicProfile(1, 'vegeta');

    expect(profile).toMatchObject({ blocked: false, muted: false });
    const notBlocked = {
      blocksMade: { none: { blockedId: 1 } },
      blocksReceived: { none: { blockerId: 1 } },
    };
    expect(prisma.friendship.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          requester: notBlocked,
          addressee: notBlocked,
        }),
      }),
    );
  });

  it('still shows a site admin the full profile of someone who blocked them, but keeps their own blocks', async () => {
    const base = prisma.user.findUnique.getMockImplementation()!;
    prisma.user.findUnique.mockImplementation(
      (args: { where: object; select: object }) =>
        'id' in args.where && 'isAdmin' in args.select
          ? Promise.resolve({ isAdmin: true, email: 'admin@anime.test' })
          : base(args),
    );
    prisma.block.findMany.mockResolvedValue([{ blockerId: 2 }]);

    await expect(service.publicProfile(1, 'vegeta')).resolves.toMatchObject({
      blocked: false,
      restricted: false,
      postCount: 12,
    });

    prisma.block.findMany.mockResolvedValue([{ blockerId: 1 }]);
    await expect(service.publicProfile(1, 'vegeta')).resolves.toMatchObject({
      blocked: true,
      restricted: true,
      postCount: 0,
    });
  });

  it('never flags the viewer’s own profile as muted', async () => {
    await service.publicProfile(2, 'vegeta');

    expect(prisma.mute.count).not.toHaveBeenCalled();
    expect(prisma.block.findMany).not.toHaveBeenCalled();
  });
});
