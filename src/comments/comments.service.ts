import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  CommentableType,
  MediaType,
  Prisma,
} from '../../prisma/generated/client';
import { author, communitySummary } from '../common/author';
import { sanitizeRichText } from '../common/rich-text';
import {
  linkedMentions,
  MentionedUser,
  MentionPlace,
  notifyMentions,
  resolveMentions,
  unlinkMentions,
} from '../common/mentions';
import {
  addHashtags,
  HashtagSource,
  replaceHashtags,
  resolveHashtags,
  unlinkHashtags,
} from '../common/hashtags';
import { requireViewAccess } from '../communities/require-membership';
import {
  EngagementTarget,
  requireProfileView,
  requireTargetAccess,
  targetOf,
} from '../posts/wall-access';
import { LikesService } from '../likes/likes.service';
import { reportedBy } from '../moderation/visibility';
import { loadNicknames } from '../communities/nicknames';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { managedCommunities } from '../communities/managed-communities';
import { containsLink, requireEstablishedAccount } from '../common/new-account';
import { spoilerOf } from '../common/spoiler';
import {
  NewNotification,
  NotificationsService,
} from '../notifications/notifications.service';
import { notSuspended } from '../users/suspension';

const MAX_COMMENTS = 1000;

function hashtagSource(
  commentId: number,
  type: CommentableType,
  id: number,
): HashtagSource {
  return {
    commentId,
    targetPostId: type === 'post' ? id : null,
    targetActivityId: type === 'activity' ? id : null,
  };
}

const commentSelect = {
  id: true,
  parentId: true,
  content: true,
  linkUrl: true,
  spoiler: true,
  likeCount: true,
  hiddenAt: true,
  editedAt: true,
  deletedAt: true,
  createdAt: true,
  author,
} as const;

type RawComment = Prisma.CommentGetPayload<{ select: typeof commentSelect }>;

export type CommentView = RawComment & {
  liked: boolean;
  hidden: 'review' | 'reported' | null;
  deleted: boolean;
  canDelete: boolean;
};

type CommentAuthor = Prisma.UserGetPayload<typeof author> & {
  nickname?: string | null;
};

export type CommentTarget = {
  type: CommentableType;
  id: number;
  author: CommentAuthor;
  community: Prisma.CommunityGetPayload<typeof communitySummary> | null;
  media: { type: MediaType; sourceId: string } | null;
  wallUser: CommentAuthor | null;
};

@Injectable()
export class CommentsService {
  constructor(
    private prisma: PrismaService,
    private likes: LikesService,
    private notifications: NotificationsService,
  ) {}

