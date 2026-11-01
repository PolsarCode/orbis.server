import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../prisma/generated/client';
import { PrismaService } from '../prisma.service';
import {
  NewNotification,
  NotificationsService,
} from '../notifications/notifications.service';
import { LikesService } from '../likes/likes.service';
import { author } from '../common/author';
import { sanitizeRichText } from '../common/rich-text';
import { containsLink, requireEstablishedAccount } from '../common/new-account';
import {
  linkedMentions,
  notifyMentions,
  resolveMentions,
  unlinkMentions,
} from '../common/mentions';
import { loadNicknames } from '../communities/nicknames';
import { reportedBy, visibleTo } from '../moderation/visibility';
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
  createdAt: true,
  author,
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

function forumBody(content: string) {
  const { html, empty } = sanitizeRichText(content);
  if (empty) throw new BadRequestException('Write something before posting');
  return html;
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
  ) {}

  private async withMentions(content: string, authorId: number) {
    const html = forumBody(content);
    if (containsLink(html)) {
      await requireEstablishedAccount(this.prisma, authorId, 'post links');
    }
    return resolveMentions(this.prisma, html, authorId);
  }

  private async visibleThread(
    viewerId: number,
    communityId: number,
    threadId: number,
    reported: number[],
  ) {
    const thread = await this.prisma.forumThread.findFirst({
      where: {
        id: threadId,
        communityId,
        ...visibleThreads(viewerId, reported),
      },
      select: {
        ...threadSelect,
        authorId: true,
        category: {
          select: {
            id: true,
            name: true,
            section: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    return thread;
  }

  private async decorateThreads(
    viewerId: number,
    communityId: number,
    threads: RawThread[],
    reported: number[],
  ) {
    const lastReplies = await Promise.all(
      threads.map(({ id }) =>
        this.prisma.forumPost.findFirst({
          where: {
            threadId: id,
            opening: false,
            ...visibleTo(viewerId, reported),
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
    reported: number[],
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
            where: { id: { in: quoteIds }, ...visibleTo(viewerId, reported) },
            select: quoteSelect,
          }),
    ]);
    const withNickname = await loadNicknames(
      this.prisma,
      [...posts, ...quotes].map(({ author }) => ({
        communityId,
        userId: author.id,
      })),
    );
    const quoteById = new Map(
      quotes.map((quote) => [
        quote.id,
        {
          ...quote,
          author: withNickname(communityId, quote.author),
          available: true as const,
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
    const reported = await reportedBy(this.prisma, viewerId);
    const where = {
      categoryId,
      ...visibleThreads(viewerId, reported.forum_post),
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
      reported.forum_post,
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
    const reported = await reportedBy(this.prisma, viewerId);
    const thread = await this.visibleThread(
      viewerId,
      communityId,
      threadId,
      reported.forum_post,
    );
    const where = { threadId, ...visibleTo(viewerId, reported.forum_post) };

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
      this.decoratePosts(
        viewerId,
        communityId,
        posts,
        reported.forum_post,
        manager,
      ),
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

  async createThread(
    userId: number,
    communityId: number,
    categoryId: number,
    { title, content }: CreateForumThreadDto,
  ) {
    const category = await this.prisma.forumCategory.findFirst({
      where: { id: categoryId, communityId },
      select: { adminOnly: true, section: { select: { adminOnly: true } } },
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
    const { html, mentioned } = await this.withMentions(content, userId);
    const thread = await this.prisma.forumThread.create({
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
          },
        },
      },
      select: { id: true },
    });

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
    { content, quoteId }: CreateForumPostDto,
  ) {
    const reported = await reportedBy(this.prisma, userId);
    const thread = await this.visibleThread(
      userId,
      communityId,
      threadId,
      reported.forum_post,
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
              ...visibleTo(userId, reported.forum_post),
            },
            select: { id: true, authorId: true },
          });
    if (quoteId !== undefined && !quote) {
      throw new BadRequestException('That post can’t be quoted');
    }

    const { html, mentioned } = await this.withMentions(content, userId);
    const now = new Date();
    const [post] = await this.prisma.$transaction([
      this.prisma.forumPost.create({
        data: {
          threadId,
          communityId,
          authorId: userId,
          content: html,
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

    return this.prisma.forumThread.update({
      where: { id: threadId },
      data: {
        ...(title !== undefined && { title: threadTitle(title) }),
        ...(moving && { categoryId }),
      },
      select: { id: true, title: true, categoryId: true },
    });
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
    { content }: UpdateForumPostDto,
  ) {
    const post = await this.prisma.forumPost.findFirst({
      where: { id: postId, communityId },
      select: { authorId: true, content: true, threadId: true },
    });
    if (!post) throw new NotFoundException('Post not found');
    if (post.authorId !== userId) {
      throw new ForbiddenException('You can only edit your own posts');
    }

    const { html, mentioned } = await this.withMentions(
      unlinkMentions(content),
      userId,
    );
    const updated = await this.prisma.forumPost.update({
      where: { id: postId },
      data: { content: html, editedAt: new Date() },
      select: postSelect,
    });

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

    const [reported, manager] = await Promise.all([
      reportedBy(this.prisma, userId),
      isForumManager(this.prisma, userId, communityId),
    ]);
    const [item] = await this.decoratePosts(
      userId,
      communityId,
      [updated],
      reported.forum_post,
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
    const query = rawQuery.trim().slice(0, 100);
    if (query.length < 2) return [];

    const reported = await reportedBy(this.prisma, viewerId);
    const contains = { contains: query, mode: 'insensitive' as const };
    const threads = await this.prisma.forumThread.findMany({
      where: {
        communityId,
        ...visibleThreads(viewerId, reported.forum_post),
        OR: [
          { title: contains },
          {
            posts: {
              some: {
                content: contains,
                ...visibleTo(viewerId, reported.forum_post),
              },
            },
          },
        ],
      },
      orderBy: [{ lastPostAt: 'desc' }, { id: 'desc' }],
      take: SEARCH_LIMIT,
      select: {
        ...threadSelect,
        category: {
          select: {
            id: true,
            name: true,
            section: { select: { id: true, name: true } },
          },
        },
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
