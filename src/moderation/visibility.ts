import { Prisma } from '../../prisma/generated/client';
import { PrismaService } from '../prisma.service';
import { notSuspended } from '../users/suspension';

export type ReportedIds = {
  post: number[];
  comment: number[];
};

export async function reportedBy(
  prisma: PrismaService,
  viewerId: number,
): Promise<ReportedIds> {
  const reports = await prisma.contentReport.findMany({
    where: {
      reporterId: viewerId,
      resolvedAt: null,
      targetType: { in: ['post', 'comment'] },
    },
    select: { targetType: true, targetId: true },
  });
  const ids: ReportedIds = { post: [], comment: [] };
  for (const { targetType, targetId } of reports) {
    if (targetType in ids) ids[targetType as keyof ReportedIds].push(targetId);
  }
  return ids;
}

export function visibleTo(viewerId: number, reported: number[]) {
  return {
    AND: [
      { OR: [{ hiddenAt: null }, { authorId: viewerId }] },
      { OR: [{ author: notSuspended() }, { authorId: viewerId }] },
      ...(reported.length > 0 ? [{ id: { notIn: reported } }] : []),
    ],
  } satisfies Prisma.PostWhereInput & Prisma.CommentWhereInput;
}
