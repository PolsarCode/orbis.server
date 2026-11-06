import { Prisma } from '../../prisma/generated/client';
import { PrismaService } from '../prisma.service';
import { notSuspended } from '../users/suspension';
import {
  blockedWith,
  notBlockedBy,
  notBlockedWith,
  notMutedBy,
} from '../safety/blocks';
import {
  compilePhrases,
  filteredPhrase,
  PhraseMatcher,
} from '../safety/keywords';
import { isSiteAdmin } from '../users/head-admin';
import { allManagedCommunities } from '../communities/managed-communities';

export type ReportedIds = {
  post: number[];
  comment: number[];
  forum_post: number[];
};

export type HiddenBecause =
  | { kind: 'muted' }
  | { kind: 'blocked' }
  | { kind: 'filtered'; phrase: string };

export type ContentViewer = {
  id: number;
  reported: ReportedIds;
  siteAdmin: boolean;
  manages: number[];
};

export type ViewerContext = ContentViewer & {
  blocked: Set<number>;
  muted: Set<number>;
  phrases: PhraseMatcher[];
};

export async function reportedBy(
  prisma: PrismaService,
  viewerId: number,
): Promise<ReportedIds> {
  const reports = await prisma.contentReport.findMany({
    where: {
      reporterId: viewerId,
      resolvedAt: null,
      targetType: { in: ['post', 'comment', 'forum_post'] },
    },
    select: { targetType: true, targetId: true },
  });
  const ids: ReportedIds = { post: [], comment: [], forum_post: [] };
  for (const { targetType, targetId } of reports) {
    if (targetType in ids) ids[targetType as keyof ReportedIds].push(targetId);
  }
  return ids;
}

export async function contentViewer(
  prisma: PrismaService,
  viewerId: number,
): Promise<ContentViewer> {
  const [reported, siteAdmin, manages] = await Promise.all([
    reportedBy(prisma, viewerId),
    isSiteAdmin(prisma, viewerId),
    allManagedCommunities(prisma, viewerId),
  ]);
  return { id: viewerId, reported, siteAdmin, manages };
}

export async function strictViewer(
  prisma: PrismaService,
  viewerId: number,
): Promise<ContentViewer> {
  return {
    id: viewerId,
    reported: await reportedBy(prisma, viewerId),
    siteAdmin: false,
    manages: [],
  };
}

export async function viewerContext(
  prisma: PrismaService,
  viewerId: number,
): Promise<ViewerContext> {
  const [viewer, blocked, mutes, filters] = await Promise.all([
    contentViewer(prisma, viewerId),
    blockedWith(prisma, viewerId),
    prisma.mute.findMany({
      where: { muterId: viewerId },
      select: { mutedId: true },
    }),
    prisma.keywordFilter.findMany({
      where: {
        userId: viewerId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { phrase: true },
    }),
  ]);
  return {
    ...viewer,
    blocked,
    muted: new Set(mutes.map(({ mutedId }) => mutedId)),
    phrases: compilePhrases(filters.map(({ phrase }) => phrase)),
  };
}

export function hiddenFor(
  viewer: ViewerContext,
  authorId: number,
  html: string,
  notes: (string | null | undefined)[],
  { muted = true } = {},
): HiddenBecause | null {
  if (authorId === viewer.id) return null;
  if (muted && viewer.muted.has(authorId)) return { kind: 'muted' };
  const phrase = filteredPhrase(viewer.phrases, html, ...notes);
  return phrase === null ? null : { kind: 'filtered', phrase };
}

export function unblockedPeople(viewer: ContentViewer) {
  return viewer.siteAdmin ? notBlockedBy(viewer.id) : notBlockedWith(viewer.id);
}

export function unblockedFor(viewer: ContentViewer) {
  return {
    OR: [
      { author: unblockedPeople(viewer) },
      { authorId: viewer.id },
      ...(viewer.manages.length > 0
        ? [
            {
              communityId: { in: viewer.manages },
              author: notBlockedBy(viewer.id),
            },
          ]
        : []),
    ],
  } satisfies Prisma.PostWhereInput &
    Prisma.CommentWhereInput &
    Prisma.ForumPostWhereInput;
}

export function blockExempt(viewer: ContentViewer, communityId: number | null) {
  return (
    viewer.siteAdmin ||
    (communityId !== null && viewer.manages.includes(communityId))
  );
}

export function visibleTo(viewer: ContentViewer, kind: keyof ReportedIds) {
  const reported = viewer.reported[kind];
  return {
    AND: [
      { OR: [{ hiddenAt: null }, { authorId: viewer.id }] },
      { OR: [{ author: notSuspended() }, { authorId: viewer.id }] },
      unblockedFor(viewer),
      ...(reported.length > 0 ? [{ id: { notIn: reported } }] : []),
    ],
  } satisfies Prisma.PostWhereInput &
    Prisma.CommentWhereInput &
    Prisma.ForumPostWhereInput;
}

export function unmutedFor(viewerId: number) {
  return {
    author: notMutedBy(viewerId),
  } satisfies Prisma.PostWhereInput &
    Prisma.CommentWhereInput &
    Prisma.ForumPostWhereInput;
}

export function visibleActivityAuthor(
  viewerId: number,
  { muted = false } = {},
) {
  return {
    ...notBlockedWith(viewerId),
    ...(muted && notMutedBy(viewerId)),
  } satisfies Prisma.UserWhereInput;
}
