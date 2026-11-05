import { Prisma } from '../../prisma/generated/client';
import { visibleThreads } from '../forum/forum-helpers';
import { ReportedIds, visibleTo } from '../moderation/visibility';
import { nsfwEntries } from '../users/nsfw';
import { notSuspended } from '../users/suspension';

export function publicPosts(): Prisma.PostWhereInput {
  return {
    OR: [
      { community: { isPublic: true } },
      { wallUser: { isPublic: true } },
      { mediaType: { not: null } },
    ],
  };
}

function publicPost(
  viewerId: number,
  reported: ReportedIds,
): Prisma.PostWhereInput {
  return { AND: [publicPosts(), visibleTo(viewerId, reported.post)] };
}

function publicActivity(showNsfw: boolean): Prisma.LibraryActivityWhereInput {
  return {
    entry: {
      isPublic: true,
      ...nsfwEntries(showNsfw),
      user: { isPublic: true, ...notSuspended() },
    },
  };
}

function publicForumPost(
  viewerId: number,
  reported: ReportedIds,
): Prisma.ForumPostWhereInput {
  return {
    AND: [
      { community: { isPublic: true } },
      { thread: visibleThreads(viewerId, reported.forum_post) },
      { OR: [{ opening: false }, { thread: { feedPost: { is: null } } }] },
      visibleTo(viewerId, reported.forum_post),
    ],
  };
}

export function publicUsages(
  viewerId: number,
  reported: ReportedIds,
  showNsfw: boolean,
): Prisma.HashtagUsageWhereInput {
  return {
    OR: [
      { post: publicPost(viewerId, reported) },
      {
        AND: [
          {
            comment: {
              deletedAt: null,
              ...visibleTo(viewerId, reported.comment),
            },
          },
          {
            OR: [
              { targetPost: publicPost(viewerId, reported) },
              { targetActivity: publicActivity(showNsfw) },
            ],
          },
        ],
      },
      { forumPost: publicForumPost(viewerId, reported) },
    ],
  };
}
