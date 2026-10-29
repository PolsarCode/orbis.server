import { DiscordChannelService } from '../discord-channel/discord-channel.service';
import { PrismaService } from '../prisma.service';
import { ReportsService } from '../reports/reports.service';
import { ModerationService } from './moderation.service';

describe('Keeping Discord in step with moderation', () => {
  const prisma = {
    contentReport: { updateMany: jest.fn() },
    post: { updateMany: jest.fn() },
    comment: { updateMany: jest.fn() },
  };
  const discordChannel = { hiddenChanged: jest.fn() };
  const service = new ModerationService(
    prisma as unknown as PrismaService,
    {} as ReportsService,
    discordChannel as unknown as DiscordChannelService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.contentReport.updateMany.mockResolvedValue({ count: 1 });
  });

  it('sends a hidden post again when its reports are dismissed', async () => {
    prisma.post.updateMany.mockResolvedValue({ count: 1 });

    await service.resolve(1, { type: 'post', id: 5, resolution: 'dismissed' });

    expect(prisma.post.updateMany).toHaveBeenCalledWith({
      where: { id: 5, hiddenAt: { not: null } },
      data: { hiddenAt: null },
    });
    expect(discordChannel.hiddenChanged).toHaveBeenCalledWith('post', 5, false);
  });

  it('leaves Discord alone when dismissing reports on a visible post', async () => {
    prisma.post.updateMany.mockResolvedValue({ count: 0 });

    await service.resolve(1, {
      type: 'post',
      id: 6,
      resolution: 'dismissed',
    });

    expect(discordChannel.hiddenChanged).not.toHaveBeenCalled();
  });
});
