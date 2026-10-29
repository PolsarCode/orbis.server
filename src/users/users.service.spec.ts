import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { PresenceGateway } from '../friends/presence.gateway';

describe('UsersService', () => {
  let service: UsersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: {} },
        { provide: StorageService, useValue: {} },
        { provide: PresenceGateway, useValue: {} },
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
    thread: count(0),
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