  async list(userId: number, type: string, id: number): Promise<CommentView[]> {
    if (!Object.values(CommentableType).includes(type as CommentableType)) {
      throw new BadRequestException('type must be post or activity');
    }

    const commentableType = type as CommentableType;
    const { communityId, wallUserId } = await targetOf(
      this.prisma,
      userId,
      commentableType,
      id,
    );
    if (communityId !== null) {
      await requireViewAccess(this.prisma, userId, communityId);
    } else if (wallUserId !== null) {
      await requireProfileView(this.prisma, userId, wallUserId);
    }

    const comments = await this.prisma.comment.findMany({
      where: {
        commentableType,
        commentableId: id,
        OR: [{ author: notSuspended() }, { authorId: userId }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_COMMENTS,
      select: commentSelect,
    });
    return this.present(
      userId,
      comments.map((comment) => ({ communityId, comment })),
    );
  }

  async findForTags(
    userId: number,
    ids: number[],
  ): Promise<{ comment: CommentView; target: CommentTarget }[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.comment.findMany({
      where: { id: { in: ids } },
      select: {
        ...commentSelect,
        communityId: true,
        commentableType: true,
        commentableId: true,
      },
    });
    const targetIds = (type: CommentableType) =>
      rows.flatMap((row) =>
        row.commentableType === type ? [row.commentableId] : [],
      );
    const [views, posts, activities] = await Promise.all([
      this.present(
        userId,
        rows.map(
          ({ communityId, commentableType, commentableId, ...comment }) => ({
            communityId,
            comment,
          }),
        ),
      ),
      this.prisma.post.findMany({
        where: { id: { in: targetIds('post') } },
        select: {
          id: true,
          mediaType: true,
          mediaSourceId: true,
          author,
          community: communitySummary,
          wallUser: author,
        },
      }),
      this.prisma.libraryActivity.findMany({
        where: { id: { in: targetIds('activity') } },
        select: { id: true, entry: { select: { user: author } } },
      }),
    ]);
    const withNickname = await loadNicknames(
      this.prisma,
      posts.map((post) => ({
        communityId: post.community?.id ?? null,
        userId: post.author.id,
      })),
    );
    const targets = {
      post: new Map<number, CommentTarget>(
        posts.map((post) => [
          post.id,
          {
            type: 'post',
            id: post.id,
            author: withNickname(post.community?.id ?? null, post.author),
            community: post.community,
            media:
              post.mediaType && post.mediaSourceId
                ? { type: post.mediaType, sourceId: post.mediaSourceId }
                : null,
            wallUser: post.wallUser,
          },
        ]),
      ),
      activity: new Map<number, CommentTarget>(
        activities.map((activity) => [
          activity.id,
          {
            type: 'activity',
            id: activity.id,
            author: activity.entry.user,
            community: null,
            media: null,
            wallUser: null,
          },
        ]),
      ),
    };

    return rows.flatMap((row, index) => {
      const target = targets[row.commentableType].get(row.commentableId);
      return target ? [{ comment: views[index], target }] : [];
    });
  }

  private async present(
    userId: number,
    rows: { communityId: number | null; comment: RawComment }[],
  ): Promise<CommentView[]> {
    const [liked, reported, withNickname, managed] = await Promise.all([
      this.likes.likedBy(
        userId,
        'comment',
        rows.map(({ comment }) => comment.id),
      ),
      reportedBy(this.prisma, userId),
      loadNicknames(
        this.prisma,
        rows.map(({ communityId, comment }) => ({
          communityId,
          userId: comment.author.id,
        })),
      ),
      managedCommunities(
        this.prisma,
        userId,
        rows.map(({ communityId }) => communityId),
      ),
    ]);
    const reportedIds = new Set(reported.comment);

    return rows.map(({ communityId, comment }) => {
      const own = comment.author.id === userId;
      const deleted = comment.deletedAt !== null;
      const hidden = deleted
        ? null
        : reportedIds.has(comment.id)
          ? ('reported' as const)
          : comment.hiddenAt && !own
            ? ('review' as const)
            : null;
      return {
        ...comment,
        author: withNickname(communityId, comment.author),
        content: hidden || deleted ? '' : comment.content,
        linkUrl: hidden || deleted ? null : comment.linkUrl,
        spoiler: hidden || deleted ? null : comment.spoiler,
        liked: liked.has(comment.id),
        hidden,
        deleted,
        canDelete:
          !deleted &&
          (own || (communityId !== null && managed.has(communityId))),
      };
    });
  }

  async create(
    userId: number,
    { type, id, parentId, content, linkUrl, spoiler }: CreateCommentDto,
  ): Promise<CommentView> {
    const home = await targetOf(this.prisma, userId, type, id);
    await requireTargetAccess(this.prisma, userId, home);

    let parentAuthorId: number | undefined;
    if (parentId !== undefined) {
      const parent = await this.prisma.comment.findUnique({
        where: { id: parentId },
        select: { commentableType: true, commentableId: true, authorId: true },
      });
      parentAuthorId = parent?.authorId;
      if (parent?.commentableType !== type || parent.commentableId !== id) {
        throw new BadRequestException('Invalid parent comment');
      }
    }

    const { html, empty } = sanitizeRichText(unlinkHashtags(content));
    if (empty && !linkUrl) {
      throw new BadRequestException('Comment cannot be empty');
    }
    if (containsLink(html, linkUrl)) {
      await requireEstablishedAccount(this.prisma, userId, 'post links');
    }
    const { html: mentions, mentioned } = await resolveMentions(
      this.prisma,
      empty ? '' : html,
      userId,
    );
    const { html: linked, hashtags } = resolveHashtags(mentions);

    const increment = { commentCount: { increment: 1 } };
    const comment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.comment.create({
        data: {
          communityId: home.communityId,
          commentableType: type,
          commentableId: id,
          parentId,
          authorId: userId,
          content: linked,
          linkUrl: linkUrl ?? null,
          spoiler: spoilerOf(spoiler),
        },
        select: commentSelect,
      });
      await (type === 'post'
        ? tx.post.update({ where: { id }, data: increment })
        : tx.libraryActivity.update({ where: { id }, data: increment }));
      return created;
    });
    await addHashtags(
      this.prisma,
      hashtagSource(comment.id, type, id),
      { authorId: userId, createdAt: comment.createdAt },
      hashtags,
    );

    await this.notifyCommented(userId, home, mentioned, parentAuthorId);
    const withNickname = await loadNicknames(this.prisma, [
      { communityId: home.communityId, userId },
    ]);
    return {
      ...comment,
      author: withNickname(home.communityId, comment.author),
      liked: false,
      hidden: null,
      deleted: false,
      canDelete: true,
    };
  }

