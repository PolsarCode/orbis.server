import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../prisma/generated/client';
import { PrismaService } from '../prisma.service';
import { PAGE_SIZE } from '../common/pagination';
import { DAY } from '../common/throttle';
import { hashtagName } from '../common/hashtags';
import { MAX_INT } from '../communities/community-member.guard';
import { contentViewer } from '../moderation/visibility';
import { notMutedBy } from '../safety/blocks';
import { showsNsfw } from '../users/nsfw';
import { PostItem, PostsService } from '../posts/posts.service';
import {
  CommentTarget,
  CommentView,
  CommentsService,
} from '../comments/comments.service';
import { ForumService } from '../forum/forum.service';
import { publicUsages } from './public-content';

const MIN_PEOPLE = 2;
const TRENDING_LIMIT = 20;
const SEARCH_LIMIT = 8;
const WEEK = 7 * DAY;

export type TagWindow = 'day' | 'week';

export type TagSummary = { name: string; display: string };

type ForumTagItem = Awaited<ReturnType<ForumService['findForTags']>>[number];

export type TagItem =
  | { kind: 'post'; createdAt: Date; post: PostItem }
  | {
      kind: 'comment';
      createdAt: Date;
      comment: CommentView;
      target: CommentTarget;
    }
  | ({ kind: 'forum_post'; createdAt: Date } & ForumTagItem);

type TagCursor = { createdAt: Date; id: number };

function parseCursor(raw?: string): TagCursor | undefined {
  if (raw === undefined) return undefined;

  const match = /^(\d{1,15})_(\d{1,10})$/.exec(raw);
  const id = Number(match?.[2]);
  if (!match || id < 1 || id > MAX_INT) {
    throw new BadRequestException('Invalid cursor');
  }

  return { createdAt: new Date(Number(match[1])), id };
}

