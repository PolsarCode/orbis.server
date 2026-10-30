import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { normalizeUsername } from '../users/username';
import { MAX_INT } from '../communities/community-member.guard';
import { PrismaService } from '../prisma.service';
import {
  LibraryStatus,
  MediaType,
  Prisma,
} from '../../prisma/generated/client';
import { author, communitySummary } from '../common/author';
import { PAGE_SIZE, Page } from '../common/pagination';
import { sanitizeRichText } from '../common/rich-text';
import {
  linkedMentions,
  notifyMentions,
  resolveMentions,
  unlinkMentions,
} from '../common/mentions';
import { CreatePostDto } from './dto/create-post.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { canViewProfile, friendsOf, requireWallAccess } from './wall-access';
import { LikesService } from '../likes/likes.service';
import { getMedia } from '../library/library-api';
import { reportedBy, visibleTo } from '../moderation/visibility';
import { loadNicknames } from '../communities/nicknames';
import { nsfwEntries, showsNsfw } from '../users/nsfw';
import { loadSteamLinks, SteamLink } from '../steam/steam-links';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';
import { managedCommunities } from '../communities/managed-communities';
import { discussionCleanup } from '../comments/discussion-cleanup';
import { containsLink, requireEstablishedAccount } from '../common/new-account';
import { notSuspended } from '../users/suspension';
import { pinLimit, pinLimitMessage } from './pins';

const postInclude = {
  author,
  community: communitySummary,
  wallUser: author,
} as const;

const previewSelect = {
  id: true,
  content: true,
  linkUrl: true,
  createdAt: true,
  author,
} as const;

const PREVIEW_COMMENTS = 3;

function postBody({ content, linkUrl }: CreatePostDto) {
  const { html, empty } = sanitizeRichText(content);
  if (empty && !linkUrl) throw new BadRequestException('Post cannot be empty');
  return { content: empty ? '' : html, linkUrl: linkUrl ?? null };
}

export type PreviewComment = Prisma.CommentGetPayload<{
  select: typeof previewSelect;
}>;

type Engagement = { previewComments: PreviewComment[] };

type RawPost = Prisma.PostGetPayload<{
  include: typeof postInclude;
}> & { type: 'post' };

export type PostItem = RawPost &
  Engagement & {
    liked: boolean;
    canDelete: boolean;
    pinned?: boolean;
    canPin?: boolean;
  };

