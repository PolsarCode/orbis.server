import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ClipsService } from './clips.service';
import { PrismaService } from '../prisma.service';
import { TwitchLiveService } from '../friends/twitch-live.service';

describe('ClipsService', () => {
  const prisma = {
    block: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    mute: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    keywordFilter: { findMany: jest.fn().mockResolvedValue([]) },
    community: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    friendship: { findFirst: jest.fn() },
  };
  const twitch = { clips: jest.fn() };
  const service = new ClipsService(
    prisma as unknown as PrismaService,
    twitch as unknown as TwitchLiveService,
  );
  const clips = { items: [], nextCursor: null };

  beforeEach(() => {
    jest.clearAllMocks();
    twitch.clips.mockResolvedValue(clips);
  });

  it('loads a community’s clips from its Twitch channel', async () => {
    prisma.community.findUnique.mockResolvedValue({
      twitchUserId: '300',
      showTwitchClips: true,
    });

    await expect(service.forCommunity(9, 'next')).resolves.toBe(clips);
    expect(twitch.clips).toHaveBeenCalledWith('300', 'next');
  });

  it('has no clips when the community turned its Clips tab off', async () => {
    prisma.community.findUnique.mockResolvedValue({
      twitchUserId: '300',
      showTwitchClips: false,
    });

    await expect(service.forCommunity(9)).rejects.toThrow(NotFoundException);
    expect(twitch.clips).not.toHaveBeenCalled();
  });

  it('has no clips for a community without Twitch', async () => {
    prisma.community.findUnique.mockResolvedValue({ twitchUserId: null });

    await expect(service.forCommunity(9)).rejects.toThrow(NotFoundException);
    expect(twitch.clips).not.toHaveBeenCalled();
  });

  it('loads a profile’s clips when they show them', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      isPublic: true,
      oauthAccounts: [{ providerAccountId: '141981764' }],
    });

    await expect(service.forUser(1, 'Naruto')).resolves.toBe(clips);
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { username: 'naruto' },
        select: expect.objectContaining({
          oauthAccounts: expect.objectContaining({
            where: { provider: 'twitch', showClips: true },
          }),
        }),
      }),
    );
    expect(twitch.clips).toHaveBeenCalledWith('141981764', undefined);
  });

  it('has no clips when the person hides them or has no Twitch', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      isPublic: true,
      oauthAccounts: [],
    });

    await expect(service.forUser(1, 'naruto')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('keeps a private profile’s clips to their friends', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      isPublic: false,
      oauthAccounts: [{ providerAccountId: '141981764' }],
    });
    prisma.friendship.findFirst.mockResolvedValue(null);

    await expect(service.forUser(1, 'naruto')).rejects.toThrow(
      ForbiddenException,
    );
    expect(twitch.clips).not.toHaveBeenCalled();
  });
});
