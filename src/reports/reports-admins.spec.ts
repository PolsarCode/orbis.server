import { ReportsService } from './reports.service';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PresenceGateway } from '../friends/presence.gateway';

describe('Admins list', () => {
  const prisma = {
    user: { findUnique: jest.fn(), findMany: jest.fn() },
  };
  const presence = {
    isOnline: jest.fn(),
    statusOf: jest.fn(),
    twitchOf: jest.fn(),
  };
  const service = new ReportsService(
    prisma as unknown as PrismaService,
    {} as NotificationsService,
    presence as unknown as PresenceGateway,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({
      isAdmin: true,
      email: 'admin@example.test',
    });
  });

  it('includes each admin’s status so live admins can be shown as streaming', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 7,
        username: 'kakashi',
        name: null,
        avatarUrl: null,
        email: 'kakashi@anime.test',
        appearOffline: false,
        status: 'online',
      },
    ]);
    presence.isOnline.mockReturnValue(false);
    presence.statusOf.mockReturnValue('streaming');
    presence.twitchOf.mockReturnValue('kakashi_tv');

    const [admin] = await service.admins(1);

    expect(presence.statusOf).toHaveBeenCalledWith(7, {
      appearOffline: false,
      status: 'online',
    });
    expect(admin).toMatchObject({
      id: 7,
      online: false,
      status: 'streaming',
      twitchLogin: 'kakashi_tv',
    });
    expect(admin).not.toHaveProperty('appearOffline');
    expect(admin).not.toHaveProperty('email');
  });
});
