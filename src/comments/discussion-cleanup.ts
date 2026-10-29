import { CommentableType } from '../../prisma/generated/client';
import { PrismaService } from '../prisma.service';

export async function discussionCleanup(
  prisma: PrismaService,
  type: CommentableType,
  ids: number[],
) {
  const comments = await prisma.comment.findMany({
    where: { commentableType: type, commentableId: { in: ids } },
    select: { id: true },
  });
  return [
    prisma.like.deleteMany({
      where: {
        likeableType: 'comment',
        likeableId: { in: comments.map(({ id }) => id) },
      },
    }),
    prisma.comment.deleteMany({
      where: { commentableType: type, commentableId: { in: ids } },
    }),
    prisma.like.deleteMany({
      where: { likeableType: type, likeableId: { in: ids } },
    }),
  ];
}
