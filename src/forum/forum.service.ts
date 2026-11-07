import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../prisma/generated/client';
import { PrismaService } from '../prisma.service';
import { PostsService } from '../posts/posts.service';
import {
  NewNotification,
  NotificationsService,
} from '../notifications/notifications.service';
import { LikesService } from '../likes/likes.service';
import { author, communitySummary } from '../common/author';
import { sanitizeRichText } from '../common/rich-text';
import { containsLink, requireEstablishedAccount } from '../common/new-account';
import {
  linkedMentions,
  notifyMentions,
  resolveMentions,
  unlinkMentions,
} from '../common/mentions';
import {
  addHashtags,
  replaceHashtags,
  resolveHashtags,
  unlinkHashtags,
} from '../common/hashtags';
import { loadNicknames } from '../communities/nicknames';
import {
  hiddenFor,
  ContentViewer,
  contentViewer,
  viewerContext,
  ViewerContext,
  visibleTo,
} from '../moderation/visibility';
import { spoilerOf } from '../common/spoiler';
import { searchContains } from '../common/search';
import {
  CreateForumPostDto,
  CreateForumThreadDto,
  UpdateForumPostDto,
  UpdateForumThreadDto,
} from './dto/forum-thread.dto';
import {
  FORUM_PAGE_SIZE,
  forumCleanup,
  forumPostLink,
  isForumManager,
  isMember,
  threadLink,
  visibleThreads,
} from './forum-helpers';
import { authorModeration } from '../communities/member-moderation';
import { managedCommunities } from '../communities/managed-communities';

const SEARCH_LIMIT = 8;
const MAX_PAGE = 100000;

const threadSelect = {
  id: true,
  categoryId: true,
  title: true,
  replyCount: true,
  lastPostAt: true,
  pinnedAt: true,
  lockedAt: true,
  createdAt: true,
  author,
} as const;

const postSelect = {
  id: true,
  threadId: true,
  opening: true,
  content: true,
  linkUrl: true,
  spoiler: true,
  quoteId: true,
  likeCount: true,
  hiddenAt: true,
  editedAt: true,
  createdAt: true,
  author,
} as const;

const quoteSelect = {
  id: true,
  content: true,
  linkUrl: true,
  spoiler: true,
  createdAt: true,
  author,
} as const;

const categorySummary = {
  select: {
    id: true,
    name: true,
    section: { select: { id: true, name: true } },
  },
} as const;

const oldestFirst = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
const newestFirst = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

type RawThread = Prisma.ForumThreadGetPayload<{ select: typeof threadSelect }>;
type RawPost = Prisma.ForumPostGetPayload<{ select: typeof postSelect }>;

function threadTitle(title: string) {
  const trimmed = title.trim().replace(/\s+/g, ' ');
  if (!trimmed) throw new BadRequestException('Give your thread a title');
  return trimmed;
}

function forumBody(content: string, linkUrl?: string) {
  const { html, empty } = sanitizeRichText(content);
  if (empty && !linkUrl) {
    throw new BadRequestException('Write something before posting');
  }
  return empty ? '' : html;
}

function pageNumber(page?: number) {
  return Math.min(Math.max(page ?? 1, 1), MAX_PAGE);
}

