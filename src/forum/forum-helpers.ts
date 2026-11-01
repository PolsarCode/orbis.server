import { Prisma } from '../../prisma/generated/client';
import { PrismaService } from '../prisma.service';
import { managedCommunities } from '../communities/managed-communities';
import { visibleTo } from '../moderation/visibility';

export const FORUM_PAGE_SIZE = 20;

export function threadLink(communityId: number, threadId: number) {
  return `/communities/${communityId}/forum/threads/${threadId}`;
}

export function forumPostLink(
  communityId: number,
  threadId: number,
  postId: number,
) {
  return `${threadLink(communityId, threadId)}?post=${postId}`;
}

export function visibleThreads(viewerId: number, reported: number[]) {
  return {
    posts: { some: { opening: true, ...visibleTo(viewerId, reported) } },
  } satisfies Prisma.ForumThreadWhereInput;
}

export async function isForumManager(
  prisma: PrismaService,
  userId: number,
  communityId: number,
) {
  return (await managedCommunities(prisma, userId, [communityId])).size > 0;
}

export async function isMember(
  prisma: PrismaService,
  userId: number,
  communityId: number,
) {
  const membership = await prisma.membership.findUnique({
    where: { userId_communityId: { userId, communityId } },
    select: { userId: true },
  });
  return membership !== null;
}

export function forumCleanup(
  prisma: PrismaService,
  communityId: number,
  threadIds: number[],
  postIds: number[],
) {
  return [
    prisma.like.deleteMany({
      where: { likeableType: 'forum_post', likeableId: { in: postIds } },
    }),
    prisma.contentReport.deleteMany({
      where: { targetType: 'forum_post', targetId: { in: postIds } },
    }),
    prisma.notification.deleteMany({
      where: {
        OR: threadIds.flatMap((threadId) => {
          const link = threadLink(communityId, threadId);
          return [{ link }, { link: { startsWith: `${link}?` } }];
        }),
      },
    }),
  ];
}
