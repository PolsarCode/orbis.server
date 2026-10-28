import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CommentableType, Prisma } from '../../prisma/generated/client';
import { author } from '../common/author';
import { sanitizeRichText } from '../common/rich-text';
import {
  linkedMentions,
  MentionedUser,
  MentionPlace,
  notifyMentions,
  resolveMentions,
  unlinkMentions,
} from '../common/mentions';
import { requireViewAccess } from '../communities/require-membership';
import {
  EngagementTarget,
  requireProfileView,
  requireTargetAccess,
  targetOf,
} from '../posts/wall-access';
import { MAX_INT } from '../communities/community-member.guard';
import { VotesService } from '../votes/votes.service';
import { reportedBy } from '../moderation/visibility';
import { loadNicknames } from '../communities/nicknames';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { managedCommunities } from '../communities/managed-communities';
import {
  NewNotification,
  NotificationsService,
} from '../notifications/notifications.service';

const MAX_COMMENTS = 1000;

const commentSelect = {
  id: true,
  parentId: true,
  content: true,
  linkUrl: true,
  score: true,
  hiddenAt: true,
  editedAt: true,
  deletedAt: true,
  createdAt: true,
  author,
} as const;

export type CommentView = Prisma.CommentGetPayload<{
  select: typeof commentSelect;
}> & {
  myVote: number;
  hidden: 'review' | 'reported' | null;
  deleted: boolean;
  canDelete: boolean;
};

@Injectable()
export class CommentsService {
  constructor(
    private prisma: PrismaService,
    private votes: VotesService,
    private notifications: NotificationsService,
  ) {}

  async list(userId: number, type: string, id: number): Promise<CommentView[]> {
    if (!Object.values(CommentableType).includes(type as CommentableType)) {
      throw new BadRequestException('type must be post, thread, or activity');
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
      where: { commentableType, commentableId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_COMMENTS,
      select: commentSelect,
    });
    const [mine, reported, withNickname, managed] = await Promise.all([
      this.votes.myVotes(
        userId,
        'comment',
        comments.map((comment) => comment.id),
      ),
      reportedBy(this.prisma, userId),
      loadNicknames(
        this.prisma,
        comments.map((comment) => ({ communityId, userId: comment.author.id })),
      ),
      managedCommunities(this.prisma, userId, [communityId]),
    ]);
    const reportedIds = new Set(reported.comment);

    return comments.map((comment) => {
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
        myVote: mine.get(comment.id) ?? 0,
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
    { type, id, parentId, content, linkUrl }: CreateCommentDto,
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

    const { html, empty } = sanitizeRichText(content);
    if (empty && !linkUrl) {
      throw new BadRequestException('Comment cannot be empty');
    }
    const { html: linked, mentioned } = await resolveMentions(
      this.prisma,
      empty ? '' : html,
      userId,
    );

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
          score: 1,
        },
        select: commentSelect,
      });
      await tx.vote.create({
        data: {
          userId,
          votableType: 'comment',
          votableId: created.id,
          communityId: home.communityId,
          value: 1,
        },
      });
      await (type === 'post'
        ? tx.post.update({ where: { id }, data: increment })
        : type === 'thread'
          ? tx.thread.update({ where: { id }, data: increment })
          : tx.libraryActivity.update({ where: { id }, data: increment }));
      return created;
    });

    await this.notifyCommented(userId, home, mentioned, parentAuthorId);
    const withNickname = await loadNicknames(this.prisma, [
      { communityId: home.communityId, userId },
    ]);
    return {
      ...comment,
      author: withNickname(home.communityId, comment.author),
      myVote: 1,
      hidden: null,
      deleted: false,
      canDelete: true,
    };
  }

  async update(
    userId: number,
    commentId: number,
    { content, linkUrl }: UpdateCommentDto,
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

    const { html, empty } = sanitizeRichText(unlinkMentions(content));
    if (empty && !linkUrl) {
      throw new BadRequestException('Comment cannot be empty');
    }
    const { html: linked, mentioned } = await resolveMentions(
      this.prisma,
      empty ? '' : html,
      userId,
    );
    const updated = await this.prisma.comment.update({
      where: { id: commentId },
      data: {
        content: linked,
        linkUrl: linkUrl ?? null,
        editedAt: new Date(),
      },
      select: commentSelect,
    });

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

    const [mine, withNickname] = await Promise.all([
      this.votes.myVotes(userId, 'comment', [commentId]),
      loadNicknames(this.prisma, [{ communityId: home.communityId, userId }]),
    ]);
    return {
      ...updated,
      author: withNickname(home.communityId, updated.author),
      myVote: mine.get(commentId) ?? 0,
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
          data: { deletedAt: new Date(), content: '', linkUrl: null },
        }),
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
      this.prisma.vote.deleteMany({
        where: { votableType: 'comment', votableId: id },
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
      : type === 'thread'
        ? this.prisma.thread.updateMany(args)
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
        : `/communities/${target.communityId}?${target.type === 'thread' ? 'tab=forum&' : ''}${item}`;
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
    const { type, id } = target;
    const thread =
      type === 'thread'
        ? await this.prisma.thread.findUnique({
            where: { id },
            select: { title: true },
          })
        : null;
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
        type: type === 'thread' ? 'thread_comment' : 'post_comment',
        message: thread
          ? `commented on your thread “${thread.title}”`
          : type === 'activity'
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
