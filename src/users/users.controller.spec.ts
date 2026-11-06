import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { SteamSyncService } from '../library/steam-sync.service';

describe('UsersController', () => {
  let controller: UsersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: {} },
        { provide: PresenceGateway, useValue: {} },
        { provide: SteamSyncService, useValue: {} },
      ],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

describe('Profiles of blocked people for site admins', () => {
  it('still carries the admin-only suspension and two-factor details', async () => {
    const suspension = { until: null, reason: 'Spam' };
    const usersService = {
      publicProfile: jest.fn().mockResolvedValue({
        userId: 2,
        restricted: true,
        blocked: true,
        appearOffline: true,
        status: 'online',
        friends: [],
      }),
      suspensionFor: jest.fn().mockResolvedValue(suspension),
      twoFactorFor: jest.fn().mockResolvedValue(true),
    };
    const steamSync = { refresh: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: usersService },
        {
          provide: PresenceGateway,
          useValue: { statusOf: jest.fn(() => 'offline') },
        },
        { provide: SteamSyncService, useValue: steamSync },
      ],
    }).compile();
    const controller = module.get<UsersController>(UsersController);

    const profile = await controller.publicProfile(
      { user: { userId: 1 } },
      'vegeta',
    );

    expect(profile).toMatchObject({
      blocked: true,
      suspension,
      twoFactorEnabled: true,
    });
    expect(usersService.suspensionFor).toHaveBeenCalledWith(1, 2);
    expect(usersService.twoFactorFor).toHaveBeenCalledWith(1, 2);
    expect(steamSync.refresh).not.toHaveBeenCalled();
  });
});
