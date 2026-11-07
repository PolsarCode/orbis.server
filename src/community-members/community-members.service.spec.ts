import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CommunityMembersService } from './community-members.service';
import { PrismaService } from '../prisma.service';
import { CommunitiesService } from '../communities/communities.service';
import { PostsService } from '../posts/posts.service';
import { CommentsService } from '../comments/comments.service';
import { ForumService } from '../forum/forum.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { CommunityRole } from '../communities/permissions';

jest.mock('../common/rich-text', () => ({ sanitizeRichText: jest.fn() }));

const OWNER = 1;
const ADMIN = 2;
const OTHER_ADMIN = 3;
const MEMBER = 4;
const STRANGER = 5;

const roles: Record<number, CommunityRole | null> = {
  [OWNER]: 'owner',
  [ADMIN]: 'admin',
  [OTHER_ADMIN]: 'admin',
  [MEMBER]: 'member',
  [STRANGER]: null,
};

function setup() {
  const prisma = {
    membership: { delete: jest.fn(), deleteMany: jest.fn() },
    communityBan: {
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ id: MEMBER }) },
    post: { findMany: jest.fn().mockResolvedValue([]) },
    comment: { findMany: jest.fn().mockResolvedValue([]) },
    forumThread: { findMany: jest.fn().mockResolvedValue([]) },
    forumPost: { findMany: jest.fn().mockResolvedValue([]) },
    repost: { deleteMany: jest.fn() },
    $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
  };
  const communities = {
    roleOf: jest.fn((userId: number) => Promise.resolve(roles[userId] ?? null)),
  };
  const posts = { remove: jest.fn().mockResolvedValue(undefined) };
  const comments = { remove: jest.fn().mockResolvedValue(undefined) };
  const forum = {
    removeThread: jest.fn().mockResolvedValue(undefined),
    removePost: jest.fn().mockResolvedValue(undefined),
  };
  const presence = { notify: jest.fn() };
  const service = new CommunityMembersService(
    prisma as unknown as PrismaService,
    communities as unknown as CommunitiesService,
    posts as unknown as PostsService,
    comments as unknown as CommentsService,
    forum as unknown as ForumService,
    presence as unknown as PresenceGateway,
  );
  return { prisma, posts, comments, forum, presence, service };
}

describe('Removing members', () => {
  it('lets admins remove members, and tells the removed person’s app quietly', async () => {
    const { prisma, presence, service } = setup();

    await service.remove(ADMIN, 9, MEMBER);

    expect(prisma.membership.delete).toHaveBeenCalledWith({
      where: { userId_communityId: { userId: MEMBER, communityId: 9 } },
    });
    expect(presence.notify).toHaveBeenCalledWith(
      [MEMBER],
      'community:removed',
      {
        communityId: 9,
      },
    );
  });

  it('keeps what the removed person posted', async () => {
    const { posts, comments, forum, service } = setup();

    await service.remove(ADMIN, 9, MEMBER);

    expect(posts.remove).not.toHaveBeenCalled();
    expect(comments.remove).not.toHaveBeenCalled();
    expect(forum.removeThread).not.toHaveBeenCalled();
  });

  it('only lets the owner remove admins, and nobody remove the owner', async () => {
    const { prisma, service } = setup();

    await expect(service.remove(ADMIN, 9, OTHER_ADMIN)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.remove(ADMIN, 9, OWNER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.membership.delete).not.toHaveBeenCalled();

    await service.remove(OWNER, 9, ADMIN);
    expect(prisma.membership.delete).toHaveBeenCalled();
  });

  it('refuses members, people removing themselves, and people who aren’t members', async () => {
    const { prisma, service } = setup();

    await expect(service.remove(MEMBER, 9, MEMBER + 10)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.remove(ADMIN, 9, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.remove(ADMIN, 9, STRANGER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.membership.delete).not.toHaveBeenCalled();
  });
});

describe('Banning', () => {
  it('records the ban, removes the membership and deletes what they posted or reposted there', async () => {
    const { prisma, posts, comments, forum, presence, service } = setup();
    prisma.post.findMany.mockResolvedValue([{ id: 10 }]);
    prisma.comment.findMany.mockResolvedValue([{ id: 21 }, { id: 20 }]);
    prisma.forumThread.findMany.mockResolvedValue([{ id: 30 }]);
    prisma.forumPost.findMany.mockResolvedValue([{ id: 40 }]);
    comments.remove.mockRejectedValueOnce(new NotFoundException());

    await service.ban(ADMIN, 9, MEMBER, '  Spam  ');

    expect(prisma.communityBan.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          communityId: 9,
          userId: MEMBER,
          bannedById: ADMIN,
          reason: 'Spam',
        },
      }),
    );
    expect(prisma.membership.deleteMany).toHaveBeenCalledWith({
      where: { userId: MEMBER, communityId: 9 },
    });
    expect(presence.notify).toHaveBeenCalledWith(
      [MEMBER],
      'community:removed',
      {
        communityId: 9,
      },
    );
    expect(prisma.repost.deleteMany).toHaveBeenCalledWith({
      where: { communityId: 9, userId: MEMBER },
    });
    expect(posts.remove).toHaveBeenCalledWith(ADMIN, 10);
    expect(comments.remove).toHaveBeenCalledWith(ADMIN, 21);
    expect(comments.remove).toHaveBeenCalledWith(ADMIN, 20);
    expect(forum.removeThread).toHaveBeenCalledWith(ADMIN, 9, 30);
    expect(forum.removePost).toHaveBeenCalledWith(ADMIN, 9, 40);
    expect(prisma.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { communityId: 9, authorId: MEMBER, deletedAt: null },
      }),
    );
  });

  it('can ban someone who already left, without signalling them', async () => {
    const { prisma, presence, service } = setup();
    prisma.user.findUnique.mockResolvedValue({ id: STRANGER });

    await service.ban(ADMIN, 9, STRANGER);

    expect(prisma.communityBan.upsert).toHaveBeenCalled();
    expect(presence.notify).not.toHaveBeenCalled();
  });

  it('follows the same rules as removing', async () => {
    const { prisma, service } = setup();

    await expect(service.ban(ADMIN, 9, OTHER_ADMIN)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.ban(OWNER, 9, OWNER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.communityBan.upsert).not.toHaveBeenCalled();
  });

  it('lets admins lift bans and see who’s banned, but not members', async () => {
    const { prisma, service } = setup();
    prisma.communityBan.deleteMany.mockResolvedValue({ count: 1 });

    await service.unban(ADMIN, 9, STRANGER);
    await service.bans(OWNER, 9);

    expect(prisma.communityBan.deleteMany).toHaveBeenCalledWith({
      where: { communityId: 9, userId: STRANGER },
    });
    expect(prisma.communityBan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { communityId: 9 } }),
    );
    await expect(service.unban(MEMBER, 9, STRANGER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.bans(MEMBER, 9)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('keeps listing a ban after the admin who issued it deleted their account', async () => {
    const { prisma, service } = setup();
    const ban = {
      reason: 'Spam',
      createdAt: new Date('2026-11-01T00:00:00Z'),
      user: { id: STRANGER, username: 'stranger', name: null, avatarUrl: null },
      bannedBy: null,
    };
    prisma.communityBan.findMany.mockResolvedValue([ban]);

    await expect(service.bans(OWNER, 9)).resolves.toEqual([ban]);
    expect(prisma.communityBan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          bannedBy: { select: expect.objectContaining({ username: true }) },
        }),
      }),
    );
  });
});
