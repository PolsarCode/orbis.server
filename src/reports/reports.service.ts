import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { author } from '../common/author';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { ticketNumber } from './ticket';
import { getReporterStatusLabel } from './status-labels';
import { isHeadAdmin } from '../users/head-admin';
import { PresenceGateway } from '../friends/presence.gateway';
import {
  ACTIVITY_COLOR,
  DiscordActivity,
  DiscordTarget,
  postActivityToDiscord,
  postReportToDiscord,
} from './discord';
import { ReportStatus } from '../../prisma/generated/client';
import { webUrl } from '../common/web-url';

const boardLabels: Record<ReportStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
};

const WEBHOOK_KEY = 'reports.discordWebhook';

const reportSelect = {
  id: true,
  category: true,
  status: true,
  message: true,
  pageUrl: true,
  resolutionNote: true,
  createdAt: true,
  author,
} as const;

const adminReportSelect = {
  ...reportSelect,
  hiddenAt: true,
  assignee: author,
  _count: { select: { comments: true } },
} as const;

const commentSelect = {
  id: true,
  content: true,
  createdAt: true,
  author,
} as const;

function toAdminReport<T extends { _count: { comments: number } }>({
  _count,
  ...report
}: T) {
  return { ...report, commentCount: _count.comments };
}

const NOTE_PREVIEW = 140;
const SEARCH_LIMIT = 20;

