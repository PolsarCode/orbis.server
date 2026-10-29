import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '../../prisma/generated/client';
import { author, communitySummary } from '../common/author';
import { PAGE_SIZE, Page } from '../common/pagination';
import { sanitizeRichText } from '../common/rich-text';
import {
  linkedMentions,
  notifyMentions,
  resolveMentions,
  unlinkMentions,
} from '../common/mentions';
import { reportedBy, visibleTo } from '../moderation/visibility';
import { requireViewAccess } from '../communities/require-membership';
import { MAX_INT } from '../communities/community-member.guard';
import { VotesService } from '../votes/votes.service';
import { NotificationsService } from '../notifications/notifications.service';
import { loadNicknames } from '../communities/nicknames';
import { CreateThreadDto } from './dto/create-thread.dto';
import { DiscordChannelService } from '../discord-channel/discord-channel.service';
import { managedCommunities } from '../communities/managed-communities';
import { discussionCleanup } from '../comments/discussion-cleanup';
import { containsLink, requireEstablishedAccount } from '../common/new-account';

export const threadInclude = { author, community: communitySummary } as const;

export const THREAD_SORTS = ['hot', 'new', 'top'] as const;

export type ThreadSort = (typeof THREAD_SORTS)[number];

const RANGE_DAYS = { day: 1, week: 7, month: 30, year: 365, all: null };

export type ThreadRange = keyof typeof RANGE_DAYS;

const MAX_OFFSET = 10000;
const DAY = 24 * 60 * 60 * 1000;

type ThreadRow = Prisma.ThreadGetPayload<{ include: typeof threadInclude }>;

export type ThreadSummary = ThreadRow & {
  type: 'thread';
  myVote: number;
  canDelete: boolean;
};

@Injectable()
export class ThreadsService {
  constructor(
    private prisma: PrismaService,
    private votes: VotesService,
    private notifications: NotificationsService,
    private discordChannel: DiscordChannelService,
  ) {}

  async withMyVotes(
    userId: number,
    threads: ThreadRow[],
  ): Promise<ThreadSummary[]> {
    const [mine, managed] = await Promise.all([
      this.votes.myVotes(
        userId,
        'thread',
        threads.map(({ id }) => id),
      ),
      managedCommunities(
        this.prisma,
        userId,
        threads.map(({ communityId }) => communityId),
      ),
    ]);
    return threads.map((thread) => ({
      ...thread,
      type: 'thread',
      myVote: mine.get(thread.id) ?? 0,
      canDelete: thread.authorId === userId || managed.has(thread.communityId),
    }));
  }

