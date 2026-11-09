import { CommentableType } from '../../prisma/generated/client';
import { PrismaService } from '../prisma.service';

export async function discussionCleanup(
  prisma: PrismaService,
  type: Exclude<CommentableType, 'chart'>,
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
    ...(type === 'post'
      ? [
          prisma.bookmark.deleteMany({
            where: { bookmarkableType: type, bookmarkableId: { in: ids } },
          }),
        ]
      : []),
  ];
}
