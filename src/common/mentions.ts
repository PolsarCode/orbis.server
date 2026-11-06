import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { notBlockedWith } from '../safety/blocks';

export const MAX_MENTIONS = 10;

const MENTION = /(^|[^\w@/.-])@([A-Za-z0-9_]{3,20})(?![\w@])/g;
const IGNORED_TAGS = new Set(['a', 'code', 'pre']);

export type MentionedUser = { id: number; username: string };

export type MentionPlace = {
  communityId: number | null;
  wallUserId: number | null;
  onlyUserId?: number;
};

export function filterText(html: string, filter: (text: string) => string) {
  let ignored = 0;
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      const tag = /^<(\/?)([a-z]+)/i.exec(part);
      if (tag) {
        if (IGNORED_TAGS.has(tag[2].toLowerCase())) {
          ignored = Math.max(0, ignored + (tag[1] ? -1 : 1));
        }
        return part;
      }
      return ignored > 0 ? part : filter(part);
    })
    .join('');
}

const LINKED_MENTION =
  /<a\b[^>]*\bhref="\/users\/([a-z0-9_]{3,20})"[^>]*>(@[A-Za-z0-9_]{3,20})<\/a>/gi;

export function unlinkMentions(html: string) {
  return html.replace(
    LINKED_MENTION,
    (_match, _username, text: string) => text,
  );
}

export function linkedMentions(html: string) {
  return new Set(
    [...html.matchAll(LINKED_MENTION)].map(([, username]) =>
      username.toLowerCase(),
    ),
  );
}

export function mentionedUsernames(html: string) {
  const found = new Set<string>();
  filterText(html, (text) => {
    for (const [, , username] of text.matchAll(MENTION)) {
      found.add(username.toLowerCase());
    }
    return text;
  });
  return [...found].slice(0, MAX_MENTIONS);
}

export function linkMentions(html: string, usernames: Set<string>) {
  if (usernames.size === 0) return html;
  return filterText(html, (text) =>
    text.replace(MENTION, (match, before: string, username: string) => {
      const normalized = username.toLowerCase();
      return usernames.has(normalized)
        ? `${before}<a href="/users/${normalized}" class="mention">@${username}</a>`
        : match;
    }),
  );
}

export async function resolveMentions(
  prisma: PrismaService,
  html: string,
  authorId: number,
): Promise<{ html: string; mentioned: MentionedUser[] }> {
  const usernames = mentionedUsernames(html);
  if (usernames.length === 0) return { html, mentioned: [] };

  const users = await prisma.user.findMany({
    where: { username: { in: usernames }, ...notBlockedWith(authorId) },
    select: { id: true, username: true },
  });
  return {
    html: linkMentions(html, new Set(users.map(({ username }) => username))),
    mentioned: users.filter(({ id }) => id !== authorId),
  };
}

async function whoCanSee(
  prisma: PrismaService,
  userIds: number[],
  { communityId, wallUserId, onlyUserId }: MentionPlace,
) {
  if (onlyUserId !== undefined) {
    return userIds.filter((id) => id === onlyUserId);
  }

  if (communityId !== null) {
    const community = await prisma.community.findUnique({
      where: { id: communityId },
      select: {
        isPublic: true,
        memberships: {
          where: { userId: { in: userIds } },
          select: { userId: true },
        },
      },
    });
    if (!community) return [];
    if (community.isPublic) return userIds;
    return community.memberships.map(({ userId }) => userId);
  }

  if (wallUserId !== null) {
    const owner = await prisma.user.findUnique({
      where: { id: wallUserId },
      select: { isPublic: true },
    });
    if (!owner) return [];
    if (owner.isPublic) return userIds;
    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: wallUserId, addresseeId: { in: userIds } },
          { addresseeId: wallUserId, requesterId: { in: userIds } },
        ],
      },
      select: { requesterId: true, addresseeId: true },
    });
    const friends = new Set(
      friendships.map(({ requesterId, addresseeId }) =>
        requesterId === wallUserId ? addresseeId : requesterId,
      ),
    );
    return userIds.filter((id) => id === wallUserId || friends.has(id));
  }

  return userIds;
}

export async function notifyMentions(
  prisma: PrismaService,
  notifications: NotificationsService,
  {
    mentioned,
    authorId,
    place,
    message,
    link,
    alreadyNotified = [],
  }: {
    mentioned: MentionedUser[];
    authorId: number;
    place: MentionPlace;
    message: string;
    link: string;
    alreadyNotified?: number[];
  },
) {
  const candidates = mentioned
    .map(({ id }) => id)
    .filter((id) => id !== authorId && !alreadyNotified.includes(id));
  if (candidates.length === 0) return;

  const recipients = await whoCanSee(prisma, candidates, place);
  await notifications.notify(
    recipients.map((userId) => ({
      userId,
      actorId: authorId,
      type: 'mention',
      message,
      link,
    })),
  );
}
