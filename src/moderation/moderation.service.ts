import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { author } from '../common/author';
import { ReportsService } from '../reports/reports.service';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';
import { isHeadAdmin } from '../users/head-admin';
import { ACTIVITY_COLOR } from '../reports/discord';
import {
  ContentReportReason,
  ContentReportTarget,
} from '../../prisma/generated/client';
import { CreateContentReportDto } from './dto/create-content-report.dto';
import { ResolveContentReportDto } from './dto/resolve-content-report.dto';

type Person = {
  id: number;
  username: string;
  name: string | null;
  avatarUrl: string | null;
};

type Target = {
  title: string;
  excerpt: string | null;
  author: Person | null;
  link: string;
};

export type ReportedItem = {
  type: ContentReportTarget;
  id: number;
  target: Target | null;
  count: number;
  reasons: Partial<Record<ContentReportReason, number>>;
  reports: {
    id: number;
    reason: ContentReportReason;
    details: string | null;
    createdAt: Date;
    reporter: Person;
  }[];
  lastReportedAt: Date;
};

const reasonLabels: Record<ContentReportReason, string> = {
  spam: 'Spam',
  harassment: 'Harassment',
  inappropriate: 'Inappropriate',
  other: 'Something else',
};

const RECENT_REPORTS = 5;
const DAY = 24 * 60 * 60 * 1000;
const MIN_REPORTER_AGE = 3 * DAY;

export function hideThreshold(members: number | null) {
  if (members === null) return 3;
  return Math.min(25, Math.max(3, Math.ceil(members / 50)));
}

type Hideable = 'post' | 'comment';
const hideable = (type: ContentReportTarget): type is Hideable =>
  type === 'post' || type === 'comment';

function excerpt(html: string, length = 200) {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > length
    ? `${text.slice(0, length - 1).trimEnd()}…`
    : text;
}

@Injectable()
export class ModerationService {
  constructor(
    private prisma: PrismaService,
    private reports: ReportsService,
    private discordChannel: DiscordChannelService,
  ) {}

  private async postLink(post: {
    communityId: number | null;
    wallUser: { username: string } | null;
    mediaType: string | null;
    mediaSourceId: string | null;
  }) {
    if (post.communityId !== null) return `/communities/${post.communityId}`;
    if (post.wallUser) return `/users/${post.wallUser.username}`;
    if (post.mediaType)
      return `/library/${post.mediaType}/${post.mediaSourceId}`;
    return '/';
  }

  private async describe(
    type: ContentReportTarget,
    id: number,
  ): Promise<Target | null> {
    if (type === 'post') {
      const post = await this.prisma.post.findUnique({
        where: { id },
        select: {
          content: true,
          communityId: true,
          mediaType: true,
          mediaSourceId: true,
          author,
          wallUser: { select: { username: true } },
        },
      });
      if (!post) return null;
      return {
        title: 'Post',
        excerpt: excerpt(post.content),
        author: post.author,
        link: await this.postLink(post),
      };
    }

    if (type === 'comment') {
      const comment = await this.prisma.comment.findUnique({
        where: { id },
        select: {
          content: true,
          commentableType: true,
          commentableId: true,
          author,
        },
      });
      if (!comment) return null;
      let link = '/';
      if (comment.commentableType === 'post') {
        const post = await this.prisma.post.findUnique({
          where: { id: comment.commentableId },
          select: {
            communityId: true,
            mediaType: true,
            mediaSourceId: true,
            wallUser: { select: { username: true } },
          },
        });
        if (post) link = await this.postLink(post);
      } else if (comment.commentableType === 'activity') {
        const activity = await this.prisma.libraryActivity.findUnique({
          where: { id: comment.commentableId },
          select: {
            entry: { select: { user: { select: { username: true } } } },
          },
        });
        if (activity) link = `/users/${activity.entry.user.username}`;
      }
      return {
        title: 'Comment',
        excerpt: excerpt(comment.content),
        author: comment.author,
        link,
      };
    }

    if (type === 'user') {
      const user = await this.prisma.user.findUnique({
        where: { id },
        select: author.select,
      });
      if (!user) return null;
      return {
        title: user.name ?? `@${user.username}`,
        excerpt: null,
        author: user,
        link: `/users/${user.username}`,
      };
    }

    const community = await this.prisma.community.findUnique({
      where: { id },
      select: { name: true, description: true, owner: author },
    });
    if (!community) return null;
    return {
      title: community.name,
      excerpt: community.description,
      author: community.owner,
      link: `/communities/${id}`,
    };
  }

  private async ownerOf(type: ContentReportTarget, id: number) {
    if (type === 'user') {
      const user = await this.prisma.user.findUnique({
        where: { id },
        select: { id: true },
      });
      return user?.id ?? null;
    }
    if (type === 'community') {
      const community = await this.prisma.community.findUnique({
        where: { id },
        select: { ownerId: true },
      });
      return community?.ownerId ?? null;
    }
    const select = { select: { authorId: true }, where: { id } };
    const row =
      type === 'post'
        ? await this.prisma.post.findUnique(select)
        : await this.prisma.comment.findUnique(select);
    return row?.authorId ?? null;
  }

