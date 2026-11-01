import { BadRequestException } from '@nestjs/common';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';
import { PrismaService } from '../prisma.service';
import { ReportsService } from '../reports/reports.service';
import { ModerationService } from './moderation.service';

describe('Moderating forum posts', () => {
  const prisma = {
    contentReport: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
    },
    forumPost: { findUnique: jest.fn(), updateMany: jest.fn() },
    post: { updateMany: jest.fn() },
    community: { findUnique: jest.fn() },
  };
  const reports = { shareActivity: jest.fn() };
  const service = new ModerationService(
    prisma as unknown as PrismaService,
    reports as unknown as ReportsService,
    { hiddenChanged: jest.fn() } as unknown as DiscordChannelService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.contentReport.findUnique.mockResolvedValue(null);
    prisma.contentReport.updateMany.mockResolvedValue({ count: 1 });
    prisma.community.findUnique.mockResolvedValue({
      ownerId: 1,
      _count: { memberships: 10 },
    });
  });

  it('won’t let people report their own forum posts', async () => {
    prisma.forumPost.findUnique.mockResolvedValue({ authorId: 4 });

    await expect(
      service.create(4, { type: 'forum_post', id: 40, reason: 'spam' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.contentReport.upsert).not.toHaveBeenCalled();
  });

  it('hides a forum post once enough people report it', async () => {
    prisma.forumPost.findUnique
      .mockResolvedValueOnce({ authorId: 2 })
      .mockResolvedValueOnce({
        hiddenAt: null,
        communityId: 3,
        author: { id: 2, isAdmin: false, email: 'naruto@anime.test' },
      });
    prisma.contentReport.count.mockResolvedValue(3);

    await service.create(4, { type: 'forum_post', id: 40, reason: 'spam' });

    expect(prisma.forumPost.updateMany).toHaveBeenCalledWith({
      where: { id: 40, hiddenAt: null },
      data: { hiddenAt: expect.any(Date) },
    });
    expect(prisma.post.updateMany).not.toHaveBeenCalled();
  });

  it('shows a forum post again when its reports are dismissed', async () => {
    await service.resolve(1, {
      type: 'forum_post',
      id: 40,
      resolution: 'dismissed',
    });

    expect(prisma.forumPost.updateMany).toHaveBeenCalledWith({
      where: { id: 40, hiddenAt: { not: null } },
      data: { hiddenAt: null },
    });
  });
});
