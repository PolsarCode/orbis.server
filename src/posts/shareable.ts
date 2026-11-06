import { NotFoundException } from '@nestjs/common';
import { Prisma } from '../../prisma/generated/client';
import { PrismaService } from '../prisma.service';
import { GUEST_USER_ID } from '../auth/allow-guest';
import { ContentViewer } from '../moderation/visibility';
import { notBlockedWith, notMutedBy } from '../safety/blocks';
import { publicActivity, publicPost } from '../tags/public-content';
import { notSuspended } from '../users/suspension';
import { viewableProfiles } from './wall-access';

export type ShareType = 'post' | 'activity';

export type ShareTarget = { type: ShareType; id: number };

export function shareType(raw: string): ShareType {
  if (raw !== 'post' && raw !== 'activity') {
    throw new NotFoundException('Not found');
  }
  return raw;
}

function strict(viewer: ContentViewer): ContentViewer {
  return { ...viewer, siteAdmin: false, manages: [] };
}

export function shareablePosts(
  viewer: ContentViewer,
  showNsfw: boolean,
): Prisma.PostWhereInput {
  return {
    AND: [
      publicPost(strict(viewer), showNsfw),
      { hiddenAt: null, author: notSuspended() },
    ],
  };
}

export function shareableActivities(
  viewer: ContentViewer,
  showNsfw: boolean,
): Prisma.LibraryActivityWhereInput {
  return publicActivity(viewer.id, showNsfw);
}

export async function shareableIds(
  prisma: PrismaService,
  viewer: ContentViewer,
  showNsfw: boolean,
  type: ShareType,
  ids: number[],
): Promise<Set<number>> {
  if (ids.length === 0 || viewer.id === GUEST_USER_ID) return new Set();
  const rows =
    type === 'post'
      ? await prisma.post.findMany({
          where: {
            AND: [{ id: { in: ids } }, shareablePosts(viewer, showNsfw)],
          },
          select: { id: true },
        })
      : await prisma.libraryActivity.findMany({
          where: {
            AND: [{ id: { in: ids } }, shareableActivities(viewer, showNsfw)],
          },
          select: { id: true },
        });
  return new Set(rows.map(({ id }) => id));
}

export function visibleReposters(
  viewerId: number,
  { muted = false } = {},
): Prisma.RepostWhereInput {
  return {
    user: {
      ...notSuspended(),
      ...notBlockedWith(viewerId),
      ...(muted && notMutedBy(viewerId)),
    },
  };
}

export function visibleReposts(viewerId: number): Prisma.RepostWhereInput {
  return {
    AND: [
      visibleReposters(viewerId),
      {
        OR: [
          { communityId: null, user: viewableProfiles(viewerId) },
          {
            community: {
              OR: [
                { isPublic: true },
                { memberships: { some: { userId: viewerId } } },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function availableOriginals(
  viewer: ContentViewer,
  showNsfw: boolean,
  { muted = false, excluded = new Set<string>() } = {},
): Prisma.RepostWhereInput {
  const unmuted = muted ? notMutedBy(viewer.id) : {};
  return {
    OR: [
      ...(excluded.has('post')
        ? []
        : [
            {
              post: {
                AND: [publicPost(viewer, showNsfw), { author: unmuted }],
              },
            },
          ]),
      ...(excluded.has('activity')
        ? []
        : [
            {
              activity: {
                AND: [
                  publicActivity(viewer.id, showNsfw),
                  { entry: { user: unmuted } },
                ],
              },
            },
          ]),
    ],
  };
}
