import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { requireUserNamed } from '../users/user-lookup';
import { MAX_INT } from '../communities/community-member.guard';
import { visibleCommunity } from '../communities/require-membership';
import { PrismaService } from '../prisma.service';
import {
  BookmarkableType,
  LibraryStatus,
  MediaType,
  Prisma,
} from '../../prisma/generated/client';
import { Author, author, communitySummary } from '../common/author';
import {
  createdBefore,
  cursorPage,
  PAGE_SIZE,
  Page,
  parseTimeCursor,
  TimeCursor,
} from '../common/pagination';
import { searchContains } from '../common/search';
import { sanitizeRichText } from '../common/rich-text';
import {
  linkedMentions,
  notifyMentions,
  resolveMentions,
  unlinkMentions,
} from '../common/mentions';
import {
  addHashtags,
  ParsedHashtag,
  replaceHashtags,
  resolveHashtags,
  unlinkHashtags,
} from '../common/hashtags';
import { CreatePostDto } from './dto/create-post.dto';
import { BookmarkDto } from './dto/bookmark.dto';
import { NotificationsService } from '../notifications/notifications.service';
import {
  canViewProfile,
  friendsOf,
  requireWallAccess,
  viewableProfiles,
} from './wall-access';
import { LikesService } from '../likes/likes.service';
import { coverUrl, getMedia } from '../library/library-api';
import {
  HiddenBecause,
  hiddenFor,
  ContentViewer,
  contentViewer,
  strictViewer,
  unmutedFor,
  viewerContext,
  visibleActivityAuthor,
  visibleTo,
  ViewerContext,
} from '../moderation/visibility';
import { blockedPairs, blockState, notBlockedWith } from '../safety/blocks';
import { loadNicknames } from '../communities/nicknames';
import { nsfwEntries, showsNsfw } from '../users/nsfw';
import { loadSteamLinks, SteamLink } from '../steam/steam-links';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';
import { managedCommunities } from '../communities/managed-communities';
import { discussionCleanup } from '../comments/discussion-cleanup';
import { containsLink, requireEstablishedAccount } from '../common/new-account';
import { spoilerOf } from '../common/spoiler';
import {
  editableSelect,
  EditHistory,
  editHistory,
  editHistorySelect,
  recordEdit,
  requireLatest,
} from '../common/edit-history';
import { notDeleting, notSuspended } from '../users/suspension';
import { pinLimit, pinLimitMessage } from './pins';
import {
  AuthorModeration,
  authorModeration,
} from '../communities/member-moderation';
import {
  publicActivity,
  publicPost,
  publicPosts,
  visibleThreadAndWall,
} from '../tags/public-content';
import {
  availableOriginals,
  shareableIds,
  ShareTarget,
  ShareType,
  visibleReposters,
  visibleReposts,
} from './shareable';

const postInclude = {
  author,
  community: communitySummary,
  wallUser: author,
  forumThread: { select: { id: true, title: true, replyCount: true } },
} as const;

const previewSelect = {
  id: true,
  content: true,
  linkUrl: true,
  spoiler: true,
  createdAt: true,
  author,
} as const;

const quotedSelect = {
  id: true,
  content: true,
  linkUrl: true,
  spoiler: true,
  createdAt: true,
  communityId: true,
  mediaType: true,
  mediaSourceId: true,
  author,
  community: communitySummary,
  wallUser: author,
} as const;

const PREVIEW_COMMENTS = 3;

const REPOST_BATCH = PAGE_SIZE * 3;

const REPOSTED_BY = 3;

function postBody({ content, linkUrl, spoiler }: CreatePostDto) {
  const { html, empty } = sanitizeRichText(content);
  if (empty && !linkUrl) throw new BadRequestException('Post cannot be empty');
  return {
    content: empty ? '' : html,
    linkUrl: linkUrl ?? null,
    spoiler: spoilerOf(spoiler),
  };
}

export type PreviewComment = Prisma.CommentGetPayload<{
  select: typeof previewSelect;
}>;

type Engagement = {
  previewComments: (PreviewComment & { hiddenBecause: HiddenBecause | null })[];
  hiddenBecause: HiddenBecause | null;
};

type RawPost = Prisma.PostGetPayload<{
  include: typeof postInclude;
}> & { type: 'post' };

export type RepostedBy = { people: Author[]; total: number };

type ShareState = {
  repostCount: number;
  reposted: boolean;
  canRepost: boolean;
  canQuote: boolean;
};

type ShareFields = ShareState & { repostedBy: RepostedBy | null };

export type RepostResult = { reposted: boolean; repostCount: number };

export type Reposter = Author & { repostedAt: Date };

type QuotedPost = Pick<
  RawPost,
  | 'id'
  | 'content'
  | 'linkUrl'
  | 'spoiler'
  | 'createdAt'
  | 'author'
  | 'community'
  | 'wallUser'
> & {
  hiddenBecause: HiddenBecause | null;
  media: { type: MediaType; sourceId: string; title: string | null } | null;
};

export type PostItem = RawPost &
  Engagement &
  ShareFields & {
    liked: boolean;
    bookmarked: boolean;
    canDelete: boolean;
    quote: QuotedItem | null;
    pinned?: boolean;
    canPin?: boolean;
    moderation?: AuthorModeration | null;
  };

const activityInclude = {
  entry: {
    select: {
      mediaType: true,
      sourceId: true,
      title: true,
      coverImage: true,
      isAdult: true,
      year: true,
      steamAppId: true,
      user: author,
    },
  },
} as const;

type RawActivity = {
  type: 'activity';
  id: number;
  createdAt: Date;
  commentCount: number;
  likeCount: number;
  author: Author;
  status: LibraryStatus;
  progress: { from: number; to: number } | null;
  steamAppId: string | null;
  media: {
    type: 'anime' | 'manga' | 'game';
    sourceId: string;
    title: string;
    coverImage: string | null;
    year: number | null;
  };
};

type QuotedActivity = RawActivity &
  Engagement & { liked: boolean; steam: SteamLink | null };

export type QuotedItem =
  | { available: true; type: 'post'; post: QuotedPost }
  | { available: true; type: 'activity'; activity: QuotedActivity }
  | { available: false };

export type ActivityItem = QuotedActivity & ShareFields;

export type FeedItem = PostItem | ActivityItem;

const RANK = { post: 0, repost: 1, activity: 2 } as const;

function excludedTypes(raw?: string) {
  if (!raw) return new Set<string>();
  return new Set(
    raw
      .split(',')
      .filter((type) => Object.prototype.hasOwnProperty.call(RANK, type)),
  );
}

type FeedCursor = { createdAt: Date; rank: number; id: number };

const newestFirst = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

const SEARCH_LIMIT = 8;

function inMyCommunities(userId: number) {
  return { community: { memberships: { some: { userId } } } };
}

function homeReposts(userId: number): Prisma.RepostWhereInput {
  return {
    OR: [
      inMyCommunities(userId),
      { communityId: null, userId },
      { communityId: null, user: friendsOf(userId) },
    ],
  };
}

function homePosts(viewer: ContentViewer, showNsfw: boolean) {
  const userId = viewer.id;
  return {
    OR: [
      inMyCommunities(userId),
      { wallUserId: userId },
      { authorId: userId, communityId: null, mediaType: null },
      { wallUser: friendsOf(userId) },
      {
        AND: [
          publicPosts(viewer, showNsfw),
          {
            hashtagUsages: {
              some: { hashtag: { follows: { some: { userId } } } },
            },
          },
        ],
      },
    ],
  };
}

function profilePosts(ownerId: number, viewerId: number) {
  return {
    OR: [
      { wallUserId: ownerId },
      { authorId: ownerId, communityId: null, mediaType: null },
      { authorId: ownerId, community: visibleCommunity(viewerId) },
    ],
  };
}

function profileReposts(
  ownerId: number,
  viewerId: number,
): Prisma.RepostWhereInput {
  return {
    userId: ownerId,
    OR: [{ communityId: null }, { community: visibleCommunity(viewerId) }],
  };
}

function communityActivities(
  communityId: number,
  viewerId: number,
  showNsfw: boolean,
  { muted = false } = {},
): Prisma.LibraryEntryWhereInput {
  return {
    isPublic: true,
    ...nsfwEntries(showNsfw),
    user: {
      ...notSuspended(),
      ...visibleActivityAuthor(viewerId, { muted }),
      memberships: { some: { communityId, showLibraryUpdates: true } },
    },
  };
}