  async list(
    userId: number,
    communityId: number,
    sort: string = 'hot',
    offset = 0,
    range: string = 'all',
  ): Promise<Page<ThreadSummary>> {
    if (!THREAD_SORTS.includes(sort as ThreadSort)) {
      throw new BadRequestException('sort must be hot, new or top');
    }
    if (!Object.prototype.hasOwnProperty.call(RANGE_DAYS, range)) {
      throw new BadRequestException(
        'range must be day, week, month, year or all',
      );
    }
    const days = RANGE_DAYS[range as ThreadRange];
    const since = new Date(days === null ? 0 : Date.now() - days * DAY);
    if (offset < 0 || offset > MAX_OFFSET) {
      throw new BadRequestException('Invalid cursor');
    }

    const reported = (await reportedBy(this.prisma, userId)).thread;
    let threads: ThreadRow[];
    if (sort === 'hot') {
      const rows = await this.prisma.$queryRaw<{ id: number }[]>`
        SELECT "id" FROM "Thread"
        WHERE "communityId" = ${communityId}
          AND "createdAt" >= ${since}
          AND ("hiddenAt" IS NULL OR "authorId" = ${userId})
          AND NOT ("id" = ANY(${reported}::int[]))
        ORDER BY ("score" + 1) / power(extract(epoch from (now() - "createdAt")) / 3600 + 2, 1.5) DESC, "id" DESC
        OFFSET ${offset} LIMIT ${PAGE_SIZE + 1}`;
      const found = await this.prisma.thread.findMany({
        where: { id: { in: rows.map(({ id }) => id) } },
        include: threadInclude,
      });
      const byId = new Map(found.map((thread) => [thread.id, thread]));
      threads = rows.flatMap(({ id }) => byId.get(id) ?? []);
    } else {
      threads = await this.prisma.thread.findMany({
        where: {
          communityId,
          createdAt: { gte: since },
          ...visibleTo(userId, reported),
        },
        orderBy:
          sort === 'top'
            ? [{ score: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]
            : [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: PAGE_SIZE + 1,
        include: threadInclude,
      });
    }

    return {
      items: await this.withNicknames(
        await this.withMyVotes(userId, threads.slice(0, PAGE_SIZE)),
      ),
      nextCursor:
        threads.length > PAGE_SIZE ? String(offset + PAGE_SIZE) : null,
    };
  }

  async create(
    userId: number,
    communityId: number,
    { title, content = '', linkUrl }: CreateThreadDto,
  ): Promise<ThreadSummary> {
    const { html, empty } = sanitizeRichText(content);
    if (containsLink(html, linkUrl)) {
      await requireEstablishedAccount(this.prisma, userId, 'post links');
    }
    const { html: linked, mentioned } = await resolveMentions(
      this.prisma,
      empty ? '' : html,
      userId,
    );
    const thread = await this.prisma.$transaction(async (tx) => {
      const created = await tx.thread.create({
        data: {
          communityId,
          authorId: userId,
          title: title.trim(),
          content: linked,
          linkUrl: linkUrl ?? null,
          score: 1,
        },
        include: threadInclude,
      });
      await tx.vote.create({
        data: {
          userId,
          votableType: 'thread',
          votableId: created.id,
          communityId,
          value: 1,
        },
      });
      return created;
    });

    await notifyMentions(this.prisma, this.notifications, {
      mentioned,
      authorId: userId,
      place: { communityId, wallUserId: null },
      message: `mentioned you in the thread “${thread.title}”`,
      link: `/communities/${communityId}?tab=forum&thread=${thread.id}`,
    });
    void this.discordChannel.threadCreated(thread.id);
    const [created] = await this.withNicknames([
      { ...thread, type: 'thread', myVote: 1, canDelete: true },
    ]);
    return created;
  }

  async findOne(userId: number, id: number): Promise<ThreadSummary> {
    if (id < 1 || id > MAX_INT) throw new NotFoundException('Thread not found');

    const thread = await this.prisma.thread.findUnique({
      where: { id },
      include: threadInclude,
    });

    if (!thread || (thread.hiddenAt && thread.authorId !== userId)) {
      throw new NotFoundException('Thread not found');
    }
    await requireViewAccess(this.prisma, userId, thread.communityId);

    const [summary] = await this.withNicknames(
      await this.withMyVotes(userId, [thread]),
    );
    return summary;
  }

  async update(
    userId: number,
    threadId: number,
    { title, content = '', linkUrl }: CreateThreadDto,
  ): Promise<ThreadSummary> {
    const thread = await this.prisma.thread.findUnique({
      where: { id: threadId },
      select: { authorId: true, content: true, communityId: true },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    if (thread.authorId !== userId) {
      throw new ForbiddenException('You can only edit your own threads');
    }

    const { html, empty } = sanitizeRichText(unlinkMentions(content));
    if (containsLink(html, linkUrl)) {
      await requireEstablishedAccount(this.prisma, userId, 'post links');
    }
    const { html: linked, mentioned } = await resolveMentions(
      this.prisma,
      empty ? '' : html,
      userId,
    );
    const updated = await this.prisma.thread.update({
      where: { id: threadId },
      data: {
        title: title.trim(),
        content: linked,
        linkUrl: linkUrl ?? null,
        editedAt: new Date(),
      },
      include: threadInclude,
    });

    const previously = linkedMentions(thread.content);
    await notifyMentions(this.prisma, this.notifications, {
      mentioned: mentioned.filter(
        ({ username }) => !previously.has(username.toLowerCase()),
      ),
      authorId: userId,
      place: { communityId: thread.communityId, wallUserId: null },
      message: `mentioned you in the thread “${updated.title}”`,
      link: `/communities/${thread.communityId}?tab=forum&thread=${threadId}`,
    });
    void this.discordChannel.contentEdited('thread', threadId);

    const [summary] = await this.withNicknames(
      await this.withMyVotes(userId, [updated]),
    );
    return summary;
  }

  async remove(userId: number, threadId: number) {
    const thread = await this.prisma.thread.findUnique({
      where: { id: threadId },
      select: { authorId: true, communityId: true },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    const allowed =
      thread.authorId === userId ||
      (await managedCommunities(this.prisma, userId, [thread.communityId]))
        .size > 0;
    if (!allowed) {
      throw new ForbiddenException('You can’t delete this thread');
    }

    await this.prisma.$transaction([
      ...(await discussionCleanup(this.prisma, 'thread', [threadId])),
      this.prisma.thread.delete({ where: { id: threadId } }),
    ]);
    void this.discordChannel.contentDeleted('thread', threadId);
  }

  private async withNicknames(threads: ThreadSummary[]) {
    const withNickname = await loadNicknames(
      this.prisma,
      threads.map((thread) => ({
        communityId: thread.communityId,
        userId: thread.author.id,
      })),
    );
    return threads.map((thread) => ({
      ...thread,
      author: withNickname(thread.communityId, thread.author),
    }));
  }
}