function before(cursor?: TagCursor): Prisma.HashtagUsageWhereInput {
  if (!cursor) return {};
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

function validName(raw: string) {
  const name = hashtagName(raw);
  if (!name) throw new BadRequestException('That isn’t a valid tag');
  return name;
}

function ago(ms: number) {
  return new Date(Date.now() - ms);
}

@Injectable()
export class TagsService {
  constructor(
    private prisma: PrismaService,
    private posts: PostsService,
    private comments: CommentsService,
    private forum: ForumService,
  ) {}

  private async publicWhere(viewerId: number) {
    const [viewer, showNsfw] = await Promise.all([
      contentViewer(this.prisma, viewerId),
      showsNsfw(this.prisma, viewerId),
    ]);
    return publicUsages(viewer, showNsfw);
  }

  private async peopleByTag(where: Prisma.HashtagUsageWhereInput, since: Date) {
    const rows = await this.prisma.hashtagUsage.groupBy({
      by: ['hashtagId', 'authorId'],
      where: { AND: [where, { createdAt: { gte: since } }] },
    });
    const people = new Map<number, number>();
    for (const { hashtagId } of rows) {
      people.set(hashtagId, (people.get(hashtagId) ?? 0) + 1);
    }
    return people;
  }

  private async currentWindow(where: Prisma.HashtagUsageWhereInput) {
    const since = ago(DAY);
    const day = await this.peopleByTag(where, since);
    if ([...day.values()].some((people) => people >= MIN_PEOPLE)) {
      return { window: 'day' as TagWindow, since, people: day };
    }
    return { window: 'week' as TagWindow, since: ago(WEEK), people: null };
  }

  async trending(viewerId: number) {
    const where = await this.publicWhere(viewerId);
    const current = await this.currentWindow(where);
    const people =
      current.people ?? (await this.peopleByTag(where, current.since));
    const ids = [...people].flatMap(([id, count]) =>
      count >= MIN_PEOPLE ? [id] : [],
    );
    const hashtags =
      ids.length === 0
        ? []
        : await this.prisma.hashtag.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true, display: true },
          });

    return {
      window: current.window,
      tags: hashtags
        .map(({ id, name, display }) => ({
          name,
          display,
          people: people.get(id) ?? 0,
        }))
        .sort((a, b) => b.people - a.people || a.name.localeCompare(b.name))
        .slice(0, TRENDING_LIMIT),
    };
  }

  async following(userId: number): Promise<{ tags: TagSummary[] }> {
    const follows = await this.prisma.hashtagFollow.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { hashtagId: 'desc' }],
      select: { hashtag: { select: { name: true, display: true } } },
    });
    return { tags: follows.map(({ hashtag }) => hashtag) };
  }

  async search(viewerId: number, rawQuery: string) {
    const query = rawQuery
      .trim()
      .replace(/^#/, '')
      .slice(0, 100)
      .normalize('NFC')
      .toLowerCase();
    if (query.length < 2) return { tags: [] };

    const where = await this.publicWhere(viewerId);
    const counts = await this.prisma.hashtagUsage.groupBy({
      by: ['hashtagId'],
      where: { AND: [{ hashtag: { name: { startsWith: query } } }, where] },
      _count: { hashtagId: true },
      orderBy: [{ _count: { hashtagId: 'desc' } }, { hashtagId: 'asc' }],
      take: SEARCH_LIMIT,
    });
    if (counts.length === 0) return { tags: [] };

    const hashtags = await this.prisma.hashtag.findMany({
      where: { id: { in: counts.map(({ hashtagId }) => hashtagId) } },
      select: { id: true, name: true, display: true },
    });
    const byId = new Map(hashtags.map((hashtag) => [hashtag.id, hashtag]));

    return {
      tags: counts
        .flatMap(({ hashtagId, _count }) => {
          const hashtag = byId.get(hashtagId);
          return hashtag
            ? [
                {
                  name: hashtag.name,
                  display: hashtag.display,
                  uses: _count.hashtagId,
                },
              ]
            : [];
        })
        .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name)),
    };
  }

  async findOne(viewerId: number, rawName: string, rawCursor?: string) {
    const name = validName(rawName);
    const cursor = parseCursor(rawCursor);
    const [hashtag, where] = await Promise.all([
      this.prisma.hashtag.findUnique({
        where: { name },
        select: {
          id: true,
          display: true,
          follows: { where: { userId: viewerId }, select: { userId: true } },
        },
      }),
      this.publicWhere(viewerId),
    ]);
    const current = cursor ? null : await this.currentWindow(where);
    const tag = {
      name,
      display: name,
      following: (hashtag?.follows.length ?? 0) > 0,
      people: 0,
      window: current?.window ?? ('day' as TagWindow),
    };
    if (!hashtag) return { tag, items: [], nextCursor: null };

    const scoped = { AND: [{ hashtagId: hashtag.id }, where] };
    const [usages, people] = await Promise.all([
      this.prisma.hashtagUsage.findMany({
        where: {
          AND: [scoped, before(cursor), { author: notMutedBy(viewerId) }],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PAGE_SIZE + 1,
        select: {
          id: true,
          createdAt: true,
          postId: true,
          commentId: true,
          forumPostId: true,
        },
      }),
      current && (current.people ?? this.peopleByTag(scoped, current.since)),
    ]);
    const page = usages.slice(0, PAGE_SIZE);
    const items = await this.items(viewerId, page);
    const last = page[page.length - 1];

    return {
      tag: {
        ...tag,
        display: cursor || usages.length > 0 ? hashtag.display : name,
        people: people?.get(hashtag.id) ?? 0,
      },
      items,
      nextCursor:
        usages.length > PAGE_SIZE
          ? `${last.createdAt.getTime()}_${last.id}`
          : null,
    };
  }

  private async items(
    viewerId: number,
    usages: {
      postId: number | null;
      commentId: number | null;
      forumPostId: number | null;
    }[],
  ): Promise<TagItem[]> {
    const idsOf = (key: 'postId' | 'commentId' | 'forumPostId') =>
      usages.flatMap((usage) => (usage[key] === null ? [] : [usage[key]]));
    const [posts, comments, forumPosts] = await Promise.all([
      this.posts.findByIds(viewerId, idsOf('postId')),
      this.comments.findForTags(viewerId, idsOf('commentId')),
      this.forum.findForTags(viewerId, idsOf('forumPostId')),
    ]);
    const postById = new Map(posts.map((post) => [post.id, post]));
    const commentById = new Map(
      comments.map((item) => [item.comment.id, item]),
    );
    const forumPostById = new Map(
      forumPosts.map((item) => [item.forumPost.id, item]),
    );

    return usages.flatMap((usage): TagItem[] => {
      if (usage.postId !== null) {
        const post = postById.get(usage.postId);
        return post ? [{ kind: 'post', createdAt: post.createdAt, post }] : [];
      }
      if (usage.commentId !== null) {
        const item = commentById.get(usage.commentId);
        return item
          ? [{ kind: 'comment', createdAt: item.comment.createdAt, ...item }]
          : [];
      }
      const item =
        usage.forumPostId === null
          ? undefined
          : forumPostById.get(usage.forumPostId);
      return item
        ? [{ kind: 'forum_post', createdAt: item.forumPost.createdAt, ...item }]
        : [];
    });
  }

  async follow(userId: number, rawName: string) {
    const name = validName(rawName);
    const hashtag = await this.prisma.hashtag.upsert({
      where: { name },
      create: { name, display: rawName.normalize('NFC') },
      update: {},
      select: { id: true },
    });
    const key = { userId, hashtagId: hashtag.id };
    await this.prisma.hashtagFollow.upsert({
      where: { userId_hashtagId: key },
      create: key,
      update: {},
    });
    return { following: true };
  }

  async unfollow(userId: number, rawName: string) {
    const name = validName(rawName);
    await this.prisma.hashtagFollow.deleteMany({
      where: { userId, hashtag: { name } },
    });
    return { following: false };
  }
}