  async create(
    userId: number,
    { type, id, reason, details }: CreateContentReportDto,
  ) {
    const ownerId = await this.ownerOf(type, id);
    if (ownerId === null) throw new NotFoundException('That no longer exists');
    if (ownerId === userId) {
      throw new BadRequestException(
        type === 'community'
          ? 'You can’t report your own community'
          : 'You can’t report yourself',
      );
    }

    const note = details?.trim() || null;
    const key = {
      reporterId_targetType_targetId: {
        reporterId: userId,
        targetType: type,
        targetId: id,
      },
    };
    const existing = await this.prisma.contentReport.findUnique({
      where: key,
      select: { resolvedAt: true },
    });
    if (existing && existing.resolvedAt === null) {
      throw new ConflictException('You’ve already reported this');
    }

    await this.prisma.contentReport.upsert({
      where: key,
      create: {
        reporterId: userId,
        targetType: type,
        targetId: id,
        reason,
        details: note,
      },
      update: {
        reason,
        details: note,
        resolution: null,
        resolvedAt: null,
        resolvedById: null,
        createdAt: new Date(),
      },
    });

    if (hideable(type)) await this.autoHide(type, id);

    this.reports.shareActivity(userId, (actor) => ({
      path: '/reports?tab=reported',
      title: `🚩 ${actor} reported a ${type}: ${reasonLabels[reason]}`,
      description: note ?? undefined,
      color: ACTIVITY_COLOR.flag,
    }));
  }

  async open(): Promise<ReportedItem[]> {
    const reports = await this.prisma.contentReport.findMany({
      where: { resolvedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        targetType: true,
        targetId: true,
        reason: true,
        details: true,
        createdAt: true,
        reporter: author,
      },
    });

    const groups = new Map<string, typeof reports>();
    for (const report of reports) {
      const key = `${report.targetType}:${report.targetId}`;
      groups.set(key, [...(groups.get(key) ?? []), report]);
    }

    return Promise.all(
      [...groups.values()].map(async (group) => {
        const [{ targetType, targetId }] = group;
        const reasons: ReportedItem['reasons'] = {};
        for (const { reason } of group)
          reasons[reason] = (reasons[reason] ?? 0) + 1;
        return {
          type: targetType,
          id: targetId,
          target: await this.describe(targetType, targetId),
          count: group.length,
          reasons,
          reports: group
            .slice(0, RECENT_REPORTS)
            .map(({ id, reason, details, createdAt, reporter }) => ({
              id,
              reason,
              details,
              createdAt,
              reporter,
            })),
          lastReportedAt: group[0].createdAt,
        };
      }),
    );
  }

  async resolve(
    userId: number,
    { type, id, resolution }: ResolveContentReportDto,
  ) {
    const { count } = await this.prisma.contentReport.updateMany({
      where: { targetType: type, targetId: id, resolvedAt: null },
      data: { resolution, resolvedAt: new Date(), resolvedById: userId },
    });
    if (count === 0) throw new NotFoundException('Nothing to resolve');
    if (resolution === 'dismissed' && hideable(type)) {
      await this.setHidden(type, id, null);
    }
  }

  private async setHidden(type: Hideable, id: number, hiddenAt: Date | null) {
    const args = {
      where: { id, hiddenAt: hiddenAt ? null : { not: null } },
      data: { hiddenAt },
    };
    if (type === 'comment') {
      await this.prisma.comment.updateMany(args);
      return;
    }
    const { count } = await this.prisma.post.updateMany(args);
    if (count > 0) {
      void this.discordChannel.hiddenChanged(type, id, hiddenAt !== null);
    }
  }

  private async hideContext(type: Hideable, id: number) {
    const select = {
      hiddenAt: true,
      communityId: true,
      author: { select: { id: true, isAdmin: true, email: true } },
    } as const;
    const row =
      type === 'post'
        ? await this.prisma.post.findUnique({ where: { id }, select })
        : await this.prisma.comment.findUnique({ where: { id }, select });
    if (!row) return null;

    const community =
      row.communityId === null
        ? null
        : await this.prisma.community.findUnique({
            where: { id: row.communityId },
            select: {
              ownerId: true,
              _count: { select: { memberships: true } },
            },
          });
    return { ...row, community };
  }

  private async autoHide(type: Hideable, id: number) {
    const context = await this.hideContext(type, id);
    if (!context || context.hiddenAt) return;

    const { author: owner, community } = context;
    const exempt =
      owner.isAdmin ||
      isHeadAdmin(owner.email) ||
      community?.ownerId === owner.id;
    if (exempt) return;

    const now = Date.now();
    const reporters = await this.prisma.contentReport.count({
      where: {
        targetType: type,
        targetId: id,
        resolvedAt: null,
        createdAt: { gte: new Date(now - DAY) },
        reporter: { createdAt: { lte: new Date(now - MIN_REPORTER_AGE) } },
      },
    });

    if (reporters >= hideThreshold(community?._count.memberships ?? null)) {
      await this.setHidden(type, id, new Date());
    }
  }
}
