import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { author } from '../common/author';
import { NotificationType, Prisma } from '../../prisma/generated/client';
import { MAX_INT } from '../communities/community-member.guard';
import { notBlockedWith } from '../safety/blocks';

const PAGE_SIZE = 20;

const filters: Record<string, NotificationType[]> = {
  comments: [
    'post_comment',
    'comment_reply',
    'wall_post',
    'mention',
    'forum_reply',
    'forum_quote',
  ],
  friends: ['friend_request', 'friend_accepted'],
  reports: ['report_status', 'report_assigned', 'report_comment'],
  catalog: ['episode_aired', 'game_released', 'game_date'],
};

const MODERATION: NotificationType[] = filters.reports;
const FRIENDS: NotificationType[] = filters.friends;
export const MUTABLE_NOTIFICATIONS = Object.values(NotificationType).filter(
  (type) => !MODERATION.includes(type),
);

export type NotificationQuery = {
  cursor?: number;
  q?: string;
  filter?: string;
  unread?: boolean;
};

export type NewNotification = {
  userId: number;
  actorId: number | null;
  type: NotificationType;
  message: string;
  link: string;
  imageUrl?: string | null;
};

const notificationSelect = {
  id: true,
  type: true,
  message: true,
  link: true,
  imageUrl: true,
  readAt: true,
  createdAt: true,
  actor: author,
} as const;

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private presence: PresenceGateway,
  ) {}

  private async silenced(notifications: NewNotification[]) {
    const social = notifications.filter(
      ({ actorId, type }) => actorId !== null && !MODERATION.includes(type),
    );
    if (social.length === 0) return () => false;

    const userIds = [...new Set(social.map(({ userId }) => userId))];
    const actorIds = [...new Set(social.map(({ actorId }) => actorId!))];
    const [blocks, mutes] = await Promise.all([
      this.prisma.block.findMany({
        where: {
          OR: [
            { blockerId: { in: userIds }, blockedId: { in: actorIds } },
            { blockerId: { in: actorIds }, blockedId: { in: userIds } },
          ],
        },
        select: { blockerId: true, blockedId: true },
      }),
      this.prisma.mute.findMany({
        where: { muterId: { in: userIds }, mutedId: { in: actorIds } },
        select: { muterId: true, mutedId: true },
      }),
    ]);
    const blocked = new Set(
      blocks.flatMap(({ blockerId, blockedId }) => [
        `${blockerId}:${blockedId}`,
        `${blockedId}:${blockerId}`,
      ]),
    );
    const muted = new Set(
      mutes.map(({ muterId, mutedId }) => `${muterId}:${mutedId}`),
    );
    return ({ userId, actorId, type }: NewNotification) => {
      if (actorId === null || MODERATION.includes(type)) return false;
      const key = `${userId}:${actorId}`;
      return blocked.has(key) || (muted.has(key) && !FRIENDS.includes(type));
    };
  }

  private async muted(notifications: NewNotification[]) {
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: [...new Set(notifications.map(({ userId }) => userId))] },
        mutedNotifications: { isEmpty: false },
      },
      select: { id: true, mutedNotifications: true },
    });
    const muted = new Map(
      users.map(({ id, mutedNotifications }) => [id, mutedNotifications]),
    );
    return ({ userId, type }: NewNotification) =>
      !MODERATION.includes(type) && Boolean(muted.get(userId)?.includes(type));
  }

  async notify(notifications: NewNotification[]) {
    const others = notifications.filter(
      ({ userId, actorId }) => userId !== actorId,
    );
    if (others.length === 0) return;
    const [isSilenced, muted] = await Promise.all([
      this.silenced(others),
      this.muted(others),
    ]);
    const recipients = others.filter(
      (notification) => !isSilenced(notification) && !muted(notification),
    );
    if (recipients.length === 0) return;

    const created = await this.prisma.notification.createManyAndReturn({
      data: recipients,
      select: { ...notificationSelect, userId: true },
    });
    const byUser = new Map<
      number,
      Omit<(typeof created)[number], 'userId'>[]
    >();
    for (const { userId, ...item } of created) {
      byUser.set(userId, [...(byUser.get(userId) ?? []), item]);
    }
    for (const [userId, items] of byUser) {
      this.presence.notify([userId], 'notifications:changed', {
        notifications: items,
      });
    }
  }

  async list(userId: number, { cursor, q, filter, unread }: NotificationQuery) {
    if (cursor !== undefined && (cursor < 1 || cursor > MAX_INT)) {
      throw new BadRequestException('Invalid cursor');
    }
    if (filter !== undefined && filter !== 'all' && !filters[filter]) {
      throw new BadRequestException('Unknown filter');
    }

    const search = q?.trim();
    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(filter && filters[filter] && { type: { in: filters[filter] } }),
      ...(unread && { readAt: null }),
      AND: [
        {
          OR: [
            { actorId: null },
            { type: { in: MODERATION } },
            { actor: notBlockedWith(userId) },
          ],
        },
      ],
      ...(search && {
        OR: [
          { message: { contains: search, mode: 'insensitive' } },
          { actor: { name: { contains: search, mode: 'insensitive' } } },
          { actor: { username: { contains: search, mode: 'insensitive' } } },
        ],
      }),
    };

    const items = await this.prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
      ...(cursor !== undefined && { cursor: { id: cursor }, skip: 1 }),
      select: notificationSelect,
    });
    const hasMore = items.length > PAGE_SIZE;
    const page = hasMore ? items.slice(0, PAGE_SIZE) : items;

    return {
      items: page,
      nextCursor: hasMore ? String(page[page.length - 1].id) : null,
    };
  }

  async unreadCount(userId: number) {
    const unreadCount = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });
    return { unreadCount };
  }

  async markRead(userId: number, id: number) {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (count === 0) {
      const exists = await this.prisma.notification.count({
        where: { id, userId },
      });
      if (!exists) throw new NotFoundException('Notification not found');
    }
  }

  async markAllRead(userId: number) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
  }
}