function profileActivities(
  ownerId: number,
  showNsfw: boolean,
): Prisma.LibraryEntryWhereInput {
  return {
    userId: ownerId,
    isPublic: true,
    ...nsfwEntries(showNsfw),
    user: notSuspended(),
  };
}

export function viewablePosts(viewer: ContentViewer): Prisma.PostWhereInput {
  const viewerId = viewer.id;
  return {
    AND: [
      {
        OR: [
          { community: visibleCommunity(viewerId) },
          { wallUser: viewableProfiles(viewerId) },
          {
            communityId: null,
            mediaType: null,
            author: viewableProfiles(viewerId),
          },
          { mediaType: { not: null } },
        ],
      },
      visibleTo(viewer, 'post'),
    ],
  };
}

export function viewablePost(
  viewer: ContentViewer,
  showNsfw: boolean,
): Prisma.PostWhereInput {
  return {
    AND: [
      viewablePosts(viewer),
      nsfwEntries(showNsfw),
      ...visibleThreadAndWall(viewer),
    ],
  };
}

export function viewableActivity(
  viewer: ContentViewer,
  showNsfw: boolean,
): Prisma.LibraryActivityWhereInput {
  return {
    entry: {
      OR: [{ isPublic: true }, { userId: viewer.id }],
      ...nsfwEntries(showNsfw),
      user: {
        AND: [
          notSuspended(),
          visibleActivityAuthor(viewer.id),
          viewableProfiles(viewer.id),
        ],
      },
    },
  };
}

export type BookmarkResult = { bookmarked: boolean };

const BOOKMARK_SEARCH_BATCH = 100;

function postLink(
  id: number,
  post: {
    communityId: number | null;
    mediaType: MediaType | null;
    mediaSourceId: string | null;
    wallUser: { username: string } | null;
  },
) {
  return post.mediaType
    ? `/library/${post.mediaType}/${post.mediaSourceId}?post=${id}`
    : post.wallUser
      ? `/users/${post.wallUser.username}?post=${id}`
      : `/communities/${post.communityId}?post=${id}`;
}

function savedBefore(cursor?: TimeCursor) {
  if (!cursor) return {};
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, bookmarkableId: { lt: cursor.id } },
    ],
  };
}

function parseFeedCursor(raw?: string): FeedCursor | undefined {
  if (raw === undefined) return undefined;

  const match = /^(\d{1,15})_([012])_(\d{1,10})$/.exec(raw);
  const id = Number(match?.[3]);
  if (!match || id < 1 || id > MAX_INT) {
    throw new BadRequestException('Invalid cursor');
  }

  return {
    createdAt: new Date(Number(match[1])),
    rank: Number(match[2]),
    id,
  };
}

