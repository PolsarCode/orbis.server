import { ForbiddenException } from '@nestjs/common';
import { CommunitiesService } from './communities.service';
import { InvitesService } from '../invites/invites.service';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { TwitchLiveService } from '../friends/twitch-live.service';

jest.mock('../invites/invite-card', () => ({ buildInviteCard: jest.fn() }));

function setup(banned: boolean) {
  const prisma = {
    community: {
      findUnique: jest.fn().mockResolvedValue({
        id: 9,
        isPublic: true,
        showTwitchLive: false,
        twitchUserId: null,
        discordGuildId: null,
        _count: { memberships: 3 },
      }),
    },
    membership: {
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      upsert: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    communityBan: {
      findUnique: jest.fn().mockResolvedValue(banned ? { userId: 5 } : null),
    },
    invite: {
      findFirst: jest.fn().mockResolvedValue({
        id: 3,
        community: { id: 9, isPublic: false },
      }),
      fields: { maxUses: 'maxUses' },
    },
  };
  const communities = new CommunitiesService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    {} as PresenceGateway,
    {} as TwitchLiveService,
  );
  const invites = new InvitesService(
    prisma as unknown as PrismaService,
    communities,
  );
  return { prisma, communities, invites };
}

describe('Banned people', () => {
  it('can’t join a public community again', async () => {
    const { prisma, communities } = setup(true);

    await expect(communities.join(5, 9)).rejects.toThrow(
      'You can’t join this community',
    );
    expect(prisma.membership.upsert).not.toHaveBeenCalled();
  });

  it('can’t get back in with an invite link', async () => {
    const { prisma, invites } = setup(true);

    await expect(invites.accept(5, 'code')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.membership.create).not.toHaveBeenCalled();
  });

  it('see a public community like a logged-out visitor, marked as banned', async () => {
    const { communities } = setup(true);

    const community = await communities.findOne(5, 9);

    expect(community).toMatchObject({ role: null, banned: true });
  });

  it('doesn’t mark people who aren’t banned', async () => {
    const { communities } = setup(false);

    const community = await communities.findOne(5, 9);

    expect(community).not.toHaveProperty('banned');
  });
});
