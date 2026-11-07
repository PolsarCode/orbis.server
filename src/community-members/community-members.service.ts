import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CommunitiesService } from '../communities/communities.service';
import { PostsService } from '../posts/posts.service';
import { CommentsService } from '../comments/comments.service';
import { ForumService } from '../forum/forum.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { MAX_INT } from '../communities/community-member.guard';
import { canActOn } from '../communities/member-moderation';
import { author } from '../common/author';
import { ignoreMissing } from '../common/not-found';

export const COMMUNITY_REMOVED_EVENT = 'community:removed';

@Injectable()
export class CommunityMembersService {
  constructor(
    private prisma: PrismaService,
    private communities: CommunitiesService,
    private posts: PostsService,
    private comments: CommentsService,
    private forum: ForumService,
    private presence: PresenceGateway,
  ) {}

  private async requireAdmin(actorId: number, communityId: number) {
    const role = await this.communities.roleOf(actorId, communityId);
    if (role !== 'owner' && role !== 'admin') {
      throw new ForbiddenException('Only admins can do this');
    }
    return role;
  }

  private async requireCanModerate(
    actorId: number,
    communityId: number,
    targetId: number,
  ) {
    if (targetId < 1 || targetId > MAX_INT) {
      throw new NotFoundException('Member not found');
    }
    if (targetId === actorId) {
      throw new BadRequestException(
        'You can’t remove or ban yourself. Leave the community instead',
      );
    }
    const actorRole = await this.requireAdmin(actorId, communityId);
    const targetRole = await this.communities.roleOf(targetId, communityId);
    if (!canActOn(actorRole, targetRole)) {
      throw new ForbiddenException(
        targetRole === 'owner'
          ? 'The owner can’t be removed or banned'
          : 'Only the owner can remove or ban admins',
      );
    }
    return targetRole;
  }

  async remove(actorId: number, communityId: number, targetId: number) {
    const role = await this.requireCanModerate(actorId, communityId, targetId);
    if (!role) throw new NotFoundException('Member not found');

    await this.prisma.membership.delete({
      where: { userId_communityId: { userId: targetId, communityId } },
    });
    this.presence.notify([targetId], COMMUNITY_REMOVED_EVENT, { communityId });
  }

  async ban(
    actorId: number,
    communityId: number,
    targetId: number,
    reason?: string,
  ) {
    const role = await this.requireCanModerate(actorId, communityId, targetId);
    const user = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('Member not found');

    const note = reason?.trim() || null;
    const key = { communityId_userId: { communityId, userId: targetId } };
    await this.prisma.$transaction([
      this.prisma.communityBan.upsert({
        where: key,
        create: {
          communityId,
          userId: targetId,
          bannedById: actorId,
          reason: note,
        },
        update: { bannedById: actorId, reason: note, createdAt: new Date() },
      }),
      this.prisma.membership.deleteMany({
        where: { userId: targetId, communityId },
      }),
    ]);
    if (role) {
      this.presence.notify([targetId], COMMUNITY_REMOVED_EVENT, {
        communityId,
      });
    }
    await this.deleteContent(actorId, communityId, targetId);
  }

  private async deleteContent(
    actorId: number,
    communityId: number,
    authorId: number,
  ) {
    await this.prisma.repost.deleteMany({
      where: { communityId, userId: authorId },
    });

    const posts = await this.prisma.post.findMany({
      where: { communityId, authorId },
      select: { id: true },
    });
    for (const { id } of posts) {
      await this.posts.remove(actorId, id).catch(ignoreMissing);
    }

    const comments = await this.prisma.comment.findMany({
      where: { communityId, authorId, deletedAt: null },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    for (const { id } of comments) {
      await this.comments.remove(actorId, id).catch(ignoreMissing);
    }

    const threads = await this.prisma.forumThread.findMany({
      where: { communityId, authorId },
      select: { id: true },
    });
    for (const { id } of threads) {
      await this.forum
        .removeThread(actorId, communityId, id)
        .catch(ignoreMissing);
    }

    const replies = await this.prisma.forumPost.findMany({
      where: { communityId, authorId, opening: false },
      select: { id: true },
    });
    for (const { id } of replies) {
      await this.forum
        .removePost(actorId, communityId, id)
        .catch(ignoreMissing);
    }
  }

  async unban(actorId: number, communityId: number, targetId: number) {
    await this.requireAdmin(actorId, communityId);
    const { count } = await this.prisma.communityBan.deleteMany({
      where: { communityId, userId: targetId },
    });
    if (count === 0) throw new NotFoundException('That person isn’t banned');
  }

  async bans(actorId: number, communityId: number) {
    await this.requireAdmin(actorId, communityId);
    return this.prisma.communityBan.findMany({
      where: { communityId },
      orderBy: { createdAt: 'desc' },
      select: { reason: true, createdAt: true, user: author, bannedBy: author },
    });
  }
}
