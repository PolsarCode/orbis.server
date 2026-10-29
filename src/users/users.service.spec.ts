import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { TwitchLiveService } from '../friends/twitch-live.service';

describe('UsersService', () => {
  let service: UsersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: {} },
        { provide: StorageService, useValue: {} },
        { provide: PresenceGateway, useValue: {} },
        { provide: TwitchLiveService, useValue: {} },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

describe('Saving preferences', () => {
  const update = jest.fn();
  const service = new UsersService(
    { user: { update } } as unknown as PrismaService,
    {} as StorageService,
    {} as PresenceGateway,
    {} as TwitchLiveService,
  );

  it('remembers when someone turns off update notes', async () => {
    update.mockResolvedValue({
      id: 1,
      email: 'reader@anime.test',
      isAdmin: false,
      showChangelog: false,
    });

    const profile = await service.updatePreferences(1, {
      showChangelog: false,
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ showChangelog: false }),
      }),
    );
    expect(profile).toMatchObject({ showChangelog: false });
  });
});

describe('Onboarding', () => {
  const count = (value: number) => ({
    count: jest.fn().mockResolvedValue(value),
  });
  const prisma = {
    user: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        avatarUrl: null,
        tourCompletedAt: new Date(),
        checklistDismissedAt: null,
        completedTours: [],
      }),
    },
    membership: count(1),
    post: count(0),
    comment: count(0),
    friendship: count(0),
    report: count(0),
    libraryEntry: count(0),
    steamAccount: count(1),
    oAuthAccount: count(0),
    railFolder: count(2),
  };
  const service = new UsersService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    {} as PresenceGateway,
    {} as TwitchLiveService,
  );

  it('says which features someone already uses, so tips can skip them', async () => {
    const onboarding = await service.onboarding(1);

    expect(onboarding.used).toEqual({
      steam: true,
      connections: false,
      folders: true,
    });
    expect(prisma.steamAccount.count).toHaveBeenCalledWith({
      where: { userId: 1 },
    });
    expect(prisma.oAuthAccount.count).toHaveBeenCalledWith({
      where: { userId: 1 },
    });
    expect(prisma.railFolder.count).toHaveBeenCalledWith({
      where: { userId: 1 },
    });
  });
});

describe('Twitch on profiles', () => {
  const next = {
    startsAt: '2026-11-01T18:00:00.000Z',
    endsAt: null,
    title: 'Ranked grind',
    channel: 'Naruto',
  };
  const prisma = {
    user: { findUnique: jest.fn() },
    friendship: { findMany: jest.fn(), findFirst: jest.fn() },
    post: { count: jest.fn() },
    libraryEntry: { findMany: jest.fn() },
  };
  const twitch = { nextStream: jest.fn() };
  const service = new UsersService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    {} as PresenceGateway,
    twitch as unknown as TwitchLiveService,
  );

  function profileWith(
    account: { showLive: boolean; showClips: boolean } | null,
    isPublic = true,
  ) {
    prisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(
        'username' in where
          ? {
              id: 2,
              username: 'naruto',
              name: 'Naruto Uzumaki',
              avatarUrl: null,
              coverUrl: null,
              backgroundUrl: null,
              email: 'naruto@anime.test',
              isAdmin: false,
              isVerified: false,
              appearOffline: false,
              status: 'online',
              isPublic,
              createdAt: new Date('2026-10-01T00:00:00.000Z'),
              oauthAccounts: account
                ? [
                    {
                      username: 'naruto_live',
                      providerAccountId: 'twitch-2',
                      ...account,
                    },
                  ]
                : [],
              memberships: [],
            }
          : { showNsfw: false },
      ),
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.friendship.findMany.mockResolvedValue([]);
    prisma.friendship.findFirst.mockResolvedValue(null);
    prisma.post.count.mockResolvedValue(0);
    prisma.libraryEntry.findMany.mockResolvedValue([]);
    twitch.nextStream.mockResolvedValue(next);
  });

  it('shows the channel and next stream when live status is on', async () => {
    profileWith({ showLive: true, showClips: false });

    const profile = await service.publicProfile(1, 'naruto');

    expect(twitch.nextStream).toHaveBeenCalledWith('twitch-2');
    expect(profile).toMatchObject({
      twitchLogin: 'naruto_live',
      nextStream: next,
      hasClips: false,
    });
  });

  it('hides the channel and schedule when live status is off', async () => {
    profileWith({ showLive: false, showClips: true });

    const profile = await service.publicProfile(1, 'naruto');

    expect(twitch.nextStream).not.toHaveBeenCalled();
    expect(profile).toMatchObject({
      twitchLogin: null,
      nextStream: null,
      hasClips: true,
    });
  });

  it('leaves Twitch out for people without a Twitch connection', async () => {
    profileWith(null);

    const profile = await service.publicProfile(1, 'naruto');

    expect(profile).toMatchObject({
      twitchLogin: null,
      nextStream: null,
      hasClips: false,
    });
  });

  it('keeps Twitch details off private profiles for people who are not friends', async () => {
    profileWith({ showLive: true, showClips: true }, false);

    const profile = await service.publicProfile(1, 'naruto');

    expect(twitch.nextStream).not.toHaveBeenCalled();
    expect(profile).toMatchObject({
      restricted: true,
      twitchLogin: null,
      nextStream: null,
    });
  });
});

