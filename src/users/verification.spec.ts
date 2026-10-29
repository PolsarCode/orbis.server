import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { CommunitiesService } from '../communities/communities.service';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { TwitchLiveService } from '../friends/twitch-live.service';

const HEAD_ADMIN = 'head@example.test';

describe('Verification', () => {
  const headAdmin = process.env.HEAD_ADMIN;
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    community: { findUnique: jest.fn(), update: jest.fn() },
    friendship: { findMany: jest.fn() },
  };
  const presence = { notify: jest.fn() };
  const users = new UsersService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    presence as unknown as PresenceGateway,
    {} as TwitchLiveService,
  );
  const communities = new CommunitiesService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    {} as PresenceGateway,
    {} as TwitchLiveService,
  );

  function signedIn(email: string) {
    prisma.user.findUnique.mockResolvedValueOnce({ email });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.friendship.findMany.mockResolvedValue([]);
    process.env.HEAD_ADMIN = HEAD_ADMIN;
  });

  afterAll(() => {
    if (headAdmin === undefined) delete process.env.HEAD_ADMIN;
    else process.env.HEAD_ADMIN = headAdmin;
  });

  describe('profiles', () => {
    it('lets the head admin verify a profile', async () => {
      signedIn(HEAD_ADMIN);
      prisma.user.findUnique.mockResolvedValueOnce({ id: 7 });

      await expect(users.setVerified(1, 'Luffy', true)).resolves.toEqual({
        isVerified: true,
      });
      expect(prisma.user.findUnique).toHaveBeenLastCalledWith({
        where: { username: 'luffy' },
        select: { id: true },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { isVerified: true },
      });
    });

    it('lets the head admin remove a verification', async () => {
      signedIn(HEAD_ADMIN);
      prisma.user.findUnique.mockResolvedValueOnce({ id: 7 });

      await expect(users.setVerified(1, 'luffy', false)).resolves.toEqual({
        isVerified: false,
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { isVerified: false },
      });
    });

    it('tells friends and pending requests to reload their friends list', async () => {
      signedIn(HEAD_ADMIN);
      prisma.user.findUnique.mockResolvedValueOnce({ id: 7 });
      prisma.friendship.findMany.mockResolvedValueOnce([
        { requesterId: 7, addresseeId: 2 },
        { requesterId: 5, addresseeId: 7 },
      ]);

      await users.setVerified(1, 'luffy', true);

      expect(prisma.friendship.findMany).toHaveBeenCalledWith({
        where: { OR: [{ requesterId: 7 }, { addresseeId: 7 }] },
        select: { requesterId: true, addresseeId: true },
      });
      expect(presence.notify).toHaveBeenCalledWith([2, 5], 'friends:changed');
    });

    it('sends nothing when the profile has no friends', async () => {
      signedIn(HEAD_ADMIN);
      prisma.user.findUnique.mockResolvedValueOnce({ id: 7 });

      await users.setVerified(1, 'luffy', true);

      expect(presence.notify).not.toHaveBeenCalled();
    });

    it('refuses site admins who are not the head admin', async () => {
      signedIn('admin@user.com');

      await expect(users.setVerified(2, 'luffy', true)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('reports a missing profile', async () => {
      signedIn(HEAD_ADMIN);
      prisma.user.findUnique.mockResolvedValueOnce(null);

      await expect(users.setVerified(1, 'nobody', true)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('communities', () => {
    it('lets the head admin verify a community', async () => {
      signedIn(HEAD_ADMIN);
      prisma.community.findUnique.mockResolvedValueOnce({ id: 9 });

      await expect(communities.setVerified(1, 9, true)).resolves.toEqual({
        isVerified: true,
      });
      expect(prisma.community.update).toHaveBeenCalledWith({
        where: { id: 9 },
        data: { isVerified: true },
      });
    });

    it('refuses everyone else, including the community owner', async () => {
      signedIn('luffy@anime.test');

      await expect(communities.setVerified(3, 9, true)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.community.findUnique).not.toHaveBeenCalled();
      expect(prisma.community.update).not.toHaveBeenCalled();
    });

    it('refuses when no head admin is configured', async () => {
      delete process.env.HEAD_ADMIN;
      signedIn(HEAD_ADMIN);

      await expect(communities.setVerified(1, 9, true)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.community.update).not.toHaveBeenCalled();
    });

    it('reports a missing community', async () => {
      signedIn(HEAD_ADMIN);
      prisma.community.findUnique.mockResolvedValueOnce(null);

      await expect(communities.setVerified(1, 404, false)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.community.update).not.toHaveBeenCalled();
    });
  });
});