  async update(
    userId: number,
    commentId: number,
    { content, linkUrl, spoiler }: UpdateCommentDto,
  ): Promise<CommentView> {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: {
        authorId: true,
        content: true,
        deletedAt: true,
        commentableType: true,
        commentableId: true,
      },
    });
    if (!comment || comment.deletedAt) {
      throw new NotFoundException('Comment not found');
    }
    if (comment.authorId !== userId) {
      throw new ForbiddenException('You can only edit your own comments');
    }

    const { html, empty } = sanitizeRichText(
      unlinkHashtags(unlinkMentions(content)),
    );
    if (empty && !linkUrl) {
      throw new BadRequestException('Comment cannot be empty');
    }
    if (containsLink(html, linkUrl)) {
      await requireEstablishedAccount(this.prisma, userId, 'post links');
    }
    const { html: mentions, mentioned } = await resolveMentions(
      this.prisma,
      empty ? '' : html,
      userId,
    );
    const { html: linked, hashtags } = resolveHashtags(mentions);
    const updated = await this.prisma.comment.update({
      where: { id: commentId },
      data: {
        content: linked,
        linkUrl: linkUrl ?? null,
        spoiler: spoilerOf(spoiler),
        editedAt: new Date(),
      },
      select: commentSelect,
    });
    await replaceHashtags(
      this.prisma,
      hashtagSource(commentId, comment.commentableType, comment.commentableId),
      { authorId: userId, createdAt: updated.createdAt },
      hashtags,
    );

    const home = await targetOf(
      this.prisma,
      userId,
      comment.commentableType,
      comment.commentableId,
    );
    const previously = linkedMentions(comment.content);
    await notifyMentions(this.prisma, this.notifications, {
      mentioned: mentioned.filter(
        ({ username }) => !previously.has(username.toLowerCase()),
      ),
      authorId: userId,
      place: await this.mentionPlace(home),
      message: 'mentioned you in a comment',
      link: await this.linkTo(home),
    });

    const [liked, withNickname] = await Promise.all([
      this.likes.likedBy(userId, 'comment', [commentId]),
      loadNicknames(this.prisma, [{ communityId: home.communityId, userId }]),
    ]);
    return {
      ...updated,
      author: withNickname(home.communityId, updated.author),
      liked: liked.has(commentId),
      hidden: null,
      deleted: false,
      canDelete: true,
    };
  }

  async remove(userId: number, commentId: number) {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: {
        authorId: true,
        communityId: true,
        commentableType: true,
        commentableId: true,
        parentId: true,
        deletedAt: true,
        _count: { select: { replies: true } },
      },
    });
    if (!comment || comment.deletedAt) {
      throw new NotFoundException('Comment not found');
    }
    const allowed =
      comment.authorId === userId ||
      (await managedCommunities(this.prisma, userId, [comment.communityId]))
        .size > 0;
    if (!allowed) {
      throw new ForbiddenException('You can’t delete this comment');
    }

    const fewer = this.countChange(
      comment.commentableType,
      comment.commentableId,
    );
    if (comment._count.replies > 0) {
      await this.prisma.$transaction([
        this.prisma.comment.update({
          where: { id: commentId },
          data: {
            deletedAt: new Date(),
            content: '',
            linkUrl: null,
            spoiler: null,
          },
        }),
        this.prisma.hashtagUsage.deleteMany({ where: { commentId } }),
        fewer,
      ]);
      return;
    }

    await this.prisma.$transaction([...this.removeComment(commentId), fewer]);
    let parentId = comment.parentId;
    while (parentId !== null) {
      const parent = await this.prisma.comment.findUnique({
        where: { id: parentId },
        select: {
          parentId: true,
          deletedAt: true,
          _count: { select: { replies: true } },
        },
      });
      if (!parent?.deletedAt || parent._count.replies > 0) break;
      await this.prisma.$transaction(this.removeComment(parentId));
      parentId = parent.parentId;
    }
  }

  private removeComment(id: number) {
    return [
      this.prisma.like.deleteMany({
        where: { likeableType: 'comment', likeableId: id },
      }),
      this.prisma.comment.delete({ where: { id } }),
    ];
  }

  private countChange(type: CommentableType, id: number) {
    const args = {
      where: { id },
      data: { commentCount: { decrement: 1 } },
    };
    return type === 'post'
      ? this.prisma.post.updateMany(args)
      : this.prisma.libraryActivity.updateMany(args);
  }

  private async linkTo(target: EngagementTarget) {
    const profileOwner =
      target.wallUserId ?? (target.type === 'activity' ? target.ownerId : null);
    const profile =
      profileOwner !== null &&
      (await this.prisma.user.findUnique({
        where: { id: profileOwner },
        select: { username: true },
      }));
    const item = `${target.type}=${target.id}`;
    return target.mediaType
      ? `/library/${target.mediaType}/${target.mediaSourceId}?${item}`
      : profile
        ? `/users/${profile.username}?${item}`
        : `/communities/${target.communityId}?${item}`;
  }

  private async mentionPlace(target: EngagementTarget): Promise<MentionPlace> {
    const activity =
      target.type === 'activity'
        ? await this.prisma.libraryActivity.findUnique({
            where: { id: target.id },
            select: { entry: { select: { isPublic: true } } },
          })
        : null;
    return {
      communityId: target.communityId,
      wallUserId: target.wallUserId,
      ...(activity &&
        !activity.entry.isPublic && { onlyUserId: target.ownerId }),
    };
  }

  private async notifyCommented(
    userId: number,
    target: EngagementTarget,
    mentioned: MentionedUser[],
    parentAuthorId?: number,
  ) {
    const { type } = target;
    const link = await this.linkTo(target);
    const notifications: NewNotification[] = [];

    if (parentAuthorId !== undefined) {
      notifications.push({
        userId: parentAuthorId,
        actorId: userId,
        type: 'comment_reply',
        message: 'replied to your comment',
        link,
      });
    }
    if (target.ownerId !== parentAuthorId) {
      notifications.push({
        userId: target.ownerId,
        actorId: userId,
        type: 'post_comment',
        message:
          type === 'activity'
            ? 'commented on your library update'
            : 'commented on your post',
        link,
      });
    }

    await this.notifications.notify(notifications);
    if (mentioned.length === 0) return;

    await notifyMentions(this.prisma, this.notifications, {
      mentioned,
      authorId: userId,
      place: await this.mentionPlace(target),
      message: 'mentioned you in a comment',
      link,
      alreadyNotified: notifications.map((notification) => notification.userId),
    });
  }
}
