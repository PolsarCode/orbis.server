import { CommunitiesService } from './communities.service';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { TwitchLiveService } from '../friends/twitch-live.service';
import { discordWidget } from './discord-widget';

jest.mock('./discord-widget', () => ({ discordWidget: jest.fn() }));

describe('Community details', () => {
  const prisma = {
    community: { findUnique: jest.fn() },
    membership: { findUnique: jest.fn(), update: jest.fn() },
    communityBan: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const twitch = { nextStream: jest.fn() };
  const service = new CommunitiesService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    { isCommunityLive: () => false } as unknown as PresenceGateway,
    twitch as unknown as TwitchLiveService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns public community details to a non-member', async () => {
    prisma.community.findUnique.mockResolvedValue({
      id: 9,
      name: 'Reading club',
      isPublic: true,
      _count: { memberships: 3 },
    });
    prisma.membership.findUnique.mockResolvedValue(null);

    await expect(service.findOne(1, 9)).resolves.toEqual({
      id: 9,
      name: 'Reading club',
      isPublic: true,
      role: null,
      memberCount: 3,
      live: false,
      nextStream: null,
      discord: null,
    });
    expect(twitch.nextStream).not.toHaveBeenCalled();
  });

  it('includes the next scheduled stream for a community linked to Twitch', async () => {
    const nextStream = {
      startsAt: '2026-10-27T18:00:00Z',
      endsAt: '2026-10-27T20:00:00Z',
      title: 'Watch party',
    };
    prisma.community.findUnique.mockResolvedValue({
      id: 9,
      name: 'Reading club',
      isPublic: true,
      twitchUserId: '141981764',
      showTwitchLive: true,
      _count: { memberships: 3 },
    });
    prisma.membership.findUnique.mockResolvedValue(null);
    twitch.nextStream.mockResolvedValue(nextStream);

    await expect(service.findOne(1, 9)).resolves.toMatchObject({ nextStream });
    expect(twitch.nextStream).toHaveBeenCalledWith('141981764');
  });

  it('leaves out the live status and countdown when they’re turned off', async () => {
    prisma.community.findUnique.mockResolvedValue({
      id: 9,
      name: 'Reading club',
      isPublic: true,
      twitchUserId: '141981764',
      showTwitchLive: false,
      _count: { memberships: 3 },
    });
    prisma.membership.findUnique.mockResolvedValue(null);

    await expect(service.findOne(1, 9)).resolves.toMatchObject({
      live: false,
      nextStream: null,
    });
    expect(twitch.nextStream).not.toHaveBeenCalled();
  });

  it('does not return private community details to a non-member', async () => {
    prisma.community.findUnique.mockResolvedValue({
      id: 9,
      name: 'Reading club',
      isPublic: false,
      _count: { memberships: 3 },
    });
    prisma.membership.findUnique.mockResolvedValue(null);

    await expect(service.findOne(1, 9)).resolves.toBeNull();
  });

  it('returns member role for an existing member', async () => {
    prisma.community.findUnique.mockResolvedValue({
      id: 9,
      name: 'Reading club',
      isPublic: true,
      _count: { memberships: 3 },
    });
    prisma.membership.findUnique.mockResolvedValue({
      community: { ownerId: 2 },
      roles: [],
    });

    await expect(service.findOne(1, 9)).resolves.toMatchObject({
      id: 9,
      role: 'member',
    });
  });

  it('tells a member whether their library updates show there', async () => {
    prisma.community.findUnique.mockResolvedValue({
      id: 9,
      name: 'Reading club',
      isPublic: true,
      _count: { memberships: 3 },
    });
    prisma.membership.findUnique.mockResolvedValue({
      community: { ownerId: 2 },
      roles: [],
      showLibraryUpdates: false,
    });

    await expect(service.findOne(1, 9)).resolves.toMatchObject({
      role: 'member',
      showLibraryUpdates: false,
    });
  });

  it('saves whether a member’s library updates show in the community', async () => {
    prisma.membership.update.mockResolvedValue({ showLibraryUpdates: false });

    await expect(service.setShowLibraryUpdates(4, 9, false)).resolves.toEqual({
      showLibraryUpdates: false,
    });
    expect(prisma.membership.update).toHaveBeenCalledWith({
      where: { userId_communityId: { userId: 4, communityId: 9 } },
      data: { showLibraryUpdates: false },
      select: { showLibraryUpdates: true },
    });
  });

  it('saves a trimmed nickname for the member', async () => {
    prisma.membership.update.mockResolvedValue({ nickname: 'Navigator' });

    await service.setNickname(4, 9, '  Navigator  ');

    expect(prisma.membership.update).toHaveBeenCalledWith({
      where: { userId_communityId: { userId: 4, communityId: 9 } },
      data: { nickname: 'Navigator' },
      select: { nickname: true },
    });
  });

  it('clears a blank nickname', async () => {
    prisma.membership.update.mockResolvedValue({ nickname: null });

    await service.setNickname(4, 9, '   ');

    expect(prisma.membership.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { nickname: null } }),
    );
  });
});

describe('Community connection switches', () => {
  const prisma = {
    community: { findUnique: jest.fn(), update: jest.fn() },
    membership: { findUnique: jest.fn() },
    communityBan: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const presence = {
    isCommunityLive: jest.fn(() => true),
    stopCommunityLive: jest.fn(),
  };
  const service = new CommunitiesService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    presence as unknown as PresenceGateway,
    { nextStream: jest.fn() } as unknown as TwitchLiveService,
  );
  const community = {
    id: 9,
    name: 'Reading club',
    isPublic: true,
    ownerId: 2,
    discordGuildId: '900',
    discordGuildName: 'Readers',
    showDiscordOnline: false,
    showDiscordInvite: true,
    _count: { memberships: 3 },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(discordWidget).mockResolvedValue({
      online: 42,
      inviteUrl: 'https://discord.gg/readers',
    });
  });

  it('hides the Discord online count but keeps the Join link', async () => {
    prisma.community.findUnique.mockResolvedValue(community);
    prisma.membership.findUnique.mockResolvedValue(null);

    await expect(service.findOne(1, 9)).resolves.toMatchObject({
      discord: { online: null, inviteUrl: 'https://discord.gg/readers' },
    });
  });

  it('hides the Join link when the community turns it off', async () => {
    prisma.community.findUnique.mockResolvedValue({
      ...community,
      showDiscordOnline: true,
      showDiscordInvite: false,
    });
    prisma.membership.findUnique.mockResolvedValue(null);

    await expect(service.findOne(1, 9)).resolves.toMatchObject({
      discord: { online: 42, inviteUrl: null },
    });
  });

  it('still shows the count to admins so they can check the widget', async () => {
    prisma.community.findUnique.mockResolvedValue(community);
    prisma.membership.findUnique.mockResolvedValue({
      community: { ownerId: 1 },
      roles: [],
      showLibraryUpdates: true,
    });

    await expect(service.findOne(1, 9)).resolves.toMatchObject({
      discord: { online: 42 },
    });
  });

  it('takes the community offline right away when live status is turned off', async () => {
    prisma.membership.findUnique.mockResolvedValue({
      community: { ownerId: 1 },
      roles: [],
    });
    prisma.community.update.mockResolvedValue({
      ...community,
      showTwitchLive: false,
    });

    await service.update(1, 9, { showTwitchLive: false });

    expect(prisma.community.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ showTwitchLive: false }),
      }),
    );
    expect(presence.stopCommunityLive).toHaveBeenCalledWith(9);
  });
});
