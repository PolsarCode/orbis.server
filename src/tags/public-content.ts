import { Prisma } from '../../prisma/generated/client';
import { visibleThreads } from '../forum/forum-helpers';
import {
  ContentViewer,
  unblockedPeople,
  visibleActivityAuthor,
  visibleTo,
} from '../moderation/visibility';
import { nsfwEntries } from '../users/nsfw';
import { notSuspended } from '../users/suspension';

export function visibleThreadAndWall(
  viewer: ContentViewer,
): Prisma.PostWhereInput[] {
  return [
    { OR: [{ forumThreadId: null }, { forumThread: visibleThreads(viewer) }] },
    { OR: [{ wallUserId: null }, { wallUser: unblockedPeople(viewer) }] },
  ];
}

export function publicPosts(
  viewer: ContentViewer,
  showNsfw: boolean,
): Prisma.PostWhereInput {
  return {
    AND: [
      {
        OR: [
          { community: { isPublic: true } },
          { wallUser: { isPublic: true } },
          { mediaType: { not: null } },
        ],
      },
      ...(showNsfw ? [] : [{ isAdult: false }]),
      ...visibleThreadAndWall(viewer),
    ],
  };
}

export function publicPost(
  viewer: ContentViewer,
  showNsfw: boolean,
): Prisma.PostWhereInput {
  return {
    AND: [publicPosts(viewer, showNsfw), visibleTo(viewer, 'post')],
  };
}

export function publicActivity(
  viewerId: number,
  showNsfw: boolean,
): Prisma.LibraryActivityWhereInput {
  return {
    entry: {
      isPublic: true,
      ...nsfwEntries(showNsfw),
      user: {
        isPublic: true,
        ...notSuspended(),
        ...visibleActivityAuthor(viewerId),
      },
    },
  };
}

function publicForumPost(viewer: ContentViewer): Prisma.ForumPostWhereInput {
  return {
    AND: [
      { community: { isPublic: true } },
      { thread: visibleThreads(viewer) },
      { OR: [{ opening: false }, { thread: { feedPost: { is: null } } }] },
      visibleTo(viewer, 'forum_post'),
    ],
  };
}

export function publicUsages(
  viewer: ContentViewer,
  showNsfw: boolean,
): Prisma.HashtagUsageWhereInput {
  return {
    OR: [
      { post: publicPost(viewer, showNsfw) },
      {
        AND: [
          { comment: { deletedAt: null, ...visibleTo(viewer, 'comment') } },
          {
            OR: [
              { targetPost: publicPost(viewer, showNsfw) },
              { targetActivity: publicActivity(viewer.id, showNsfw) },
            ],
          },
        ],
      },
      { forumPost: publicForumPost(viewer) },
    ],
  };
}