@Injectable()
export class ForumService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private likes: LikesService,
    private posts: PostsService,
  ) {}

  private async withMentions(
    content: string,
    authorId: number,
    linkUrl?: string,
  ) {
    const html = forumBody(unlinkHashtags(content), linkUrl);
    if (containsLink(html, linkUrl)) {
      await requireEstablishedAccount(this.prisma, authorId, 'post links');
    }
    const { html: mentions, mentioned } = await resolveMentions(
      this.prisma,
      html,
      authorId,
    );
    return { ...resolveHashtags(mentions), mentioned };
  }

  private async visibleThread(
    viewerId: number,
    communityId: number,
    threadId: number,
    viewer: ContentViewer,
  ) {
    const thread = await this.prisma.forumThread.findFirst({
      where: {
        id: threadId,
        communityId,
        ...visibleThreads(viewer),
      },
      select: {
        ...threadSelect,
        authorId: true,
        category: categorySummary,
      },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    return thread;
  }

  private async decorateThreads(
    viewerId: number,
    communityId: number,
    threads: RawThread[],
    viewer: ContentViewer,
  ) {
    const lastReplies = await Promise.all(
      threads.map(({ id }) =>
        this.prisma.forumPost.findFirst({
          where: {
            threadId: id,
            opening: false,
            ...visibleTo(viewer, 'forum_post'),
          },
          orderBy: newestFirst,
          select: { createdAt: true, author },
        }),
      ),
    );
    const withNickname = await loadNicknames(
      this.prisma,
      [
        ...threads,
        ...lastReplies.flatMap((reply) => (reply ? [reply] : [])),
      ].map(({ author }) => ({ communityId, userId: author.id })),
    );

    return threads.map(({ pinnedAt, lockedAt, ...thread }, index) => {
      const reply = lastReplies[index];
      return {
        ...thread,
        author: withNickname(communityId, thread.author),
        pinned: pinnedAt !== null,
        locked: lockedAt !== null,
        lastReply: reply
          ? {
              createdAt: reply.createdAt,
              author: withNickname(communityId, reply.author),
            }
          : null,
      };
    });
  }

  private async decoratePosts(
    viewerId: number,
    communityId: number,
    posts: RawPost[],
    viewer: ViewerContext,
    manager: boolean,
  ) {
    const quoteIds = [
      ...new Set(
        posts.flatMap(({ quoteId }) => (quoteId === null ? [] : [quoteId])),
      ),
    ];
    const [liked, quotes] = await Promise.all([
      this.likes.likedBy(
        viewerId,
        'forum_post',
        posts.map(({ id }) => id),
      ),
      quoteIds.length === 0
        ? Promise.resolve([])
        : this.prisma.forumPost.findMany({
            where: {
              id: { in: quoteIds },
              ...visibleTo(viewer, 'forum_post'),
            },
            select: quoteSelect,
          }),
    ]);
    const [withNickname, moderationOf] = await Promise.all([
      loadNicknames(
        this.prisma,
        [...posts, ...quotes].map(({ author }) => ({
          communityId,
          userId: author.id,
        })),
      ),
      authorModeration(
        this.prisma,
        viewerId,
        manager
          ? posts.map(({ author }) => ({ communityId, authorId: author.id }))
          : [],
      ),
    ]);
    const quoteById = new Map(
      quotes.map((quote) => [
        quote.id,
        {
          ...quote,
          author: withNickname(communityId, quote.author),
          available: true as const,
          hiddenBecause: hiddenFor(viewer, quote.author.id, quote.content, [
            quote.spoiler,
          ]),
        },
      ]),
    );

    return posts.map(({ quoteId, ...post }) => ({
      ...post,
      author: withNickname(communityId, post.author),
      liked: liked.has(post.id),
      quote:
        quoteId === null
          ? null
          : (quoteById.get(quoteId) ?? {
              id: quoteId,
              available: false as const,
            }),
      canEdit: post.author.id === viewerId,
      canDelete: post.author.id === viewerId || manager,
      moderation: moderationOf(communityId, post.author.id),
      hiddenBecause: hiddenFor(viewer, post.author.id, post.content, [
        post.spoiler,
      ]),
    }));
  }

  async threads(
    viewerId: number,
    communityId: number,
    categoryId: number,
    rawPage?: number,
  ) {
    const found = await this.prisma.forumCategory.findFirst({
      where: { id: categoryId, communityId },
      select: {
        id: true,
        name: true,
        description: true,
        adminOnly: true,
        postToFeed: true,
        section: { select: { id: true, name: true, adminOnly: true } },
      },
    });
    if (!found) throw new NotFoundException('Category not found');
    const { section, ...rest } = found;
    const category = {
      ...rest,
      section: section && { id: section.id, name: section.name },
      adminOnly: rest.adminOnly || section?.adminOnly === true,
    };

    const page = pageNumber(rawPage);
    const viewer = await contentViewer(this.prisma, viewerId);
    const where = {
      categoryId,
      ...visibleThreads(viewer),
    };
    const [total, threads, pinned, member, manager] = await Promise.all([
      this.prisma.forumThread.count({ where: { ...where, pinnedAt: null } }),
      this.prisma.forumThread.findMany({
        where: { ...where, pinnedAt: null },
        orderBy: [{ lastPostAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * FORUM_PAGE_SIZE,
        take: FORUM_PAGE_SIZE,
        select: threadSelect,
      }),
      page === 1
        ? this.prisma.forumThread.findMany({
            where: { ...where, pinnedAt: { not: null } },
            orderBy: [{ pinnedAt: 'desc' }, { id: 'desc' }],
            select: threadSelect,
          })
        : Promise.resolve([]),
      isMember(this.prisma, viewerId, communityId),
      isForumManager(this.prisma, viewerId, communityId),
    ]);
    const decorated = await this.decorateThreads(
      viewerId,
      communityId,
      [...pinned, ...threads],
      viewer,
    );

    return {
      category,
      pinned: decorated.slice(0, pinned.length),
      items: decorated.slice(pinned.length),
      page,
      pageSize: FORUM_PAGE_SIZE,
      total,
      canPost: member && (!category.adminOnly || manager),
      canManage: manager,
    };
  }

  async thread(
    viewerId: number,
    communityId: number,
    threadId: number,
    rawPage?: number,
    postId?: number,
  ) {
    const viewer = await viewerContext(this.prisma, viewerId);
    const thread = await this.visibleThread(
      viewerId,
      communityId,
      threadId,
      viewer,
    );
    const where = { threadId, ...visibleTo(viewer, 'forum_post') };

    let page = pageNumber(rawPage);
    if (postId !== undefined) {
      const target = await this.prisma.forumPost.findFirst({
        where: { ...where, id: postId },
        select: { id: true, createdAt: true },
      });
      if (target) {
        const before = await this.prisma.forumPost.count({
          where: {
            ...where,
            OR: [
              { createdAt: { lt: target.createdAt } },
              { createdAt: target.createdAt, id: { lt: target.id } },
            ],
          },
        });
        page = Math.floor(before / FORUM_PAGE_SIZE) + 1;
      }
    }

    const [total, posts, member, manager] = await Promise.all([
      this.prisma.forumPost.count({ where }),
      this.prisma.forumPost.findMany({
        where,
        orderBy: oldestFirst,
        skip: (page - 1) * FORUM_PAGE_SIZE,
        take: FORUM_PAGE_SIZE,
        select: postSelect,
      }),
      isMember(this.prisma, viewerId, communityId),
      isForumManager(this.prisma, viewerId, communityId),
    ]);
    const [items, withNickname] = await Promise.all([
      this.decoratePosts(viewerId, communityId, posts, viewer, manager),
      loadNicknames(this.prisma, [{ communityId, userId: thread.authorId }]),
    ]);
    const { pinnedAt, lockedAt, authorId, ...rest } = thread;

    return {
      thread: {
        ...rest,
        author: withNickname(communityId, thread.author),
        pinned: pinnedAt !== null,
        locked: lockedAt !== null,
        canEdit: authorId === viewerId || manager,
        canModerate: manager,
        canReply: member && (lockedAt === null || manager),
      },
      items,
      page,
      pageSize: FORUM_PAGE_SIZE,
      total,
    };
  }

  async findForTags(viewerId: number, ids: number[]) {
    if (ids.length === 0) return [];
    const [rows, viewer] = await Promise.all([
      this.prisma.forumPost.findMany({
        where: { id: { in: ids } },
        select: {
          ...postSelect,
          communityId: true,
          thread: {
            select: {
              id: true,
              title: true,
              categoryId: true,
              community: communitySummary,
            },
          },
        },
      }),
      viewerContext(this.prisma, viewerId),
    ]);
    const communityIds = [
      ...new Set(rows.map(({ communityId }) => communityId)),
    ];
    const managed = await managedCommunities(
      this.prisma,
      viewerId,
      communityIds,
    );
    const decorated = await Promise.all(
      communityIds.map((communityId) =>
        this.decoratePosts(
          viewerId,
          communityId,
          rows.flatMap(({ communityId: home, thread, ...post }) =>
            home === communityId ? [post] : [],
          ),
          viewer,
          managed.has(communityId),
        ),
      ),
    );
    const byId = new Map(decorated.flat().map((post) => [post.id, post]));

    return rows.flatMap(({ id, thread }) => {
      const forumPost = byId.get(id);
      return forumPost ? [{ forumPost, thread }] : [];
    });
  }

  async createThread(
    userId: number,
    communityId: number,
    categoryId: number,
    { title, content, linkUrl, spoiler }: CreateForumThreadDto,
  ) {
    const category = await this.prisma.forumCategory.findFirst({
      where: { id: categoryId, communityId },
      select: {
        adminOnly: true,
        postToFeed: true,
        section: { select: { adminOnly: true } },
      },
    });
    if (!category) throw new NotFoundException('Category not found');
    if (
      (category.adminOnly || category.section?.adminOnly) &&
      !(await isForumManager(this.prisma, userId, communityId))
    ) {
      throw new ForbiddenException(
        'Only admins can start threads in this category',
      );
    }

    const cleanTitle = threadTitle(title);
    const note = spoilerOf(spoiler);
    const { html, mentioned, hashtags } = await this.withMentions(
      content,
      userId,
      linkUrl,
    );
    const {
      posts: [opening],
      ...thread
    } = await this.prisma.forumThread.create({
      data: {
        communityId,
        categoryId,
        authorId: userId,
        title: cleanTitle,
        posts: {
          create: {
            communityId,
            authorId: userId,
            opening: true,
            content: html,
            linkUrl: linkUrl ?? null,
            spoiler: note,
          },
        },
      },
      select: { id: true, posts: { select: { id: true, createdAt: true } } },
    });
    await addHashtags(
      this.prisma,
      { forumPostId: opening.id },
      { authorId: userId, createdAt: opening.createdAt },
      hashtags,
    );
    if (category.postToFeed) {
      await this.posts.shareThread(
        {
          id: thread.id,
          communityId,
          authorId: userId,
          content: html,
          linkUrl: linkUrl ?? null,
          spoiler: note,
        },
        hashtags,
      );
    }

    await notifyMentions(this.prisma, this.notifications, {
      mentioned,
      authorId: userId,
      place: { communityId, wallUserId: null },
      message: `mentioned you in “${cleanTitle}”`,
      link: threadLink(communityId, thread.id),
    });
    return thread;
  }

  async reply(
    userId: number,
    communityId: number,
    threadId: number,
    { content, quoteId, linkUrl, spoiler }: CreateForumPostDto,
  ) {
    const viewer = await contentViewer(this.prisma, userId);
    const thread = await this.visibleThread(
      userId,
      communityId,
      threadId,
      viewer,
    );
    if (
      thread.lockedAt !== null &&
      !(await isForumManager(this.prisma, userId, communityId))
    ) {
      throw new ForbiddenException('This thread is locked');
    }

    const quote =
      quoteId === undefined
        ? null
        : await this.prisma.forumPost.findFirst({
            where: {
              id: quoteId,
              threadId,
              ...visibleTo(viewer, 'forum_post'),
            },
            select: { id: true, authorId: true },
          });
    if (quoteId !== undefined && !quote) {
      throw new BadRequestException('That post can’t be quoted');
    }

    const { html, mentioned, hashtags } = await this.withMentions(
      content,
      userId,
      linkUrl,
    );
    const now = new Date();
    const [post] = await this.prisma.$transaction([
      this.prisma.forumPost.create({
        data: {
          threadId,
          communityId,
          authorId: userId,
          content: html,
          linkUrl: linkUrl ?? null,
          spoiler: spoilerOf(spoiler),
          quoteId: quote?.id ?? null,
          createdAt: now,
        },
        select: { id: true },
      }),
      this.prisma.forumThread.update({
        where: { id: threadId },
        data: { replyCount: { increment: 1 }, lastPostAt: now },
      }),
    ]);
    await addHashtags(
      this.prisma,
      { forumPostId: post.id },
      { authorId: userId, createdAt: now },
      hashtags,
    );

    const link = forumPostLink(communityId, threadId, post.id);
    const notes: NewNotification[] = [];
    if (quote && quote.authorId !== userId) {
      notes.push({
        userId: quote.authorId,
        actorId: userId,
        type: 'forum_quote',
        message: `quoted you in “${thread.title}”`,
        link,
      });
    }
    if (
      thread.authorId !== userId &&
      !notes.some(({ userId: recipient }) => recipient === thread.authorId)
    ) {
      notes.push({
        userId: thread.authorId,
        actorId: userId,
        type: 'forum_reply',
        message: `replied to your thread “${thread.title}”`,
        link,
      });
    }
    await this.notifications.notify(notes);
    await notifyMentions(this.prisma, this.notifications, {
      mentioned,
      authorId: userId,
      place: { communityId, wallUserId: null },
      message: `mentioned you in “${thread.title}”`,
      link,
      alreadyNotified: notes.map(({ userId: recipient }) => recipient),
    });
    return post;
  }

  async updateThread(
    userId: number,
    communityId: number,
    threadId: number,
    { title, categoryId }: UpdateForumThreadDto,
  ) {
    const thread = await this.prisma.forumThread.findFirst({
      where: { id: threadId, communityId },
      select: { authorId: true, categoryId: true },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    const manager = await isForumManager(this.prisma, userId, communityId);
    if (thread.authorId !== userId && !manager) {
      throw new ForbiddenException('You can’t edit this thread');
    }

    const moving = categoryId !== undefined && categoryId !== thread.categoryId;
    if (moving) {
      if (!manager)
        throw new ForbiddenException('Only admins can move threads');
      const category = await this.prisma.forumCategory.findFirst({
        where: { id: categoryId, communityId },
        select: { id: true },
      });
      if (!category) throw new NotFoundException('Category not found');
    }

    const updated = await this.prisma.forumThread.update({
      where: { id: threadId },
      data: {
        ...(title !== undefined && { title: threadTitle(title) }),
        ...(moving && { categoryId }),
      },
      select: { id: true, title: true, categoryId: true },
    });
    if (title !== undefined) await this.posts.threadChanged(threadId);
    return updated;
  }

  async setFlag(
    userId: number,
    communityId: number,
    threadId: number,
    flag: 'pinnedAt' | 'lockedAt',
    on: boolean,
  ) {
    if (!(await isForumManager(this.prisma, userId, communityId))) {
      throw new ForbiddenException(
        flag === 'pinnedAt'
          ? 'Only admins can pin threads'
          : 'Only admins can lock threads',
      );
    }
    const thread = await this.prisma.forumThread.findFirst({
      where: { id: threadId, communityId },
      select: { pinnedAt: true, lockedAt: true },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    if (on === (thread[flag] !== null)) return;

    await this.prisma.forumThread.update({
      where: { id: threadId },
      data: { [flag]: on ? new Date() : null },
    });
  }

  async updatePost(
    userId: number,
    communityId: number,
    postId: number,
    { content, linkUrl, spoiler }: UpdateForumPostDto,
  ) {
    const post = await this.prisma.forumPost.findFirst({
      where: { id: postId, communityId },
      select: { authorId: true, content: true, threadId: true, opening: true },
    });
    if (!post) throw new NotFoundException('Post not found');
    if (post.authorId !== userId) {
      throw new ForbiddenException('You can only edit your own posts');
    }

    const { html, mentioned, hashtags } = await this.withMentions(
      unlinkHashtags(unlinkMentions(content)),
      userId,
      linkUrl,
    );
    const updated = await this.prisma.forumPost.update({
      where: { id: postId },
      data: {
        content: html,
        linkUrl: linkUrl ?? null,
        spoiler: spoilerOf(spoiler),
        editedAt: new Date(),
      },
      select: postSelect,
    });
    await replaceHashtags(
      this.prisma,
      { forumPostId: postId },
      { authorId: userId, createdAt: updated.createdAt },
      hashtags,
    );
    if (post.opening) {
      await this.posts.threadChanged(
        post.threadId,
        {
          content: html,
          linkUrl: linkUrl ?? null,
          spoiler: updated.spoiler,
        },
        hashtags,
      );
    }

    const previously = linkedMentions(post.content);
    await notifyMentions(this.prisma, this.notifications, {
      mentioned: mentioned.filter(
        ({ username }) => !previously.has(username.toLowerCase()),
      ),
      authorId: userId,
      place: { communityId, wallUserId: null },
      message: 'mentioned you in a forum post',
      link: forumPostLink(communityId, post.threadId, postId),
    });

    const [viewer, manager] = await Promise.all([
      viewerContext(this.prisma, userId),
      isForumManager(this.prisma, userId, communityId),
    ]);
    const [item] = await this.decoratePosts(
      userId,
      communityId,
      [updated],
      viewer,
      manager,
    );
    return item;
  }

  async removeThread(userId: number, communityId: number, threadId: number) {
    const thread = await this.prisma.forumThread.findFirst({
      where: { id: threadId, communityId },
      select: { authorId: true, posts: { select: { id: true } } },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    if (
      thread.authorId !== userId &&
      !(await isForumManager(this.prisma, userId, communityId))
    ) {
      throw new ForbiddenException('You can’t delete this thread');
    }

    await this.posts.removeThreadPosts([threadId]);
    await this.prisma.$transaction([
      ...forumCleanup(
        this.prisma,
        communityId,
        [threadId],
        thread.posts.map(({ id }) => id),
      ),
      this.prisma.forumThread.delete({ where: { id: threadId } }),
    ]);
  }

  async removePost(userId: number, communityId: number, postId: number) {
    const post = await this.prisma.forumPost.findFirst({
      where: { id: postId, communityId },
      select: { authorId: true, threadId: true, opening: true },
    });
    if (!post) throw new NotFoundException('Post not found');
    if (post.opening) {
      return this.removeThread(userId, communityId, post.threadId);
    }
    if (
      post.authorId !== userId &&
      !(await isForumManager(this.prisma, userId, communityId))
    ) {
      throw new ForbiddenException('You can’t delete this post');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.like.deleteMany({
        where: { likeableType: 'forum_post', likeableId: postId },
      });
      await tx.contentReport.deleteMany({
        where: { targetType: 'forum_post', targetId: postId },
      });
      await tx.notification.deleteMany({
        where: { link: forumPostLink(communityId, post.threadId, postId) },
      });
      await tx.forumPost.delete({ where: { id: postId } });
      const latest = await tx.forumPost.findFirst({
        where: { threadId: post.threadId },
        orderBy: newestFirst,
        select: { createdAt: true },
      });
      await tx.forumThread.update({
        where: { id: post.threadId },
        data: {
          replyCount: { decrement: 1 },
          ...(latest && { lastPostAt: latest.createdAt }),
        },
      });
    });
  }

  async search(viewerId: number, communityId: number, rawQuery: string) {
    const contains = searchContains(rawQuery);
    if (!contains) return [];

    const viewer = await contentViewer(this.prisma, viewerId);
    const threads = await this.prisma.forumThread.findMany({
      where: {
        communityId,
        ...visibleThreads(viewer),
        OR: [
          { title: contains },
          {
            posts: {
              some: {
                OR: [{ content: contains }, { spoiler: contains }],
                ...visibleTo(viewer, 'forum_post'),
              },
            },
          },
        ],
      },
      orderBy: [{ lastPostAt: 'desc' }, { id: 'desc' }],
      take: SEARCH_LIMIT,
      select: {
        ...threadSelect,
        category: categorySummary,
      },
    });
    const withNickname = await loadNicknames(
      this.prisma,
      threads.map(({ author }) => ({ communityId, userId: author.id })),
    );
    return threads.map(({ pinnedAt, lockedAt, ...thread }) => ({
      ...thread,
      author: withNickname(communityId, thread.author),
      pinned: pinnedAt !== null,
      locked: lockedAt !== null,
    }));
  }
}
