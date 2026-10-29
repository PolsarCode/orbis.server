import { ForbiddenException } from '@nestjs/common';
import { PostsService } from './posts.service';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LikesService } from '../likes/likes.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';

jest.mock('../common/rich-text', () => ({
  sanitizeRichText: (html: string) => ({
    html,
    empty: !html.replace(/<[^>]+>/g, '').trim(),
  }),
}));

const person = { id: 1, username: 'reader', name: null, avatarUrl: null };

describe('Editing and deleting posts', () => {
  const prisma = {
    post: {
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    comment: { findMany: jest.fn(), deleteMany: jest.fn() },
    like: { deleteMany: jest.fn() },
    user: { findMany: jest.fn() },
    contentReport: { findMany: jest.fn() },
    membership: { findMany: jest.fn() },
    community: { findUnique: jest.fn() },
    $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
  };
  const notifications = { notify: jest.fn() };
  const discordChannel = {
    contentEdited: jest.fn(),
    contentDeleted: jest.fn(),
  };
  const service = new PostsService(
    prisma as unknown as PrismaService,
    notifications as unknown as NotificationsService,
    {
      likedBy: jest.fn().mockResolvedValue(new Set()),
    } as unknown as LikesService,
    discordChannel as unknown as DiscordChannelService,
  );

  const saved = {
    authorId: 1,
    content: '<p>hi <a href="/users/naruto" class="mention">@naruto</a></p>',
    communityId: 5,
    wallUserId: null,
    mediaType: null,
    mediaSourceId: null,
    wallUser: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.contentReport.findMany.mockResolvedValue([]);
    prisma.membership.findMany.mockResolvedValue([]);
    prisma.comment.findMany.mockResolvedValue([]);
    prisma.community.findUnique.mockResolvedValue({
      isPublic: true,
      memberships: [],
    });
  });

  it('lets the author edit, keeps old mentions, and only notifies new ones', async () => {
    prisma.post.findUnique.mockResolvedValue(saved);
    prisma.user.findMany.mockResolvedValue([
      { id: 7, username: 'naruto' },
      { id: 8, username: 'sasuke' },
    ]);
    prisma.post.update.mockImplementation(({ data }) => ({
      id: 3,
      ...saved,
      ...data,
      commentCount: 0,
      likeCount: 0,
      createdAt: new Date(),
      author: person,
      community: null,
    }));

    const item = await service.update(1, 3, {
      content:
        '<p>hi <a href="/users/naruto" class="mention">@naruto</a> @sasuke</p>',
    });

    const { data } = prisma.post.update.mock.calls[0][0];
    expect(data.editedAt).toBeInstanceOf(Date);
    expect(data.content).toContain('href="/users/naruto" class="mention"');
    expect(data.content).toContain('href="/users/sasuke" class="mention"');
    expect(
      notifications.notify.mock.calls.flatMap(([items]) =>
        items.map(({ userId }: { userId: number }) => userId),
      ),
    ).toEqual([8]);
    expect(discordChannel.contentEdited).toHaveBeenCalledWith('post', 3);
    expect(item).toMatchObject({ id: 3, canDelete: true });
  });

  it('won’t let someone else edit the post', async () => {
    prisma.post.findUnique.mockResolvedValue(saved);

    await expect(
      service.update(2, 3, { content: '<p>mine now</p>' }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it('lets community admins delete posts, along with their comments and likes', async () => {
    prisma.post.findUnique.mockResolvedValue(saved);
    prisma.membership.findMany.mockResolvedValue([
      {
        communityId: 5,
        community: { ownerId: 2 },
        roles: [{ role: { permissions: BigInt(1) } }],
      },
    ]);
    prisma.comment.findMany.mockResolvedValue([{ id: 40 }]);

    await service.remove(9, 3);

    expect(prisma.like.deleteMany).toHaveBeenCalledWith({
      where: { likeableType: 'comment', likeableId: { in: [40] } },
    });
    expect(prisma.comment.deleteMany).toHaveBeenCalledWith({
      where: { commentableType: 'post', commentableId: { in: [3] } },
    });
    expect(prisma.like.deleteMany).toHaveBeenCalledWith({
      where: { likeableType: 'post', likeableId: { in: [3] } },
    });
    expect(prisma.post.delete).toHaveBeenCalledWith({ where: { id: 3 } });
    expect(discordChannel.contentDeleted).toHaveBeenCalledWith('post', 3);
  });

  it('lets people remove posts from their own wall', async () => {
    prisma.post.findUnique.mockResolvedValue({
      ...saved,
      communityId: null,
      wallUserId: 6,
    });

    await service.remove(6, 3);

    expect(prisma.post.delete).toHaveBeenCalled();
  });

  it('won’t let other members delete someone’s post', async () => {
    prisma.post.findUnique.mockResolvedValue(saved);
    prisma.membership.findMany.mockResolvedValue([
      { communityId: 5, community: { ownerId: 2 }, roles: [] },
    ]);

    await expect(service.remove(9, 3)).rejects.toThrow(ForbiddenException);
    expect(prisma.post.delete).not.toHaveBeenCalled();
  });
});
