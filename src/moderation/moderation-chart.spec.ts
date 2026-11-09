import { DiscordChannelService } from '../discord-channel/discord-channel.service';
import { PrismaService } from '../prisma.service';
import { ReportsService } from '../reports/reports.service';
import { ModerationService } from './moderation.service';

describe('Reported comments in chart discussions', () => {
  const reporter = { id: 4, username: 'nami', name: null, avatarUrl: null };
  const prisma = {
    contentReport: { findMany: jest.fn() },
    comment: { findUnique: jest.fn() },
    chartDiscussion: { findUnique: jest.fn() },
  };
  const service = new ModerationService(
    prisma as unknown as PrismaService,
    {} as ReportsService,
    {} as DiscordChannelService,
  );

  it('links the report to the chart’s discussion', async () => {
    prisma.contentReport.findMany.mockResolvedValue([
      {
        id: 1,
        targetType: 'comment',
        targetId: 11,
        reason: 'spam',
        details: null,
        createdAt: new Date('2026-11-10T00:00:00Z'),
        reporter,
      },
    ]);
    prisma.comment.findUnique.mockResolvedValue({
      content: '<p>Buy cheap followers</p>',
      commentableType: 'chart',
      commentableId: 5,
      author: { id: 2, username: 'zoro', name: null, avatarUrl: null },
    });
    prisma.chartDiscussion.findUnique.mockResolvedValue({
      mediaType: 'game',
      week: '2026-W46',
    });

    const [item] = await service.open();

    expect(prisma.chartDiscussion.findUnique).toHaveBeenCalledWith({
      where: { id: 5 },
      select: { mediaType: true, week: true },
    });
    expect(item.target).toEqual({
      title: 'Comment',
      excerpt: 'Buy cheap followers',
      author: expect.objectContaining({ username: 'zoro' }),
      link: '/library?tab=charts&type=game&week=2026-W46#discussion',
    });
  });
});