describe('Suspending accounts', () => {
  process.env.HEAD_ADMIN = 'head@orbis.test';
  const people: Record<string, object> = {
    1: { id: 1, isAdmin: false, email: 'head@orbis.test' },
    2: { id: 2, isAdmin: true, email: 'mod@orbis.test' },
    3: { id: 3, isAdmin: false, email: 'fan@orbis.test' },
    fan: { id: 3, isAdmin: false, email: 'fan@orbis.test' },
    mod: { id: 2, isAdmin: true, email: 'mod@orbis.test' },
    head: { id: 1, isAdmin: false, email: 'head@orbis.test' },
  };
  const prisma = {
    user: {
      findUnique: jest.fn(
        ({ where }: { where: { id?: number; username?: string } }) =>
          Promise.resolve(people[where.id ?? where.username!] ?? null),
      ),
      update: jest.fn(({ data }: { data: object }) =>
        Promise.resolve({ suspensionReason: null, ...data }),
      ),
    },
  };
  const presence = { disconnectUser: jest.fn() };
  const service = new UsersService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    presence as unknown as PresenceGateway,
    {} as TwitchLiveService,
  );

  beforeEach(() => {
    prisma.user.update.mockClear();
    presence.disconnectUser.mockClear();
  });

  it('suspends an account for a week and signs it out everywhere', async () => {
    const before = Date.now();

    const { suspension } = await service.setSuspension(
      2,
      'fan',
      '7d',
      ' Spam ',
    );

    const until = new Date(suspension!.until!).getTime();
    expect(until - before).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000);
    expect(until - before).toBeLessThan(7 * 24 * 60 * 60 * 1000 + 60_000);
    expect(suspension!.reason).toBe('Spam');
    expect(presence.disconnectUser).toHaveBeenCalledWith(3);
  });

  it('bans an account with no end date', async () => {
    const { suspension } = await service.setSuspension(2, 'fan', 'permanent');

    expect(suspension).toEqual({ until: null, reason: null });
  });

  it('lifts a suspension', async () => {
    await expect(service.setSuspension(2, 'fan', null)).resolves.toEqual({
      suspension: null,
    });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          suspendedAt: null,
          suspendedUntil: null,
          suspensionReason: null,
        },
      }),
    );
    expect(presence.disconnectUser).not.toHaveBeenCalled();
  });

  it('only lets site admins suspend accounts', async () => {
    await expect(service.setSuspension(3, 'mod', '1d')).rejects.toThrow(
      'Only site admins can suspend accounts',
    );
  });

  it('won’t suspend yourself or the head admin', async () => {
    await expect(service.setSuspension(2, 'mod', '1d')).rejects.toThrow(
      'You can’t suspend your own account',
    );
    await expect(service.setSuspension(2, 'head', '1d')).rejects.toThrow(
      'The head admin can’t be suspended',
    );
  });

  it('leaves suspending another admin to the head admin', async () => {
    prisma.user.findUnique.mockImplementationOnce(() =>
      Promise.resolve({ id: 4, isAdmin: true, email: 'other@orbis.test' }),
    );
    await expect(service.setSuspension(4, 'mod', '1d')).rejects.toThrow(
      'Only the head admin can suspend another admin',
    );
    await expect(service.setSuspension(1, 'mod', '1d')).resolves.toMatchObject({
      suspension: { reason: null },
    });
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it('shows a suspension only to site admins', async () => {
    prisma.user.findUnique
      .mockImplementationOnce(() => Promise.resolve(people[3]))
      .mockImplementationOnce(() => Promise.resolve(people[2]))
      .mockImplementationOnce(() =>
        Promise.resolve({
          suspendedAt: new Date(),
          suspendedUntil: null,
          suspensionReason: 'Spam',
        }),
      );

    await expect(service.suspensionFor(3, 2)).resolves.toBeNull();
    await expect(service.suspensionFor(2, 3)).resolves.toEqual({
      until: null,
      reason: 'Spam',
    });
  });
});

describe('Public people list', () => {
  it('leaves out suspended accounts', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new UsersService(
      { user: { findMany } } as unknown as PrismaService,
      {} as StorageService,
      {} as PresenceGateway,
      {} as TwitchLiveService,
    );

    await service.activePublicUsers();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isPublic: true,
          OR: [
            { suspendedAt: null },
            { suspendedUntil: { lte: expect.any(Date) } },
          ],
        },
      }),
    );
  });
});
