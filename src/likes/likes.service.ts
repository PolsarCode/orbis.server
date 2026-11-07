import { Injectable, NotFoundException } from '@nestjs/common';
import { LikeableType } from '../../prisma/generated/client';
import { PrismaService } from '../prisma.service';
import {
  EngagementTarget,
  requireTargetAccess,
  targetOf,
} from '../posts/wall-access';
import { strictViewer, visibleTo } from '../moderation/visibility';
import { requireMembership } from '../communities/require-membership';
import { visibleThreads } from '../forum/forum-helpers';
import { isBlocked } from '../safety/blocks';
import { LikeDto } from './dto/like.dto';

export type LikeResult = { likeCount: number; liked: boolean };

@Injectable()
export class LikesService {
  constructor(private prisma: PrismaService) {}

  async likedBy(
    userId: number,
    likeableType: LikeableType,
    ids: number[],
  ): Promise<Set<number>> {
    if (ids.length === 0) return new Set();
    const likes = await this.prisma.like.findMany({
      where: { userId, likeableType, likeableId: { in: ids } },
      select: { likeableId: true },
    });
    return new Set(likes.map(({ likeableId }) => likeableId));
  }

  private async requireForumPostAccess(userId: number, id: number) {
    const viewer = await strictViewer(this.prisma, userId);
    const post = await this.prisma.forumPost.findFirst({
      where: {
        id,
        ...visibleTo(viewer, 'forum_post'),
        thread: visibleThreads(viewer),
      },
      select: { communityId: true },
    });
    if (!post) throw new NotFoundException('Not found');
    await requireMembership(this.prisma, userId, post.communityId);
  }

  private async targetFor(
    userId: number,
    type: Exclude<LikeableType, 'forum_post'>,
    id: number,
  ): Promise<EngagementTarget> {
    if (type !== 'comment') return targetOf(this.prisma, userId, type, id);

    const viewer = await strictViewer(this.prisma, userId);
    const comment = await this.prisma.comment.findFirst({
      where: { id, deletedAt: null, ...visibleTo(viewer, 'comment') },
      select: { commentableType: true, commentableId: true },
    });
    if (!comment) throw new NotFoundException('Not found');
    return targetOf(
      this.prisma,
      userId,
      comment.commentableType,
      comment.commentableId,
    );
  }

  async setLike(
    userId: number,
    { type, id, liked }: LikeDto,
  ): Promise<LikeResult> {
    if (type === 'forum_post') {
      await this.requireForumPostAccess(userId, id);
    } else {
      const target = await this.targetFor(userId, type, id);
      if (await isBlocked(this.prisma, userId, target.ownerId)) {
        throw new NotFoundException('Not found');
      }
      await requireTargetAccess(this.prisma, userId, target);
    }

    return this.prisma.$transaction(async (tx) => {
      const key = {
        userId_likeableType_likeableId: {
          userId,
          likeableType: type,
          likeableId: id,
        },
      };
      const existing = await tx.like.findUnique({ where: key });
      const delta = liked === Boolean(existing) ? 0 : liked ? 1 : -1;

      if (liked && !existing) {
        await tx.like.create({
          data: { userId, likeableType: type, likeableId: id },
        });
      } else if (!liked && existing) {
        await tx.like.delete({ where: key });
      }

      const data = { likeCount: { increment: delta } };
      const select = { likeCount: true } as const;
      const { likeCount } =
        type === 'post'
          ? await tx.post.update({ where: { id }, data, select })
          : type === 'activity'
            ? await tx.libraryActivity.update({ where: { id }, data, select })
            : type === 'forum_post'
              ? await tx.forumPost.update({ where: { id }, data, select })
              : await tx.comment.update({ where: { id }, data, select });

      return { likeCount, liked };
    });
  }

  async removeAllBy(userId: number) {
    const likes = await this.prisma.like.findMany({
      where: { userId },
      select: { likeableType: true, likeableId: true },
    });
    const fewer = (type: LikeableType) => ({
      where: {
        id: {
          in: likes.flatMap((like) =>
            like.likeableType === type ? [like.likeableId] : [],
          ),
        },
      },
      data: { likeCount: { decrement: 1 } },
    });
    await this.prisma.$transaction([
      this.prisma.post.updateMany(fewer('post')),
      this.prisma.libraryActivity.updateMany(fewer('activity')),
      this.prisma.comment.updateMany(fewer('comment')),
      this.prisma.forumPost.updateMany(fewer('forum_post')),
      this.prisma.like.deleteMany({ where: { userId } }),
    ]);
  }
}