function preview(note: string) {
  return note.length > NOTE_PREVIEW
    ? `${note.slice(0, NOTE_PREVIEW - 1).trimEnd()}…`
    : note;
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private presence: PresenceGateway,
  ) {}

  async create(
    userId: number,
    { category, message, pageUrl }: CreateReportDto,
  ) {
    const text = message.trim();
    if (!text) throw new BadRequestException('Write a message');

    const report = await this.prisma.report.create({
      data: { authorId: userId, category, message: text, pageUrl },
      select: adminReportSelect,
    });

    void this.announce(report);
    return { id: report.id };
  }

  private async announce(report: Parameters<typeof postReportToDiscord>[1]) {
    try {
      const target = await this.discordTarget();
      if (target) await postReportToDiscord(target, report);
    } catch (e) {
      this.logger.warn(
        `Could not post report ${report.id} to Discord: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  private actor(userId: number) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, username: true, avatarUrl: true },
    });
  }

  shareActivity(
    userId: number,
    activity: (actor: string) => Omit<DiscordActivity, 'actor'>,
  ) {
    void (async () => {
      try {
        const target = await this.discordTarget();
        if (!target) return;
        const actor = await this.actor(userId);
        await postActivityToDiscord(target, {
          ...activity(actor.name ?? actor.username),
          actor,
        });
      } catch (e) {
        this.logger.warn(
          `Could not post report activity to Discord: ${e instanceof Error ? e.message : e}`,
        );
      }
    })();
  }

  async findOne(userId: number, id: number) {
    await this.requireAdmin(userId);
    const report = await this.prisma.report.findUnique({
      where: { id },
      select: adminReportSelect,
    });
    if (!report) throw new NotFoundException('Report not found');
    return toAdminReport(report);
  }

  async admins(userId: number) {
    await this.requireAdmin(userId);
    const headAdmin = process.env.HEAD_ADMIN?.trim();

    const admins = await this.prisma.user.findMany({
      where: {
        OR: [
          { isAdmin: true },
          ...(headAdmin
            ? [{ email: { equals: headAdmin, mode: 'insensitive' as const } }]
            : []),
        ],
      },
      orderBy: { username: 'asc' },
      select: {
        ...author.select,
        email: true,
        appearOffline: true,
        status: true,
      },
    });

    return admins.map(({ email, appearOffline, status, ...admin }) => ({
      ...admin,
      isHeadAdmin: isHeadAdmin(email),
      online: !appearOffline && this.presence.isOnline(admin.id),
      status: this.presence.statusOf(admin.id, { appearOffline, status }),
      twitchLogin: this.presence.twitchOf(admin.id, { appearOffline, status }),
    }));
  }

  async assign(userId: number, id: number, assigneeId: number | null) {
    await this.requireAdmin(userId);

    const report = await this.prisma.report.findUnique({
      where: { id },
      select: { assigneeId: true },
    });
    if (!report) throw new NotFoundException('Report not found');

    if (assigneeId !== null) {
      const assignee = await this.prisma.user.findUnique({
        where: { id: assigneeId },
        select: { isAdmin: true, email: true },
      });
      if (!assignee || !(assignee.isAdmin || isHeadAdmin(assignee.email))) {
        throw new BadRequestException('Reports can only be assigned to admins');
      }
    }

    const updated = await this.prisma.report.update({
      where: { id },
      data: { assigneeId },
      select: adminReportSelect,
    });

    if (assigneeId !== report.assigneeId) {
      const assigneeName = updated.assignee
        ? (updated.assignee.name ?? updated.assignee.username)
        : null;
      this.shareActivity(userId, (actor) => ({
        report: updated,
        path: `/reports?report=${id}`,
        title: assigneeName
          ? `👤 ${actor} assigned ${ticketNumber(id)} to ${assigneeName}`
          : `👤 ${actor} unassigned ${ticketNumber(id)}`,
        color: ACTIVITY_COLOR.assign,
      }));
    }

    if (
      assigneeId !== null &&
      assigneeId !== userId &&
      assigneeId !== report.assigneeId
    ) {
      await this.notifications.notify([
        {
          userId: assigneeId,
          actorId: userId,
          type: 'report_assigned',
          message: `assigned you report ${ticketNumber(id)}`,
          link: `/reports?report=${id}`,
        },
      ]);
    }

    return toAdminReport(updated);
  }

  async comments(userId: number, id: number) {
    await this.requireAdmin(userId);
    await this.requireReport(id);

    return this.prisma.reportComment.findMany({
      where: { reportId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: commentSelect,
    });
  }

  async addComment(userId: number, id: number, content: string) {
    await this.requireAdmin(userId);
    await this.requireReport(id);

    const text = content.trim();
    if (!text) throw new BadRequestException('Write a comment');

    const [comment, report, commenters] = await Promise.all([
      this.prisma.reportComment.create({
        data: {
          reportId: id,
          authorId: userId,
          content: text,
        },
        select: commentSelect,
      }),
      this.prisma.report.findUniqueOrThrow({
        where: { id },
        select: adminReportSelect,
      }),
      this.prisma.reportComment.findMany({
        where: { reportId: id },
        distinct: ['authorId'],
        select: { authorId: true },
      }),
    ]);

    const recipients = new Set([
      ...commenters.map(({ authorId }) => authorId),
      ...(report.assignee ? [report.assignee.id] : []),
    ]);
    recipients.delete(userId);
    await this.notifications.notify(
      [...recipients].map((recipient) => ({
        userId: recipient,
        actorId: userId,
        type: 'report_comment' as const,
        message: `commented on report ${ticketNumber(id)}`,
        link: `/reports?report=${id}`,
      })),
    );

    this.shareActivity(userId, (actor) => ({
      report,
      path: `/reports?report=${id}`,
      title: `💬 ${actor} commented on ${ticketNumber(id)}`,
      description: text,
      color: ACTIVITY_COLOR.comment,
    }));

    return comment;
  }

  private async discordTarget(): Promise<DiscordTarget | null> {
    const setting = await this.prisma.setting.findUnique({
      where: { key: WEBHOOK_KEY },
    });
    return setting ? { webhookUrl: setting.value, siteUrl: webUrl() } : null;
  }

  async webhook(userId: number) {
    await this.requireHeadAdmin(userId);
    const target = await this.discordTarget();
    return { url: target?.webhookUrl ?? null };
  }

  async setWebhook(userId: number, url: string) {
    await this.requireHeadAdmin(userId);
    await this.prisma.setting.upsert({
      where: { key: WEBHOOK_KEY },
      create: { key: WEBHOOK_KEY, value: url },
      update: { value: url },
    });
    return { url };
  }

  async removeWebhook(userId: number) {
    await this.requireHeadAdmin(userId);
    await this.prisma.setting.deleteMany({ where: { key: WEBHOOK_KEY } });
    return { url: null };
  }

  async findAll(userId: number, hidden: boolean) {
    await this.requireAdmin(userId);

    const reports = await this.prisma.report.findMany({
      where: { hiddenAt: hidden ? { not: null } : null },
      orderBy: hidden ? { hiddenAt: 'desc' } : { createdAt: 'desc' },
      select: adminReportSelect,
    });
    return reports.map(toAdminReport);
  }

  async search(userId: number, rawQuery: string) {
    const query = rawQuery.trim().slice(0, 100);
    if (query.length < 2) return [];
    await this.requireAdmin(userId);

    const contains = { contains: query, mode: 'insensitive' as const };
    const ticket = query.replace(/^#/, '');
    const id = /^\d{1,9}$/.test(ticket) ? Number(ticket) : null;
    const reports = await this.prisma.report.findMany({
      where: {
        OR: [
          ...(id ? [{ id }] : []),
          { message: contains },
          { resolutionNote: contains },
          { author: { username: contains } },
          { author: { name: contains } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: SEARCH_LIMIT,
      select: adminReportSelect,
    });
    return reports.map(toAdminReport);
  }

  mine(userId: number) {
    return this.prisma.report.findMany({
      where: { authorId: userId },
      orderBy: { createdAt: 'desc' },
      select: reportSelect,
    });
  }

  async update(userId: number, id: number, { status, note }: UpdateReportDto) {
    await this.requireAdmin(userId);

    const report = await this.prisma.report.findUnique({
      where: { id },
      select: { status: true, category: true, authorId: true },
    });
    if (!report) throw new NotFoundException('Report not found');

    const resolutionNote = status === 'done' ? note?.trim() || null : null;
    const updated = toAdminReport(
      await this.prisma.report.update({
        where: { id },
        data: { status, resolutionNote },
        select: adminReportSelect,
      }),
    );

    if (report.status !== status) {
      this.shareActivity(userId, (actor) => ({
        report: updated,
        path: `/reports?report=${id}`,
        title: `➡️ ${actor} moved ${ticketNumber(id)} from ${boardLabels[report.status]} to ${boardLabels[status]}`,
        description: resolutionNote ? `Reply: ${resolutionNote}` : undefined,
        color: ACTIVITY_COLOR.move,
      }));

      const label = getReporterStatusLabel(status, report.category);
      await this.notifications.notify([
        {
          userId: report.authorId,
          actorId: userId,
          type: 'report_status',
          message: resolutionNote
            ? `updated your report ${ticketNumber(id)}: ${label} — “${preview(resolutionNote)}”`
            : `updated your report ${ticketNumber(id)}: ${label}`,
          link: '/reports',
        },
      ]);
    }

    return updated;
  }

  async hide(userId: number, id: number) {
    await this.requireAdmin(userId);
    await this.requireReport(id);

    const hidden = toAdminReport(
      await this.prisma.report.update({
        where: { id },
        data: { hiddenAt: new Date() },
        select: adminReportSelect,
      }),
    );
    this.shareActivity(userId, (actor) => ({
      report: hidden,
      path: `/reports?report=${id}`,
      title: `🙈 ${actor} hid ${ticketNumber(id)}`,
      color: ACTIVITY_COLOR.hide,
    }));
    return hidden;
  }

  async restore(userId: number, id: number) {
    await this.requireAdmin(userId);
    await this.requireReport(id);

    const restored = toAdminReport(
      await this.prisma.report.update({
        where: { id },
        data: { hiddenAt: null, status: 'todo', resolutionNote: null },
        select: adminReportSelect,
      }),
    );
    this.shareActivity(userId, (actor) => ({
      report: restored,
      path: `/reports?report=${id}`,
      title: `↩️ ${actor} moved ${ticketNumber(id)} back to To do`,
      color: ACTIVITY_COLOR.hide,
    }));
    return restored;
  }

  private async requireReport(id: number) {
    const report = await this.prisma.report.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!report) throw new NotFoundException('Report not found');
  }

  private async requireHeadAdmin(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user || !isHeadAdmin(user.email)) {
      throw new ForbiddenException('Only the head admin can do this');
    }
  }

  private async requireAdmin(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isAdmin: true, email: true },
    });
    if (!user || !(user.isAdmin || isHeadAdmin(user.email))) {
      throw new ForbiddenException('Only site admins can see reports');
    }
  }
}