const activityInclude = {
  entry: {
    select: {
      mediaType: true,
      sourceId: true,
      title: true,
      coverImage: true,
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
  author: Prisma.UserGetPayload<typeof author>;
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

export type ActivityItem = RawActivity &
  Engagement & { liked: boolean; steam: SteamLink | null };

export type FeedItem = PostItem | ActivityItem;

const RANK = { post: 0, activity: 2 } as const;

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

function homePosts(userId: number) {
  return {
    OR: [
      inMyCommunities(userId),
      { wallUserId: userId },
      { authorId: userId, communityId: null, mediaType: null },
      { wallUser: friendsOf(userId) },
    ],
  };
}

function visibleCommunity(viewerId: number) {
  return {
    OR: [{ isPublic: true }, { memberships: { some: { userId: viewerId } } }],
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
      coverImage: entry.coverImage,
      year: entry.year,
    },
  };
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
    const { content, linkUrl } = postBody(body);
    if (containsLink(content, linkUrl)) {
      await requireEstablishedAccount(this.prisma, authorId, 'post links');
    }
    const { html, mentioned } = await resolveMentions(
      this.prisma,
      content,
      authorId,
    );
    return { data: { content: html, linkUrl }, mentioned };
  }

  private async engage(
    viewerId: number,
    items: (RawPost | RawActivity)[],
  ): Promise<FeedItem[]> {
    const idsOf = (type: 'post' | 'activity') =>
      items.flatMap((item) => (item.type === type ? [item.id] : []));
    const reported = await reportedBy(this.prisma, viewerId);
    const [likedPosts, likedActivities, previews] = await Promise.all([
      this.likes.likedBy(viewerId, 'post', idsOf('post')),
      this.likes.likedBy(viewerId, 'activity', idsOf('activity')),
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
                    ...visibleTo(viewerId, reported.comment),
                  },
                  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                  take: PREVIEW_COMMENTS,
                  select: previewSelect,
                })
                .then((comments) => comments.reverse()),
        ),
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
      }));
      const liked = (item.type === 'post' ? likedPosts : likedActivities).has(
        item.id,
      );
      if (item.type === 'activity') {
        const steam = steamOf(item.author.id, item.steamAppId);
        return { ...item, author, liked, previewComments, steam };
      }
      const canDelete =
        item.author.id === viewerId ||
        item.wallUserId === viewerId ||
        (item.communityId !== null && managed.has(item.communityId));
      return { ...item, author, liked, previewComments, canDelete };
    });
  }

  async findForCommunity(
    viewerId: number,
    communityId: number,
    rawCursor?: string,
    exclude?: string,
  ): Promise<Page<FeedItem>> {
    const cursor = parseFeedCursor(rawCursor);
    const excluded = excludedTypes(exclude);
    const reported = await reportedBy(this.prisma, viewerId);
    const nsfw = nsfwEntries(await showsNsfw(this.prisma, viewerId));

    const [pinned, posts, activities] = await Promise.all([
      cursor || excluded.has('post')
        ? []
        : this.prisma.post.findMany({
            where: {
              communityId,
              pinnedAt: { not: null },
              ...visibleTo(viewerId, reported.post),
            },
            orderBy: { pinnedAt: 'desc' },
            include: postInclude,
          }),
      excluded.has('post')
        ? []
        : this.prisma.post.findMany({
            where: {
              communityId,
              pinnedAt: null,
              ...olderThan(cursor, RANK.post),
              ...visibleTo(viewerId, reported.post),
            },
            orderBy: newestFirst,
            take: PAGE_SIZE + 1,
            include: postInclude,
          }),
      excluded.has('activity')
        ? []
        : this.prisma.libraryActivity.findMany({
            where: {
              entry: {
                isPublic: true,
                ...nsfw,
                user: {
                  ...notSuspended(),
                  memberships: {
                    some: { communityId, showLibraryUpdates: true },
                  },
                },
              },
              ...olderThan(cursor, RANK.activity),
            },
            orderBy: newestFirst,
            take: PAGE_SIZE + 1,
            include: activityInclude,
          }),
    ]);

    const merged = [
      ...posts.map((post) => ({ ...post, type: 'post' as const })),
      ...activities.map(toActivity),
    ].sort(compareFeedItems);
    const page = merged.slice(0, PAGE_SIZE);
    const items = await this.engage(viewerId, [
      ...pinned.map((post) => ({ ...post, type: 'post' as const })),
      ...page,
    ]);
    const canPin =
      (await managedCommunities(this.prisma, viewerId, [communityId])).size > 0;

    return {
      items: items.map((item) =>
        item.type === 'post'
          ? { ...item, pinned: item.pinnedAt !== null, canPin }
          : item,
      ),
      nextCursor: nextCursor(merged, page),
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
    const reported = await reportedBy(this.prisma, viewerId);
    const post = await this.prisma.post.findFirst({
      where: {
        id: postId,
        communityId,
        ...visibleTo(viewerId, reported.post),
      },
      include: postInclude,
    });
    if (!post) throw new NotFoundException('Post not found');

    const [item] = await this.engage(viewerId, [{ ...post, type: 'post' }]);
    return item;
  }

  async findActivityInCommunity(
    viewerId: number,
    communityId: number,
    activityId: number,
  ): Promise<FeedItem> {
    if (activityId < 1 || activityId > MAX_INT) {
      throw new NotFoundException('Library update not found');
    }
    const nsfw = nsfwEntries(await showsNsfw(this.prisma, viewerId));
    const activity = await this.prisma.libraryActivity.findFirst({
      where: {
        id: activityId,
        entry: {
          isPublic: true,
          ...nsfw,
          user: {
            ...notSuspended(),
            memberships: { some: { communityId, showLibraryUpdates: true } },
          },
        },
      },
      include: activityInclude,
    });
    if (!activity) throw new NotFoundException('Library update not found');

    const [item] = await this.engage(viewerId, [toActivity(activity)]);
    return item;
  }

  async searchCommunity(
    viewerId: number,
    communityId: number,
    rawQuery: string,
  ): Promise<FeedItem[]> {
    const query = rawQuery.trim().slice(0, 100);
    if (query.length < 2) return [];

    const reported = await reportedBy(this.prisma, viewerId);
    const contains = { contains: query, mode: 'insensitive' as const };
    const posts = await this.prisma.post.findMany({
      where: {
        communityId,
        content: contains,
        ...visibleTo(viewerId, reported.post),
      },
      orderBy: newestFirst,
      take: SEARCH_LIMIT,
      include: postInclude,
    });

    return this.engage(
      viewerId,
      posts.map((post) => ({ ...post, type: 'post' as const })),
    );
  }

  async searchFeed(viewerId: number, rawQuery: string): Promise<FeedItem[]> {
    const query = rawQuery.trim().slice(0, 100);
    if (query.length < 2) return [];

    const reported = await reportedBy(this.prisma, viewerId);
    const contains = { contains: query, mode: 'insensitive' as const };
    const posts = await this.prisma.post.findMany({
      where: {
        AND: [
          homePosts(viewerId),
          { content: contains },
          visibleTo(viewerId, reported.post),
        ],
      },
      orderBy: newestFirst,
      take: SEARCH_LIMIT,
      include: postInclude,
    });

    return this.engage(
      viewerId,
      posts.map((post) => ({ ...post, type: 'post' as const })),
    );
  }

  async findForMember(
    userId: number,
    rawCursor?: string,
    exclude?: string,
  ): Promise<Page<FeedItem>> {
    const cursor = parseFeedCursor(rawCursor);
    const excluded = excludedTypes(exclude);
    const reported = await reportedBy(this.prisma, userId);
    const nsfw = nsfwEntries(await showsNsfw(this.prisma, userId));

    const [posts, activities] = await Promise.all([
      excluded.has('post')
        ? []
        : this.prisma.post.findMany({
            where: {
              AND: [
                homePosts(userId),
                olderThan(cursor, RANK.post),
                visibleTo(userId, reported.post),
              ],
            },
            orderBy: newestFirst,
            take: PAGE_SIZE + 1,
            include: postInclude,
          }),
      excluded.has('activity')
        ? []
        : this.prisma.libraryActivity.findMany({
            where: {
              entry: {
                isPublic: true,
                ...nsfw,
                user: {
                  ...notSuspended(),
                  memberships: {
                    some: {
                      showLibraryUpdates: true,
                      community: { memberships: { some: { userId } } },
                    },
                  },
                },
              },
              ...olderThan(cursor, RANK.activity),
            },
            orderBy: newestFirst,
            take: PAGE_SIZE + 1,
            include: activityInclude,
          }),
    ]);

    const merged = [
      ...posts.map((post) => ({ ...post, type: 'post' as const })),
      ...activities.map(toActivity),
    ].sort(compareFeedItems);
    const page = merged.slice(0, PAGE_SIZE);
    const items = await this.engage(userId, page);

    return { items, nextCursor: nextCursor(merged, page) };
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

    const reported = await reportedBy(this.prisma, viewerId);
    const nsfw = nsfwEntries(await showsNsfw(this.prisma, viewerId));
    const pinnedOnWall = { wallUserId: owner.id, pinnedAt: { not: null } };
    const [pinned, posts, activities] = await Promise.all([
      cursor || excluded.has('post')
        ? []
        : this.prisma.post.findMany({
            where: {
              AND: [pinnedOnWall, visibleTo(viewerId, reported.post)],
            },
            orderBy: { pinnedAt: 'desc' },
            include: postInclude,
          }),
      excluded.has('post')
        ? []
        : this.prisma.post.findMany({
            where: {
              AND: [
                profilePosts(owner.id, viewerId),
                { NOT: pinnedOnWall },
                olderThan(cursor, RANK.post),
                visibleTo(viewerId, reported.post),
              ],
            },
            orderBy: newestFirst,
            take: PAGE_SIZE + 1,
            include: postInclude,
          }),
      excluded.has('activity')
        ? []
        : this.prisma.libraryActivity.findMany({
            where: {
              entry: {
                userId: owner.id,
                isPublic: true,
                ...nsfw,
                user: notSuspended(),
              },
              ...olderThan(cursor, RANK.activity),
            },
            orderBy: newestFirst,
            take: PAGE_SIZE + 1,
            include: activityInclude,
          }),
    ]);

    const merged = [
      ...posts.map((post) => ({ ...post, type: 'post' as const })),
      ...activities.map(toActivity),
    ].sort(compareFeedItems);
    const page = merged.slice(0, PAGE_SIZE);
    const items = await this.engage(viewerId, [
      ...pinned.map((post) => ({ ...post, type: 'post' as const })),
      ...page,
    ]);

    return {
      items: items.map((item) => {
        if (item.type !== 'post') return item;
        const onWall = item.wallUserId === owner.id;
        return {
          ...item,
          pinned: onWall && item.pinnedAt !== null,
          canPin: onWall && viewerId === owner.id,
        };
      }),
      nextCursor: nextCursor(merged, page),
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
    const reported = await reportedBy(this.prisma, viewerId);
    const post = await this.prisma.post.findFirst({
      where: {
        AND: [
          { id: postId },
          profilePosts(owner.id, viewerId),
          visibleTo(viewerId, reported.post),
        ],
      },
      include: postInclude,
    });
    if (!post) throw new NotFoundException('Post not found');

    const [item] = await this.engage(viewerId, [{ ...post, type: 'post' }]);
    return item;
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
    const nsfw = nsfwEntries(await showsNsfw(this.prisma, viewerId));
    const activity = await this.prisma.libraryActivity.findFirst({
      where: {
        id: activityId,
        entry: {
          userId: owner.id,
          isPublic: true,
          ...nsfw,
          user: notSuspended(),
        },
      },
      include: activityInclude,
    });
    if (!activity) throw new NotFoundException('Library update not found');

    const [item] = await this.engage(viewerId, [toActivity(activity)]);
    return item;
  }

  async searchProfile(
    viewerId: number,
    username: string,
    rawQuery: string,
  ): Promise<FeedItem[]> {
    const owner = await this.viewableProfile(viewerId, username);
    const query = rawQuery.trim().slice(0, 100);
    if (query.length < 2) return [];

    const reported = await reportedBy(this.prisma, viewerId);
    const contains = { contains: query, mode: 'insensitive' as const };
    const posts = await this.prisma.post.findMany({
      where: {
        AND: [
          profilePosts(owner.id, viewerId),
          { content: contains },
          visibleTo(viewerId, reported.post),
        ],
      },
      orderBy: newestFirst,
      take: SEARCH_LIMIT,
      include: postInclude,
    });

    return this.engage(
      viewerId,
      posts.map((post) => ({ ...post, type: 'post' as const })),
    );
  }

  private async viewableProfile(viewerId: number, username: string) {
    const owner = await this.prisma.user.findUnique({
      where: { username: normalizeUsername(username) },
      select: { id: true, isPublic: true },
    });
    if (!owner) throw new NotFoundException('User not found');
    if (!(await canViewProfile(this.prisma, viewerId, owner))) {
      throw new ForbiddenException('This profile is private');
    }
    return owner;
  }

  async createOnWall(
    username: string,
    authorId: number,
    body: CreatePostDto,
  ): Promise<PostItem> {
    const owner = await this.prisma.user.findUnique({
      where: { username: normalizeUsername(username) },
      select: { id: true, username: true },
    });
    if (!owner) throw new NotFoundException('User not found');
    await requireWallAccess(this.prisma, authorId, owner.id);

    const { data, mentioned } = await this.withMentions(body, authorId);
    const post = await this.prisma.post.create({
      data: { wallUserId: owner.id, authorId, ...data },
      include: postInclude,
    });
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
    return {
      ...post,
      type: 'post',
      liked: false,
      previewComments: [],
      canDelete: true,
    };
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
            ...visibleTo(
              viewerId,
              (await reportedBy(this.prisma, viewerId)).post,
            ),
          },
          orderBy: newestFirst,
          take: PAGE_SIZE + 1,
          include: postInclude,
        });

    const merged = posts.map((post) => ({ ...post, type: 'post' as const }));
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
    const post = await this.prisma.post.findFirst({
      where: {
        id: postId,
        mediaType,
        mediaSourceId,
        ...visibleTo(viewerId, (await reportedBy(this.prisma, viewerId)).post),
      },
      include: postInclude,
    });
    if (!post) throw new NotFoundException('Post not found');

    const [item] = await this.engage(viewerId, [{ ...post, type: 'post' }]);
    return item;
  }

  async createOnMedia(
    mediaType: MediaType,
    mediaSourceId: string,
    authorId: number,
    body: CreatePostDto,
  ): Promise<PostItem> {
    if (!/^\d{1,12}$/.test(mediaSourceId)) {
      throw new NotFoundException('Title not found');
    }
    await getMedia(
      mediaType,
      mediaSourceId,
      await showsNsfw(this.prisma, authorId),
    );

    const { data, mentioned } = await this.withMentions(body, authorId);
    const post = await this.prisma.post.create({
      data: { mediaType, mediaSourceId, authorId, ...data },
      include: postInclude,
    });
    await notifyMentions(this.prisma, this.notifications, {
      mentioned,
      authorId,
      place: { communityId: null, wallUserId: null },
      message: 'mentioned you in a post',
      link: `/library/${mediaType}/${mediaSourceId}?post=${post.id}`,
    });
    return {
      ...post,
      type: 'post',
      liked: false,
      previewComments: [],
      canDelete: true,
    };
  }

  async create(
    communityId: number,
    authorId: number,
    body: CreatePostDto,
  ): Promise<PostItem> {
    const { data, mentioned } = await this.withMentions(body, authorId);
    const post = await this.prisma.post.create({
      data: { communityId, authorId, ...data },
      include: postInclude,
    });
    await notifyMentions(this.prisma, this.notifications, {
      mentioned,
      authorId,
      place: { communityId, wallUserId: null },
      message: 'mentioned you in a post',
      link: `/communities/${communityId}?post=${post.id}`,
    });
    void this.discordChannel.postCreated(post.id);
    const withNickname = await loadNicknames(this.prisma, [
      { communityId, userId: authorId },
    ]);
    return {
      ...post,
      author: withNickname(communityId, post.author),
      type: 'post',
      liked: false,
      previewComments: [],
      canDelete: true,
    };
  }

  async update(
    userId: number,
    postId: number,
    body: CreatePostDto,
  ): Promise<FeedItem> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: {
        authorId: true,
        content: true,
        communityId: true,
        wallUserId: true,
        mediaType: true,
        mediaSourceId: true,
        wallUser: { select: { username: true } },
      },
    });
    if (!post) throw new NotFoundException('Post not found');
    if (post.authorId !== userId) {
      throw new ForbiddenException('You can only edit your own posts');
    }

    const { data, mentioned } = await this.withMentions(
      { ...body, content: unlinkMentions(body.content) },
      userId,
    );
    const updated = await this.prisma.post.update({
      where: { id: postId },
      data: { ...data, editedAt: new Date() },
      include: postInclude,
    });

    const previously = linkedMentions(post.content);
    await notifyMentions(this.prisma, this.notifications, {
      mentioned: mentioned.filter(
        ({ username }) => !previously.has(username.toLowerCase()),
      ),
      authorId: userId,
      place: { communityId: post.communityId, wallUserId: post.wallUserId },
      message: 'mentioned you in a post',
      link: post.mediaType
        ? `/library/${post.mediaType}/${post.mediaSourceId}?post=${postId}`
        : post.wallUser
          ? `/users/${post.wallUser.username}?post=${postId}`
          : `/communities/${post.communityId}?post=${postId}`,
    });
    void this.discordChannel.contentEdited('post', postId);

    const [item] = await this.engage(userId, [{ ...updated, type: 'post' }]);
    return item;
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
