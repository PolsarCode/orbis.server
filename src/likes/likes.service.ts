import { Injectable, NotFoundException } from '@nestjs/common';
import { LikeableType } from '../../prisma/generated/client';
import { PrismaService } from '../prisma.service';
import {
  EngagementTarget,
  requireTargetAccess,
  targetOf,
} from '../posts/wall-access';
import { reportedBy, visibleTo } from '../moderation/visibility';
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

  private async targetFor(
    userId: number,
    type: LikeableType,
    id: number,
  ): Promise<EngagementTarget> {
    if (type !== 'comment') return targetOf(this.prisma, userId, type, id);

    const reported = await reportedBy(this.prisma, userId);
    const comment = await this.prisma.comment.findFirst({
      where: { id, deletedAt: null, ...visibleTo(userId, reported.comment) },
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
    const target = await this.targetFor(userId, type, id);
    await requireTargetAccess(this.prisma, userId, target);

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
            : await tx.comment.update({ where: { id }, data, select });

      return { likeCount, liked };
    });
  }
}