function olderThan(cursor: FeedCursor | undefined, rank: number) {
  if (!cursor) return {};
  if (rank < cursor.rank) return { createdAt: { lte: cursor.createdAt } };
  if (rank > cursor.rank) return { createdAt: { lt: cursor.createdAt } };
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

type Sortable = { createdAt: Date; type: keyof typeof RANK; id: number };

function compareFeedItems(a: Sortable, b: Sortable) {
  return (
    b.createdAt.getTime() - a.createdAt.getTime() ||
    RANK[b.type] - RANK[a.type] ||
    b.id - a.id
  );
}

function toActivity(
  activity: Prisma.LibraryActivityGetPayload<{
    include: typeof activityInclude;
  }>,
): RawActivity {
  const { entry } = activity;
  return {
    type: 'activity',
    id: activity.id,
    createdAt: activity.createdAt,
    commentCount: activity.commentCount,
    likeCount: activity.likeCount,
    author: entry.user,
    status: activity.status,
    progress:
      activity.progressTo === null
        ? null
        : { from: activity.progressFrom!, to: activity.progressTo },
    steamAppId: entry.steamAppId,
    media: {
      type: entry.mediaType,
      sourceId: entry.sourceId,
      title: entry.title,
      coverImage: coverUrl(entry),
      year: entry.year,
    },
  };
}

function asPost<T>(post: T) {
  return { ...post, type: 'post' as const };
}

function matching(rawQuery: string) {
  const contains = searchContains(rawQuery);
  return contains && { OR: [{ content: contains }, { spoiler: contains }] };
}

type RepostEntry = {
  type: 'repost';
  id: number;
  createdAt: Date;
  target: ShareTarget;
};

type FeedRow = RawPost | RawActivity | RepostEntry;

type Stream = { rows: FeedRow[]; full: boolean };

const noStream: Stream = { rows: [], full: false };

function streamOf(rows: FeedRow[], take = PAGE_SIZE + 1): Stream {
  return { rows, full: rows.length >= take };
}

function keyOf({ type, id }: { type: ShareType; id: number }) {
  return `${type}:${id}`;
}

function repostOf({ type, id }: ShareTarget) {
  return type === 'post' ? { postId: id } : { activityId: id };
}

type OwnedTarget = ShareTarget & { ownerId: number };

function unblockedQuotes({
  type,
  id,
  ownerId,
}: OwnedTarget): Prisma.PostWhereInput {
  return {
    ...(type === 'post' ? { quotePostId: id } : { quoteActivityId: id }),
    author: notBlockedWith(ownerId),
  };
}

function rowKey(postId: number | null, activityId: number | null) {
  return postId !== null
    ? keyOf({ type: 'post', id: postId })
    : keyOf({ type: 'activity', id: activityId! });
}

function originalOf(row: FeedRow): ShareTarget {
  return row.type === 'repost' ? row.target : { type: row.type, id: row.id };
}

function feedPage(streams: Stream[], pinned: ShareTarget[] = []) {
  const merged = streams.flatMap(({ rows }) => rows).sort(compareFeedItems);
  const limits = streams.flatMap(({ rows, full }) =>
    full ? [rows[rows.length - 1]] : [],
  );
  const seen = new Set(pinned.map(keyOf));
  const cards: ShareTarget[] = [];
  let used = 0;
  for (const row of merged) {
    if (limits.some((limit) => compareFeedItems(row, limit) > 0)) break;
    const original = originalOf(row);
    const key = keyOf(original);
    if (!seen.has(key)) {
      if (cards.length === PAGE_SIZE) break;
      seen.add(key);
      cards.push(original);
    }
    used += 1;
  }
  const rows = merged.slice(0, used);
  const last = rows[rows.length - 1];
  const more = used < merged.length || limits.length > 0;
  return {
    cards,
    rows,
    nextCursor:
      more && last
        ? `${last.createdAt.getTime()}_${RANK[last.type]}_${last.id}`
        : null,
  };
}

function withPins(
  items: FeedItem[],
  pinnable: (post: PostItem) => boolean,
  canPin: boolean,
): FeedItem[] {
  return items.map((item) => {
    if (item.type !== 'post') return item;
    const here = pinnable(item);
    return {
      ...item,
      pinned: here && item.pinnedAt !== null,
      canPin: here && canPin,
    };
  });
}

function nextCursor<T extends Sortable>(merged: T[], page: T[]) {
  const last = page[page.length - 1];
  return merged.length > PAGE_SIZE
    ? `${last.createdAt.getTime()}_${RANK[last.type]}_${last.id}`
    : null;
}

@Injectable()
export class PostsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private likes: LikesService,
    private discordChannel: DiscordChannelService,
  ) {}

  private async withMentions(body: CreatePostDto, authorId: number) {
    const { content: written, linkUrl, spoiler } = postBody(body);
    const content = unlinkHashtags(written);
    if (containsLink(content, linkUrl)) {
      await requireEstablishedAccount(this.prisma, authorId, 'post links');
    }
    const { html, mentioned } = await resolveMentions(
      this.prisma,
      content,
      authorId,
    );
    const { html: linked, hashtags } = resolveHashtags(html);
    return { data: { content: linked, linkUrl, spoiler }, mentioned, hashtags };
  }

  private async engage(
    viewerId: number,
    items: (RawPost | RawActivity)[],
    { muted = true } = {},
  ): Promise<FeedItem[]> {
    const idsOf = (type: 'post' | 'activity') =>
      items.flatMap((item) => (item.type === type ? [item.id] : []));
    const [viewer, showNsfw] = await Promise.all([
      viewerContext(this.prisma, viewerId),
      showsNsfw(this.prisma, viewerId),
    ]);
    const [
      likedPosts,
      likedActivities,
      bookmarkedPosts,
      previews,
      shareOf,
      quoteOf,
    ] = await Promise.all([
      this.likes.likedBy(viewerId, 'post', idsOf('post')),
      this.likes.likedBy(viewerId, 'activity', idsOf('activity')),
      this.bookmarkedBy(viewerId, 'post', idsOf('post')),
      Promise.all(
        items.map((item) =>
          item.commentCount === 0
            ? []
            : this.prisma.comment
                .findMany({
                  where: {
                    commentableType: item.type,
                    commentableId: item.id,
                    parentId: null,
                    deletedAt: null,
                    ...visibleTo(viewer, 'comment'),
                  },
                  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                  take: PREVIEW_COMMENTS,
                  select: previewSelect,
                })
                .then((comments) => comments.reverse()),
        ),
      ),
      this.shareState(viewer, showNsfw, items),
      this.quotesOf(
        viewer,
        showNsfw,
        items.flatMap((item) => (item.type === 'post' ? [item] : [])),
        { muted },
      ),
    ]);

    const communityOf = (item: (typeof items)[number]) =>
      item.type === 'activity' ? null : item.communityId;
    const withNickname = await loadNicknames(
      this.prisma,
      items.flatMap((item, index) =>
        [item.author, ...previews[index].map((comment) => comment.author)].map(
          ({ id }) => ({ communityId: communityOf(item), userId: id }),
        ),
      ),
    );

    const managed = await managedCommunities(
      this.prisma,
      viewerId,
      items.map(communityOf),
    );
    const moderationOf = await authorModeration(
      this.prisma,
      viewerId,
      items.flatMap((item) =>
        item.type === 'post' &&
        item.communityId !== null &&
        managed.has(item.communityId)
          ? [{ communityId: item.communityId, authorId: item.author.id }]
          : [],
      ),
    );

    const steamOf = await loadSteamLinks(
      this.prisma,
      items.flatMap((item) =>
        item.type === 'activity'
          ? [{ userId: item.author.id, appId: item.steamAppId }]
          : [],
      ),
    );

    return items.map((item, index) => {
      const communityId = communityOf(item);
      const author = withNickname(communityId, item.author);
      const previewComments = previews[index].map((comment) => ({
        ...comment,
        author: withNickname(communityId, comment.author),
        hiddenBecause: hiddenFor(viewer, comment.author.id, comment.content, [
          comment.spoiler,
        ]),
      }));
      const liked = (item.type === 'post' ? likedPosts : likedActivities).has(
        item.id,
      );
      if (item.type === 'activity') {
        const steam = steamOf(item.author.id, item.steamAppId);
        const hiddenBecause = hiddenFor(
          viewer,
          item.author.id,
          '',
          [item.media.title],
          { muted },
        );
        return {
          ...item,
          author,
          liked,
          previewComments,
          steam,
          hiddenBecause,
          ...shareOf(item),
          repostedBy: null,
        };
      }
      const canDelete =
        item.author.id === viewerId ||
        item.wallUserId === viewerId ||
        (item.communityId !== null && managed.has(item.communityId));
      const moderation =
        item.communityId === null
          ? null
          : moderationOf(item.communityId, item.author.id);
      return {
        ...item,
        author,
        liked,
        bookmarked: bookmarkedPosts.has(item.id),
        previewComments,
        canDelete,
        moderation,
        hiddenBecause: hiddenFor(
          viewer,
          item.author.id,
          item.content,
          [item.spoiler],
          { muted },
        ),
        ...shareOf(item),
        repostedBy: null,
        quote: quoteOf(item),
      };
    });
  }

  private async repostCounts(viewer: ContentViewer, targets: OwnedTarget[]) {
    const counts = new Map<
      string,
      Omit<ShareState, 'canRepost' | 'canQuote'>
    >();
    if (targets.length === 0) return counts;
    const idsOf = (type: ShareType) =>
      targets.flatMap((target) => (target.type === type ? [target.id] : []));
    const ofTargets = {
      OR: [
        { postId: { in: idsOf('post') } },
        { activityId: { in: idsOf('activity') } },
      ],
    };
    const [reposts, quotes, mine] = await Promise.all([
      this.prisma.repost.groupBy({
        by: ['postId', 'activityId'],
        where: { AND: [ofTargets, visibleReposts(viewer.id)] },
        _count: { _all: true },
      }),
      this.prisma.post.groupBy({
        by: ['quotePostId', 'quoteActivityId'],
        where: {
          AND: [{ OR: targets.map(unblockedQuotes) }, viewablePosts(viewer)],
        },
        _count: { _all: true },
      }),
      this.prisma.repost.findMany({
        where: { AND: [ofTargets, { userId: viewer.id }] },
        select: { postId: true, activityId: true },
      }),
    ]);
    const entry = (postId: number | null, activityId: number | null) => {
      const key = rowKey(postId, activityId);
      const found = counts.get(key) ?? { repostCount: 0, reposted: false };
      counts.set(key, found);
      return found;
    };
    for (const { postId, activityId, _count } of reposts) {
      entry(postId, activityId).repostCount += _count._all;
    }
    for (const { quotePostId, quoteActivityId, _count } of quotes) {
      entry(quotePostId, quoteActivityId).repostCount += _count._all;
    }
    for (const { postId, activityId } of mine) {
      entry(postId, activityId).reposted = true;
    }
    return counts;
  }

  private async shareState(
    viewer: ContentViewer,
    showNsfw: boolean,
    items: { type: ShareType; id: number; author: { id: number } }[],
  ) {
    const idsOf = (type: ShareType) =>
      items.flatMap((item) => (item.type === type ? [item.id] : []));
    const [counts, posts, activities] = await Promise.all([
      this.repostCounts(
        viewer,
        items.map(({ type, id, author }) => ({ type, id, ownerId: author.id })),
      ),
      shareableIds(this.prisma, viewer, showNsfw, 'post', idsOf('post')),
      shareableIds(
        this.prisma,
        viewer,
        showNsfw,
        'activity',
        idsOf('activity'),
      ),
    ]);
    return (item: {
      type: ShareType;
      id: number;
      author: { id: number };
    }): ShareState => {
      const canQuote = (item.type === 'post' ? posts : activities).has(item.id);
      return {
        repostCount: 0,
        reposted: false,
        ...counts.get(keyOf(item)),
        canRepost: canQuote && item.author.id !== viewer.id,
        canQuote,
      };
    };
  }

  private async mediaTitles(
    posts: { mediaType: MediaType | null; mediaSourceId: string | null }[],
  ) {
    const pages = posts.flatMap(({ mediaType, mediaSourceId }) =>
      mediaType === null || mediaSourceId === null
        ? []
        : [{ mediaType, sourceId: mediaSourceId }],
    );
    if (pages.length === 0) return new Map<string, string>();
    const entries = await this.prisma.libraryEntry.findMany({
      where: { OR: pages },
      distinct: ['mediaType', 'sourceId'],
      select: { mediaType: true, sourceId: true, title: true },
    });
    return new Map(
      entries.map(({ mediaType, sourceId, title }) => [
        `${mediaType}:${sourceId}`,
        title,
      ]),
    );
  }

  private async quotesOf(
    viewer: ViewerContext,
    showNsfw: boolean,
    posts: Pick<
      RawPost,
      'authorId' | 'isQuote' | 'quotePostId' | 'quoteActivityId'
    >[],
    { muted = true } = {},
  ) {
    const idsOf = (key: 'quotePostId' | 'quoteActivityId') => [
      ...new Set(
        posts.flatMap((post) =>
          post.isQuote && post[key] !== null ? [post[key]] : [],
        ),
      ),
    ];
    const postIds = idsOf('quotePostId');
    const activityIds = idsOf('quoteActivityId');
    if (postIds.length === 0 && activityIds.length === 0) {
      return ({ isQuote }: Pick<RawPost, 'isQuote'>): QuotedItem | null =>
        isQuote ? { available: false } : null;
    }
    const [quotedPosts, quotedActivities] = await Promise.all([
      postIds.length === 0
        ? []
        : this.prisma.post.findMany({
            where: {
              AND: [{ id: { in: postIds } }, publicPost(viewer, showNsfw)],
            },
            select: quotedSelect,
          }),
      activityIds.length === 0
        ? []
        : this.prisma.libraryActivity.findMany({
            where: {
              AND: [
                { id: { in: activityIds } },
                publicActivity(viewer.id, showNsfw),
              ],
            },
            include: activityInclude,
          }),
    ]);
    const activities = quotedActivities.map(toActivity);
    const [withNickname, titles, liked, steamOf, blocked] = await Promise.all([
      loadNicknames(
        this.prisma,
        quotedPosts.map((post) => ({
          communityId: post.communityId,
          userId: post.author.id,
        })),
      ),
      this.mediaTitles(quotedPosts),
      this.likes.likedBy(
        viewer.id,
        'activity',
        activities.map(({ id }) => id),
      ),
      loadSteamLinks(
        this.prisma,
        activities.map((activity) => ({
          userId: activity.author.id,
          appId: activity.steamAppId,
        })),
      ),
      blockedPairs(
        this.prisma,
        posts.map(({ authorId }) => authorId),
        [...quotedPosts, ...activities].map(({ author }) => author.id),
      ),
    ]);

    const postById = new Map(
      quotedPosts.map((post): [number, QuotedPost] => [
        post.id,
        {
          id: post.id,
          content: post.content,
          linkUrl: post.linkUrl,
          spoiler: post.spoiler,
          createdAt: post.createdAt,
          author: withNickname(post.communityId, post.author),
          community: post.community,
          wallUser: post.wallUser,
          hiddenBecause: hiddenFor(
            viewer,
            post.author.id,
            post.content,
            [post.spoiler],
            { muted },
          ),
          media:
            post.mediaType === null || post.mediaSourceId === null
              ? null
              : {
                  type: post.mediaType,
                  sourceId: post.mediaSourceId,
                  title:
                    titles.get(`${post.mediaType}:${post.mediaSourceId}`) ??
                    null,
                },
        },
      ]),
    );
    const activityById = new Map(
      activities.map((activity): [number, QuotedActivity] => [
        activity.id,
        {
          ...activity,
          liked: liked.has(activity.id),
          previewComments: [],
          steam: steamOf(activity.author.id, activity.steamAppId),
          hiddenBecause: hiddenFor(
            viewer,
            activity.author.id,
            '',
            [activity.media.title],
            { muted },
          ),
        },
      ]),
    );

    return ({
      authorId,
      isQuote,
      quotePostId,
      quoteActivityId,
    }: Pick<
      RawPost,
      'authorId' | 'isQuote' | 'quotePostId' | 'quoteActivityId'
    >): QuotedItem | null => {
      if (!isQuote) return null;
      const post = quotePostId === null ? undefined : postById.get(quotePostId);
      if (post && !blocked(authorId, post.author.id)) {
        return { available: true, type: 'post', post };
      }
      const activity =
        quoteActivityId === null
          ? undefined
          : activityById.get(quoteActivityId);
      if (activity && !blocked(authorId, activity.author.id)) {
        return { available: true, type: 'activity', activity };
      }
      return { available: false };
    };
  }

  private async newPostItem(
    authorId: number,
    post: Omit<RawPost, 'type'>,
  ): Promise<PostItem> {
    const [viewer, showNsfw] = await Promise.all([
      viewerContext(this.prisma, authorId),
      showsNsfw(this.prisma, authorId),
    ]);
    const [shareable, quoteOf] = await Promise.all([
      shareableIds(this.prisma, viewer, showNsfw, 'post', [post.id]),
      this.quotesOf(viewer, showNsfw, [post]),
    ]);
    return {
      ...post,
      type: 'post',
      liked: false,
      bookmarked: false,
      previewComments: [],
      hiddenBecause: null,
      canDelete: true,
      repostCount: 0,
      reposted: false,
      canRepost: false,
      canQuote: shareable.has(post.id),
      repostedBy: null,
      quote: quoteOf(post),
    };
  }

  private async repostedBy(
    viewerId: number,
    list: Prisma.RepostWhereInput,
    muted: boolean,
    items: ShareTarget[],
  ) {
    const result = new Map<string, RepostedBy>();
    if (items.length === 0) return result;
    const idsOf = (type: ShareType) =>
      items.flatMap((item) => (item.type === type ? [item.id] : []));
    const where = { AND: [list, visibleReposters(viewerId, { muted })] };
    const totals = await this.prisma.repost.groupBy({
      by: ['postId', 'activityId'],
      where: {
        AND: [
          where,
          {
            OR: [
              { postId: { in: idsOf('post') } },
              { activityId: { in: idsOf('activity') } },
            ],
          },
        ],
      },
      _count: { _all: true },
    });
    const people = await Promise.all(
      totals.map(({ postId, activityId }) =>
        this.prisma.repost.findMany({
          where: { AND: [where, { postId, activityId }] },
          orderBy: newestFirst,
          take: REPOSTED_BY,
          select: { user: author },
        }),
      ),
    );
    totals.forEach(({ postId, activityId, _count }, index) => {
      result.set(rowKey(postId, activityId), {
        people: people[index].map(({ user }) => user),
        total: _count._all,
      });
    });
    return result;
  }

  private async repostStream(
    viewer: ContentViewer,
    showNsfw: boolean,
    {
      list,
      cursor,
      excluded,
      muted,
    }: {
      list: Prisma.RepostWhereInput;
      cursor?: FeedCursor;
      excluded: Set<string>;
      muted: boolean;
    },
  ): Promise<Stream> {
    if (
      excluded.has('repost') ||
      (excluded.has('post') && excluded.has('activity'))
    ) {
      return noStream;
    }
    const rows = await this.prisma.repost.findMany({
      where: {
        AND: [
          list,
          visibleReposters(viewer.id, { muted }),
          availableOriginals(viewer, showNsfw, { muted, excluded }),
          olderThan(cursor, RANK.repost),
        ],
      },
      orderBy: newestFirst,
      take: REPOST_BATCH,
      select: { id: true, createdAt: true, postId: true, activityId: true },
    });
    return streamOf(
      rows.map(({ id, createdAt, postId, activityId }) => ({
        type: 'repost' as const,
        id,
        createdAt,
        target:
          postId !== null
            ? { type: 'post' as const, id: postId }
            : { type: 'activity' as const, id: activityId! },
      })),
      REPOST_BATCH,
    );
  }

  private async listPage(
    viewerId: number,
    {
      streams,
      pinned = [],
      reposts,
      muted,
    }: {
      streams: Stream[];
      pinned?: RawPost[];
      reposts: Prisma.RepostWhereInput;
      muted: boolean;
    },
  ): Promise<Page<FeedItem>> {
    const { cards, rows, nextCursor } = feedPage(
      streams,
      pinned.map(originalOf),
    );
    const loaded = new Map<string, RawPost | RawActivity>();
    for (const row of rows) {
      if (row.type !== 'repost') loaded.set(keyOf(row), row);
    }
    const missing = (type: ShareType) =>
      cards.flatMap((card) =>
        card.type === type && !loaded.has(keyOf(card)) ? [card.id] : [],
      );
    const [posts, activities] = await Promise.all([
      missing('post').length === 0
        ? []
        : this.prisma.post.findMany({
            where: { id: { in: missing('post') } },
            include: postInclude,
          }),
      missing('activity').length === 0
        ? []
        : this.prisma.libraryActivity.findMany({
            where: { id: { in: missing('activity') } },
            include: activityInclude,
          }),
    ]);
    for (const post of posts) {
      loaded.set(keyOf({ type: 'post', id: post.id }), asPost(post));
    }
    for (const activity of activities) {
      loaded.set(
        keyOf({ type: 'activity', id: activity.id }),
        toActivity(activity),
      );
    }

    const page = [
      ...pinned,
      ...cards.flatMap((card) => {
        const raw = loaded.get(keyOf(card));
        return raw ? [raw] : [];
      }),
    ];
    const [items, repostedBy] = await Promise.all([
      this.engage(viewerId, page),
      this.repostedBy(viewerId, reposts, muted, page),
    ]);
    return {
      items: items.map((item) => ({
        ...item,
        repostedBy: repostedBy.get(keyOf(item)) ?? null,
      })),
      nextCursor,
    };
  }

  private async bookmarkedBy(
    userId: number,
    bookmarkableType: BookmarkableType,
    ids: number[],
  ): Promise<Set<number>> {
    if (ids.length === 0) return new Set();
    const bookmarks = await this.prisma.bookmark.findMany({
      where: { userId, bookmarkableType, bookmarkableId: { in: ids } },
      select: { bookmarkableId: true },
    });
    return new Set(bookmarks.map(({ bookmarkableId }) => bookmarkableId));
  }

  private async savedPosts(
    viewerId: number,
    {
      filter = {},
      limit,
      batch = limit,
      cursor,
    }: {
      filter?: Prisma.PostWhereInput;
      limit: number;
      batch?: number;
      cursor?: TimeCursor;
    },
  ) {
    const viewer = await contentViewer(this.prisma, viewerId);
    const saved: { savedAt: Date; post: RawPost }[] = [];
    let before = cursor;

    while (saved.length < limit) {
      const rows = await this.prisma.bookmark.findMany({
        where: {
          userId: viewerId,
          bookmarkableType: 'post',
          ...savedBefore(before),
        },
        orderBy: [{ createdAt: 'desc' }, { bookmarkableId: 'desc' }],
        take: batch,
        select: { bookmarkableId: true, createdAt: true },
      });
      if (rows.length === 0) break;

      const posts = await this.prisma.post.findMany({
        where: {
          AND: [
            { id: { in: rows.map(({ bookmarkableId }) => bookmarkableId) } },
            filter,
            viewablePosts(viewer),
          ],
        },
        include: postInclude,
      });
      const byId = new Map(posts.map((post) => [post.id, asPost(post)]));
      for (const { bookmarkableId, createdAt } of rows) {
        const post = byId.get(bookmarkableId);
        if (post) saved.push({ savedAt: createdAt, post });
      }

      if (rows.length < batch) break;
      const last = rows[rows.length - 1];
      before = { createdAt: last.createdAt, id: last.bookmarkableId };
    }

    return saved.slice(0, limit);
  }

  private async pinnedPosts(
    excluded: Set<string>,
    cursor: FeedCursor | undefined,
    where: Prisma.PostWhereInput,
  ) {
    if (cursor || excluded.has('post')) return [];
    const posts = await this.prisma.post.findMany({
      where,
      orderBy: { pinnedAt: 'desc' },
      include: postInclude,
    });
    return posts.map(asPost);
  }

  private async postStream(
    excluded: Set<string>,
    where: Prisma.PostWhereInput,
  ): Promise<Stream> {
    if (excluded.has('post')) return noStream;
    const posts = await this.prisma.post.findMany({
      where,
      orderBy: newestFirst,
      take: PAGE_SIZE + 1,
      include: postInclude,
    });
    return streamOf(posts.map(asPost));
  }

  private async activityStream(
    excluded: Set<string>,
    cursor: FeedCursor | undefined,
    entry: Prisma.LibraryEntryWhereInput,
  ): Promise<Stream> {
    if (excluded.has('activity')) return noStream;
    const activities = await this.prisma.libraryActivity.findMany({
      where: { entry, ...olderThan(cursor, RANK.activity) },
      orderBy: newestFirst,
      take: PAGE_SIZE + 1,
      include: activityInclude,
    });
    return streamOf(activities.map(toActivity));
  }

  private async onePost(viewerId: number, where: Prisma.PostWhereInput) {
    const post = await this.prisma.post.findFirst({
      where,
      include: postInclude,
    });
    if (!post) throw new NotFoundException('Post not found');

    const [item] = await this.engage(viewerId, [asPost(post)]);
    return item;
  }

  private async oneActivity(
    viewerId: number,
    where: Prisma.LibraryActivityWhereInput,
  ) {
    const activity = await this.prisma.libraryActivity.findFirst({
      where,
      include: activityInclude,
    });
    if (!activity) throw new NotFoundException('Library update not found');

    const [item] = await this.engage(viewerId, [toActivity(activity)]);
    return item;
  }

  private async searchPosts(viewerId: number, where: Prisma.PostWhereInput) {
    const posts = await this.prisma.post.findMany({
      where,
      orderBy: newestFirst,
      take: SEARCH_LIMIT,
      include: postInclude,
    });
    return this.engage(viewerId, posts.map(asPost), { muted: false });
  }

  async findByIds(viewerId: number, ids: number[]): Promise<PostItem[]> {
    if (ids.length === 0) return [];
    const posts = await this.prisma.post.findMany({
      where: { id: { in: ids } },
      include: postInclude,
    });
    const items = await this.engage(viewerId, posts.map(asPost));
    return items.flatMap((item) => (item.type === 'post' ? [item] : []));
  }

  async findBookmarks(
    viewerId: number,
    rawCursor?: string,
  ): Promise<Page<FeedItem>> {
    const cursor = parseTimeCursor(rawCursor);
    const saved = await this.savedPosts(viewerId, {
      limit: PAGE_SIZE + 1,
      cursor,
    });
    const page = saved.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];
    const items = await this.engage(
      viewerId,
      page.map(({ post }) => post),
    );

    return {
      items,
      nextCursor:
        saved.length > PAGE_SIZE
          ? `${last.savedAt.getTime()}_${last.post.id}`
          : null,
    };
  }

  async searchBookmarks(
    viewerId: number,
    rawQuery: string,
  ): Promise<FeedItem[]> {
    const filter = matching(rawQuery);
    if (!filter) return [];

    const saved = await this.savedPosts(viewerId, {
      filter,
      limit: SEARCH_LIMIT,
      batch: BOOKMARK_SEARCH_BATCH,
    });

    return this.engage(
      viewerId,
      saved.map(({ post }) => post),
      { muted: false },
    );
  }

  async setBookmark(
    userId: number,
    { type, id, bookmarked }: BookmarkDto,
  ): Promise<BookmarkResult> {
    const key = { userId, bookmarkableType: type, bookmarkableId: id };
    if (bookmarked) {
      const viewer = await contentViewer(this.prisma, userId);
      const post = await this.prisma.post.findFirst({
        where: { AND: [{ id }, viewablePosts(viewer)] },
        select: { id: true },
      });
      if (!post) throw new NotFoundException('Post not found');
      await this.prisma.bookmark.upsert({
        where: { userId_bookmarkableType_bookmarkableId: key },
        create: key,
        update: {},
      });
    } else {
      await this.prisma.bookmark.deleteMany({ where: key });
    }
    return { bookmarked };
  }

  async findForCommunity(
    viewerId: number,
    communityId: number,
    rawCursor?: string,
    exclude?: string,
  ): Promise<Page<FeedItem>> {
    const cursor = parseFeedCursor(rawCursor);
    const excluded = excludedTypes(exclude);
    const viewer = await contentViewer(this.prisma, viewerId);
    const showNsfw = await showsNsfw(this.prisma, viewerId);
    const reposts = { communityId };

    const [pinned, posts, activities, shared] = await Promise.all([
      this.pinnedPosts(excluded, cursor, {
        communityId,
        pinnedAt: { not: null },
        AND: [visibleTo(viewer, 'post'), unmutedFor(viewerId)],
      }),
      this.postStream(excluded, {
        communityId,
        pinnedAt: null,
        AND: [
          olderThan(cursor, RANK.post),
          visibleTo(viewer, 'post'),
          unmutedFor(viewerId),
        ],
      }),
      this.activityStream(
        excluded,
        cursor,
        communityActivities(communityId, viewerId, showNsfw, { muted: true }),
      ),
      this.repostStream(viewer, showNsfw, {
        list: reposts,
        cursor,
        excluded,
        muted: true,
      }),
    ]);

    const { items, nextCursor } = await this.listPage(viewerId, {
      streams: [posts, activities, shared],
      pinned,
      reposts,
      muted: true,
    });
    const canPin =
      (await managedCommunities(this.prisma, viewerId, [communityId])).size > 0;

    return {
      items: withPins(
        items,
        (post) => post.communityId === communityId,
        canPin,
      ),
      nextCursor,
    };
  }

  async findOneInCommunity(
    viewerId: number,
    communityId: number,
    postId: number,
  ): Promise<FeedItem> {
    if (postId < 1 || postId > MAX_INT) {
      throw new NotFoundException('Post not found');
    }
    const viewer = await contentViewer(this.prisma, viewerId);
    return this.onePost(viewerId, {
      id: postId,
      communityId,
      ...visibleTo(viewer, 'post'),
    });
  }

  async findActivityInCommunity(
    viewerId: number,
    communityId: number,
    activityId: number,
  ): Promise<FeedItem> {
    if (activityId < 1 || activityId > MAX_INT) {
      throw new NotFoundException('Library update not found');
    }
    const showNsfw = await showsNsfw(this.prisma, viewerId);
    return this.oneActivity(viewerId, {
      id: activityId,
      entry: communityActivities(communityId, viewerId, showNsfw),
    });
  }

  async searchCommunity(
    viewerId: number,
    communityId: number,
    rawQuery: string,
  ): Promise<FeedItem[]> {
    const filter = matching(rawQuery);
    if (!filter) return [];

    const viewer = await contentViewer(this.prisma, viewerId);
    return this.searchPosts(viewerId, {
      communityId,
      ...filter,
      ...visibleTo(viewer, 'post'),
    });
  }

  async searchFeed(viewerId: number, rawQuery: string): Promise<FeedItem[]> {
    const filter = matching(rawQuery);
    if (!filter) return [];

    const [viewer, showNsfw] = await Promise.all([
      contentViewer(this.prisma, viewerId),
      showsNsfw(this.prisma, viewerId),
    ]);
    return this.searchPosts(viewerId, {
      AND: [homePosts(viewer, showNsfw), filter, visibleTo(viewer, 'post')],
    });
  }

  async findForMember(
    userId: number,
    rawCursor?: string,
    exclude?: string,
  ): Promise<Page<FeedItem>> {
    const cursor = parseFeedCursor(rawCursor);
    const excluded = excludedTypes(exclude);
    const viewer = await contentViewer(this.prisma, userId);
    const showNsfw = await showsNsfw(this.prisma, userId);
    const reposts = homeReposts(userId);

    const streams = await Promise.all([
      this.postStream(excluded, {
        AND: [
          homePosts(viewer, showNsfw),
          olderThan(cursor, RANK.post),
          visibleTo(viewer, 'post'),
          unmutedFor(userId),
        ],
      }),
      this.activityStream(excluded, cursor, {
        isPublic: true,
        ...nsfwEntries(showNsfw),
        user: {
          ...notSuspended(),
          ...visibleActivityAuthor(userId, { muted: true }),
          memberships: {
            some: {
              showLibraryUpdates: true,
              community: { memberships: { some: { userId } } },
            },
          },
        },
      }),
      this.repostStream(viewer, showNsfw, {
        list: reposts,
        cursor,
        excluded,
        muted: true,
      }),
    ]);

    return this.listPage(userId, { streams, reposts, muted: true });
  }

  async findForProfile(
    viewerId: number,
    username: string,
    rawCursor?: string,
    exclude?: string,
  ): Promise<Page<FeedItem>> {
    const cursor = parseFeedCursor(rawCursor);
    const excluded = excludedTypes(exclude);
    const owner = await this.viewableProfile(viewerId, username);
    if (owner.blocking) return { items: [], nextCursor: null };

    const viewer = await contentViewer(this.prisma, viewerId);
    const showNsfw = await showsNsfw(this.prisma, viewerId);
    const pinnedOnWall = { wallUserId: owner.id, pinnedAt: { not: null } };
    const reposts = profileReposts(owner.id, viewerId);
    const [pinned, posts, activities, shared] = await Promise.all([
      this.pinnedPosts(excluded, cursor, {
        AND: [pinnedOnWall, visibleTo(viewer, 'post')],
      }),
      this.postStream(excluded, {
        AND: [
          profilePosts(owner.id, viewerId),
          { NOT: pinnedOnWall },
          olderThan(cursor, RANK.post),
          visibleTo(viewer, 'post'),
        ],
      }),
      this.activityStream(
        excluded,
        cursor,
        profileActivities(owner.id, showNsfw),
      ),
      this.repostStream(viewer, showNsfw, {
        list: reposts,
        cursor,
        excluded,
        muted: false,
      }),
    ]);

    const { items, nextCursor } = await this.listPage(viewerId, {
      streams: [posts, activities, shared],
      pinned,
      reposts,
      muted: false,
    });

    return {
      items: withPins(
        items,
        (post) => post.wallUserId === owner.id,
        viewerId === owner.id,
      ),
      nextCursor,
    };
  }

  async findOneForProfile(
    viewerId: number,
    username: string,
    postId: number,
  ): Promise<FeedItem> {
    if (postId < 1 || postId > MAX_INT) {
      throw new NotFoundException('Post not found');
    }
    const owner = await this.viewableProfile(viewerId, username);
    if (owner.blocking) throw new NotFoundException('Post not found');
    const viewer = await contentViewer(this.prisma, viewerId);
    return this.onePost(viewerId, {
      AND: [
        { id: postId },
        profilePosts(owner.id, viewerId),
        visibleTo(viewer, 'post'),
      ],
    });
  }

  async findActivityForProfile(
    viewerId: number,
    username: string,
    activityId: number,
  ): Promise<FeedItem> {
    if (activityId < 1 || activityId > MAX_INT) {
      throw new NotFoundException('Library update not found');
    }
    const owner = await this.viewableProfile(viewerId, username);
    if (owner.blocking) {
      throw new NotFoundException('Library update not found');
    }
    const showNsfw = await showsNsfw(this.prisma, viewerId);
    return this.oneActivity(viewerId, {
      id: activityId,
      entry: profileActivities(owner.id, showNsfw),
    });
  }

  async searchProfile(
    viewerId: number,
    username: string,
    rawQuery: string,
  ): Promise<FeedItem[]> {
    const owner = await this.viewableProfile(viewerId, username);
    const filter = matching(rawQuery);
    if (!filter || owner.blocking) return [];

    const viewer = await contentViewer(this.prisma, viewerId);
    return this.searchPosts(viewerId, {
      AND: [
        profilePosts(owner.id, viewerId),
        filter,
        visibleTo(viewer, 'post'),
      ],
    });
  }

  private async viewableProfile(viewerId: number, username: string) {
    const owner = await requireUserNamed(
      this.prisma,
      username,
      { id: true, isPublic: true },
      notDeleting,
    );
    const { blocking, blockedBy } = await blockState(
      this.prisma,
      viewerId,
      owner.id,
    );
    if (blockedBy) throw new NotFoundException('This profile isn’t available');
    if (blocking) return { ...owner, blocking };
    if (!(await canViewProfile(this.prisma, viewerId, owner))) {
      throw new ForbiddenException('This profile is private');
    }
    return { ...owner, blocking };
  }

  async createOnWall(
    username: string,
    authorId: number,
    body: CreatePostDto,
  ): Promise<PostItem> {
    const owner = await requireUserNamed(
      this.prisma,
      username,
      { id: true, username: true },
      notDeleting,
    );
    await requireWallAccess(this.prisma, authorId, owner.id);
    if (body.quote && owner.id !== authorId) {
      throw new ForbiddenException('You can’t post there');
    }
    const quoted = await this.quoted(authorId, body.quote);

    const { data, mentioned, hashtags } = await this.withMentions(
      body,
      authorId,
    );
    const post = await this.prisma.post.create({
      data: { wallUserId: owner.id, authorId, ...data, ...quoted?.data },
      include: postInclude,
    });
    await addHashtags(this.prisma, { postId: post.id }, post, hashtags);
    const link = `/users/${owner.username}?post=${post.id}`;
    await this.notifications.notify([
      {
        userId: owner.id,
        actorId: authorId,
        type: 'wall_post',
        message: 'posted on your wall',
        link,
      },
    ]);
    await notifyMentions(this.prisma, this.notifications, {
      mentioned,
      authorId,
      place: { communityId: null, wallUserId: owner.id },
      message: 'mentioned you in a post',
      link,
      alreadyNotified: [owner.id],
    });
    await this.notifyShared(authorId, quoted, 'quote', null);
    return this.newPostItem(authorId, post);
  }

  async findForMedia(
    viewerId: number,
    mediaType: MediaType,
    mediaSourceId: string,
    rawCursor?: string,
    exclude?: string,
  ): Promise<Page<FeedItem>> {
    const cursor = parseFeedCursor(rawCursor);
    const excluded = excludedTypes(exclude);
    const posts = excluded.has('post')
      ? []
      : await this.prisma.post.findMany({
          where: {
            mediaType,
            mediaSourceId,
            ...olderThan(cursor, RANK.post),
            ...visibleTo(await contentViewer(this.prisma, viewerId), 'post'),
          },
          orderBy: newestFirst,
          take: PAGE_SIZE + 1,
          include: postInclude,
        });

    const merged = posts.map(asPost);
    const page = merged.slice(0, PAGE_SIZE);
    const items = await this.engage(viewerId, page);
    return { items, nextCursor: nextCursor(merged, page) };
  }

  async findOneForMedia(
    viewerId: number,
    mediaType: MediaType,
    mediaSourceId: string,
    postId: number,
  ): Promise<FeedItem> {
    if (postId < 1 || postId > MAX_INT) {
      throw new NotFoundException('Post not found');
    }
    return this.onePost(viewerId, {
      id: postId,
      mediaType,
      mediaSourceId,
      ...visibleTo(await contentViewer(this.prisma, viewerId), 'post'),
    });
  }

  async createOnMedia(
    mediaType: MediaType,
    mediaSourceId: string,
    authorId: number,
    body: CreatePostDto,
  ): Promise<PostItem> {
    if (body.quote) throw new BadRequestException('You can’t quote here');
    if (!/^\d{1,12}$/.test(mediaSourceId)) {
      throw new NotFoundException('Title not found');
    }
    const media = await getMedia(
      mediaType,
      mediaSourceId,
      await showsNsfw(this.prisma, authorId),
    );

    const { data, mentioned, hashtags } = await this.withMentions(
      body,
      authorId,
    );
    const post = await this.prisma.post.create({
      data: {
        mediaType,
        mediaSourceId,
        isAdult: media.isAdult === true,
        authorId,
        ...data,
      },
      include: postInclude,
    });
    await addHashtags(this.prisma, { postId: post.id }, post, hashtags);
    await notifyMentions(this.prisma, this.notifications, {
      mentioned,
      authorId,
      place: { communityId: null, wallUserId: null },
      message: 'mentioned you in a post',
      link: `/library/${mediaType}/${mediaSourceId}?post=${post.id}`,
    });
    return this.newPostItem(authorId, post);
  }

  async create(
    communityId: number,
    authorId: number,
    body: CreatePostDto,
  ): Promise<PostItem> {
    const quoted = await this.quoted(authorId, body.quote);
    const { data, mentioned, hashtags } = await this.withMentions(
      body,
      authorId,
    );
    const post = await this.prisma.post.create({
      data: { communityId, authorId, ...data, ...quoted?.data },
      include: postInclude,
    });
    await addHashtags(this.prisma, { postId: post.id }, post, hashtags);
    await notifyMentions(this.prisma, this.notifications, {
      mentioned,
      authorId,
      place: { communityId, wallUserId: null },
      message: 'mentioned you in a post',
      link: `/communities/${communityId}?post=${post.id}`,
    });
    await this.notifyShared(authorId, quoted, 'quote', communityId);
    void this.discordChannel.postCreated(post.id);
    const withNickname = await loadNicknames(this.prisma, [
      { communityId, userId: authorId },
    ]);
    return this.newPostItem(authorId, {
      ...post,
      author: withNickname(communityId, post.author),
    });
  }

  private async original(
    viewer: ContentViewer,
    showNsfw: boolean,
    { type, id }: ShareTarget,
  ) {
    const inRange = id >= 1 && id <= MAX_INT;
    if (type === 'post') {
      const post = inRange
        ? await this.prisma.post.findFirst({
            where: { id, ...viewablePost(viewer, showNsfw) },
            select: {
              authorId: true,
              communityId: true,
              mediaType: true,
              mediaSourceId: true,
              wallUser: { select: { username: true } },
            },
          })
        : null;
      if (!post) throw new NotFoundException('Post not found');
      return { type, ownerId: post.authorId, link: postLink(id, post) };
    }

    const activity = inRange
      ? await this.prisma.libraryActivity.findFirst({
          where: { id, ...viewableActivity(viewer, showNsfw) },
          select: {
            entry: {
              select: { user: { select: { id: true, username: true } } },
            },
          },
        })
      : null;
    if (!activity) throw new NotFoundException('Library update not found');
    const { user } = activity.entry;
    return {
      type,
      ownerId: user.id,
      link: `/users/${user.username}?activity=${id}`,
    };
  }

  private async shareableOriginal(
    userId: number,
    target: ShareTarget,
    denied: string,
    { own = true } = {},
  ) {
    const [viewer, showNsfw] = await Promise.all([
      strictViewer(this.prisma, userId),
      showsNsfw(this.prisma, userId),
    ]);
    const original = await this.original(viewer, showNsfw, target);
    const shareable = await shareableIds(
      this.prisma,
      viewer,
      showNsfw,
      target.type,
      [target.id],
    );
    if (!shareable.has(target.id) || (!own && original.ownerId === userId)) {
      throw new ForbiddenException(denied);
    }
    return original;
  }

  private async quoted(authorId: number, quote?: ShareTarget) {
    if (!quote) return null;
    const original = await this.shareableOriginal(
      authorId,
      quote,
      'You can’t quote this',
    );
    return {
      ...original,
      data: {
        isQuote: true,
        quotePostId: quote.type === 'post' ? quote.id : null,
        quoteActivityId: quote.type === 'activity' ? quote.id : null,
      },
    };
  }

  private async notifyShared(
    actorId: number,
    original: { type: ShareType; ownerId: number; link: string } | null,
    kind: 'repost' | 'quote',
    communityId: number | null,
  ) {
    if (!original || original.ownerId === actorId) return;
    const [notified, visible] = await Promise.all([
      this.prisma.notification.findFirst({
        where: {
          userId: original.ownerId,
          actorId,
          type: { in: ['repost', 'quote'] },
          link: original.link,
        },
        select: { id: true },
      }),
      communityId === null
        ? this.prisma.user.findFirst({
            where: { id: actorId, ...viewableProfiles(original.ownerId) },
            select: { id: true },
          })
        : this.prisma.community.findFirst({
            where: { id: communityId, ...visibleCommunity(original.ownerId) },
            select: { id: true },
          }),
    ]);
    if (notified || !visible) return;
    const what = original.type === 'post' ? 'post' : 'library update';
    await this.notifications.notify([
      {
        userId: original.ownerId,
        actorId,
        type: kind,
        message: `${kind === 'repost' ? 'reposted' : 'quoted'} your ${what}`,
        link: original.link,
      },
    ]);
  }

  private async repostCountOf(viewerId: number, target: OwnedTarget) {
    const viewer = await contentViewer(this.prisma, viewerId);
    const counts = await this.repostCounts(viewer, [target]);
    return counts.get(keyOf(target))?.repostCount ?? 0;
  }

  private async ownerOf({ type, id }: ShareTarget) {
    if (type === 'post') {
      const post = await this.prisma.post.findUnique({
        where: { id },
        select: { authorId: true },
      });
      return post?.authorId ?? null;
    }
    const activity = await this.prisma.libraryActivity.findUnique({
      where: { id },
      select: { entry: { select: { userId: true } } },
    });
    return activity?.entry.userId ?? null;
  }

  async setRepost(
    userId: number,
    target: ShareTarget,
    communityId: number | null,
  ): Promise<RepostResult> {
    const original = await this.shareableOriginal(
      userId,
      target,
      'You can’t repost this',
      { own: false },
    );
    if (communityId !== null) {
      const membership = await this.prisma.membership.findUnique({
        where: { userId_communityId: { userId, communityId } },
        select: { userId: true },
      });
      if (!membership) throw new ForbiddenException('You can’t post there');
    }

    const { count } = await this.prisma.repost.createMany({
      data: [{ userId, communityId, ...repostOf(target) }],
      skipDuplicates: true,
    });
    if (count > 0) {
      await this.notifyShared(userId, original, 'repost', communityId);
    } else {
      const existing = await this.prisma.repost.findFirst({
        where: { userId, ...repostOf(target) },
        select: { id: true, communityId: true },
      });
      if (existing && existing.communityId !== communityId) {
        await this.prisma.repost.update({
          where: { id: existing.id },
          data: { communityId, createdAt: new Date() },
        });
      }
    }
    return {
      reposted: true,
      repostCount: await this.repostCountOf(userId, {
        ...target,
        ownerId: original.ownerId,
      }),
    };
  }

  async removeRepost(
    userId: number,
    target: ShareTarget,
  ): Promise<RepostResult> {
    if (target.id < 1 || target.id > MAX_INT) {
      throw new NotFoundException('Not found');
    }
    await this.prisma.repost.deleteMany({
      where: { userId, ...repostOf(target) },
    });
    const ownerId = await this.ownerOf(target);
    return {
      reposted: false,
      repostCount:
        ownerId === null
          ? 0
          : await this.repostCountOf(userId, { ...target, ownerId }),
    };
  }

  async findReposters(
    viewerId: number,
    target: ShareTarget,
    rawCursor?: string,
  ): Promise<Page<Reposter>> {
    const cursor = parseTimeCursor(rawCursor);
    const [viewer, showNsfw] = await Promise.all([
      contentViewer(this.prisma, viewerId),
      showsNsfw(this.prisma, viewerId),
    ]);
    await this.original(viewer, showNsfw, target);
    const rows = await this.prisma.repost.findMany({
      where: {
        AND: [
          repostOf(target),
          visibleReposts(viewerId),
          createdBefore(cursor),
        ],
      },
      orderBy: newestFirst,
      take: PAGE_SIZE + 1,
      select: { id: true, createdAt: true, user: author },
    });
    const { items, nextCursor } = cursorPage(rows);
    return {
      items: items.map(({ user, createdAt }) => ({
        ...user,
        repostedAt: createdAt,
      })),
      nextCursor,
    };
  }

  async findQuotes(
    viewerId: number,
    target: ShareTarget,
    rawCursor?: string,
  ): Promise<Page<FeedItem>> {
    const cursor = parseTimeCursor(rawCursor);
    const [viewer, showNsfw] = await Promise.all([
      contentViewer(this.prisma, viewerId),
      showsNsfw(this.prisma, viewerId),
    ]);
    const { ownerId } = await this.original(viewer, showNsfw, target);
    const posts = await this.prisma.post.findMany({
      where: {
        AND: [
          unblockedQuotes({ ...target, ownerId }),
          viewablePosts(viewer),
          createdBefore(cursor),
        ],
      },
      orderBy: newestFirst,
      take: PAGE_SIZE + 1,
      include: postInclude,
    });
    const { items, nextCursor } = cursorPage(posts);
    return {
      items: await this.engage(viewerId, items.map(asPost)),
      nextCursor,
    };
  }

  async update(
    userId: number,
    postId: number,
    body: CreatePostDto,
  ): Promise<FeedItem> {
    if (body.quote) throw new BadRequestException('You can’t quote here');
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: {
        ...editableSelect,
        authorId: true,
        communityId: true,
        wallUserId: true,
        mediaType: true,
        mediaSourceId: true,
        forumThreadId: true,
        wallUser: { select: { username: true } },
      },
    });
    if (!post) throw new NotFoundException('Post not found');
    if (post.authorId !== userId) {
      throw new ForbiddenException('You can only edit your own posts');
    }
    if (post.forumThreadId) {
      throw new BadRequestException('Edit this in the forum thread instead');
    }

    const { data, mentioned, hashtags } = await this.withMentions(
      { ...body, content: unlinkHashtags(unlinkMentions(body.content)) },
      userId,
    );
    const { edited, version } = recordEdit(post, data);
    const updated = await this.prisma.$transaction(async (tx) => {
      requireLatest(
        await tx.post.updateMany({
          where: { id: postId, editedAt: post.editedAt },
          data: { ...data, ...edited },
        }),
      );
      if (version)
        await tx.editVersion.create({ data: { postId, ...version } });
      return tx.post.findUniqueOrThrow({
        where: { id: postId },
        include: postInclude,
      });
    });
    await replaceHashtags(this.prisma, { postId }, updated, hashtags);

    const previously = linkedMentions(post.content);
    await notifyMentions(this.prisma, this.notifications, {
      mentioned: mentioned.filter(
        ({ username }) => !previously.has(username.toLowerCase()),
      ),
      authorId: userId,
      place: { communityId: post.communityId, wallUserId: post.wallUserId },
      message: 'mentioned you in a post',
      link: postLink(postId, post),
    });
    void this.discordChannel.contentEdited('post', postId);

    const [item] = await this.engage(userId, [asPost(updated)]);
    return item;
  }

  async findEdits(viewerId: number, postId: number): Promise<EditHistory> {
    const [viewer, showNsfw] = await Promise.all([
      contentViewer(this.prisma, viewerId),
      showsNsfw(this.prisma, viewerId),
    ]);
    const post =
      postId >= 1 && postId <= MAX_INT
        ? await this.prisma.post.findFirst({
            where: { id: postId, ...viewablePost(viewer, showNsfw) },
            select: editHistorySelect,
          })
        : null;
    if (!post) throw new NotFoundException('Post not found');
    return editHistory(post);
  }

  async setPinned(userId: number, postId: number, pinned: boolean) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { communityId: true, wallUserId: true, pinnedAt: true },
    });
    if (!post) throw new NotFoundException('Post not found');
    if (post.communityId === null && post.wallUserId === null) {
      throw new BadRequestException(
        'Only community and wall posts can be pinned',
      );
    }

    const allowed =
      post.communityId !== null
        ? (await managedCommunities(this.prisma, userId, [post.communityId]))
            .size > 0
        : post.wallUserId === userId;
    if (!allowed) {
      throw new ForbiddenException(
        pinned ? 'You can’t pin this post' : 'You can’t unpin this post',
      );
    }
    if (pinned === (post.pinnedAt !== null)) return;

    if (pinned) {
      const limit = pinLimit(post);
      const count = await this.prisma.post.count({
        where: {
          ...(post.communityId !== null
            ? { communityId: post.communityId }
            : { wallUserId: post.wallUserId }),
          pinnedAt: { not: null },
        },
      });
      if (count >= limit) throw new ConflictException(pinLimitMessage(limit));
    }

    await this.prisma.post.update({
      where: { id: postId },
      data: { pinnedAt: pinned ? new Date() : null },
    });
  }

  async shareThread(
    thread: {
      id: number;
      communityId: number;
      authorId: number;
      content: string;
      linkUrl: string | null;
      spoiler: string | null;
    },
    hashtags: ParsedHashtag[],
  ) {
    const post = await this.prisma.post.create({
      data: {
        communityId: thread.communityId,
        authorId: thread.authorId,
        content: thread.content,
        linkUrl: thread.linkUrl,
        spoiler: thread.spoiler,
        forumThreadId: thread.id,
      },
      select: { id: true, authorId: true, createdAt: true },
    });
    await addHashtags(this.prisma, { postId: post.id }, post, hashtags);
    void this.discordChannel.postCreated(post.id);
  }

  async threadChanged(
    threadId: number,
    opening?: {
      content: string;
      linkUrl: string | null;
      spoiler: string | null;
    },
    hashtags: ParsedHashtag[] = [],
  ) {
    const post = await this.prisma.post.findUnique({
      where: { forumThreadId: threadId },
      select: { id: true, authorId: true, ...editableSelect },
    });
    if (!post) return;
    if (opening) {
      const { edited, version } = recordEdit(post, opening);
      await this.prisma.$transaction(async (tx) => {
        requireLatest(
          await tx.post.updateMany({
            where: { id: post.id, editedAt: post.editedAt },
            data: { ...opening, ...edited },
          }),
        );
        if (version) {
          await tx.editVersion.create({
            data: { postId: post.id, ...version },
          });
        }
      });
      await replaceHashtags(this.prisma, { postId: post.id }, post, hashtags);
    }
    void this.discordChannel.contentEdited('post', post.id);
  }

  async removeThreadPosts(threadIds: number[]) {
    if (threadIds.length === 0) return;
    const posts = await this.prisma.post.findMany({
      where: { forumThreadId: { in: threadIds } },
      select: { id: true },
    });
    const ids = posts.map(({ id }) => id);
    if (ids.length === 0) return;
    await this.prisma.$transaction([
      ...(await discussionCleanup(this.prisma, 'post', ids)),
      this.prisma.post.deleteMany({ where: { id: { in: ids } } }),
    ]);
    for (const id of ids) void this.discordChannel.contentDeleted('post', id);
  }

  async remove(userId: number, postId: number) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { authorId: true, communityId: true, wallUserId: true },
    });
    if (!post) throw new NotFoundException('Post not found');
    const allowed =
      post.authorId === userId ||
      post.wallUserId === userId ||
      (await managedCommunities(this.prisma, userId, [post.communityId])).size >
        0;
    if (!allowed) {
      throw new ForbiddenException('You can’t delete this post');
    }

    await this.prisma.$transaction([
      ...(await discussionCleanup(this.prisma, 'post', [postId])),
      this.prisma.post.delete({ where: { id: postId } }),
    ]);
    void this.discordChannel.contentDeleted('post', postId);
  }
}
