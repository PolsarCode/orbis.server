import { LibraryStatus, MediaType } from '../../prisma/generated/client';
import { webUrl } from '../common/web-url';

export type MessageAuthor = {
  username: string;
  name: string | null;
  nickname?: string | null;
  avatarUrl: string | null;
};

export type MessageCommunity = {
  id: number;
  name: string;
  iconUrl: string | null;
};

export type RenderedMessage = {
  identity: { username: string; avatar_url?: string };
  body: {
    content?: string;
    embeds: object[];
    components: object[];
    allowed_mentions: { parse: string[] };
  };
  threadName: string;
};

const COLOR = 0xc4432d;
const EXCERPT_LENGTH = 500;
const NAME_LENGTH = 80;
const THREAD_NAME_LENGTH = 100;
const BLOCKED_NAME = /discord|clyde/i;
const RESERVED_NAMES = new Set(['everyone', 'here']);
const URL_PATTERN = /(https?:\/\/[^\s<]+)/;

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntity(match: string, entity: string) {
  if (entity.startsWith('#x') || entity.startsWith('#X')) {
    return String.fromCodePoint(parseInt(entity.slice(2), 16));
  }
  if (entity.startsWith('#'))
    return String.fromCodePoint(Number(entity.slice(1)));
  return entities[entity.toLowerCase()] ?? match;
}

export function plainText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|blockquote|pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function excerpt(text: string, length = EXCERPT_LENGTH) {
  return text.length > length
    ? `${text.slice(0, length - 1).trimEnd()}…`
    : text;
}

export function escapeMarkdown(text: string) {
  return text
    .split(URL_PATTERN)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(/[\\*_~`|>#[\]<-]/g, '\\$&'),
    )
    .join('');
}

export function absoluteUrl(url: string | null) {
  if (!url) return undefined;
  const full = url.startsWith('/') ? `${webUrl()}${url}` : url;
  return /^https?:\/\//.test(full) ? full : undefined;
}

function allowedName(value: string | null | undefined) {
  const name = value?.replace(/[@#:`]/g, '').trim();
  if (!name || BLOCKED_NAME.test(name)) return null;
  if (RESERVED_NAMES.has(name.toLowerCase())) return null;
  return name.slice(0, NAME_LENGTH);
}

export function webhookName(author: MessageAuthor) {
  return (
    allowedName(author.nickname) ??
    allowedName(author.name) ??
    allowedName(author.username) ??
    'Orbis'
  );
}

function firstLine(text: string) {
  return (
    text
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? ''
  );
}

function button(link: string, label: string) {
  return {
    type: 1,
    components: [{ type: 2, style: 5, label, url: link }],
  };
}

function footer(community: MessageCommunity) {
  const icon = absoluteUrl(community.iconUrl);
  return {
    text: `Posted in ${community.name} on Orbis`,
    ...(icon && { icon_url: icon }),
  };
}

function fromAuthor(
  author: MessageAuthor,
  community: MessageCommunity,
  link: string,
  embed: object,
  threadName: string,
  content?: string | null,
): RenderedMessage {
  const avatar =
    absoluteUrl(author.avatarUrl) ?? absoluteUrl(community.iconUrl);
  return {
    identity: {
      username: webhookName(author),
      ...(avatar && { avatar_url: avatar }),
    },
    body: {
      ...(content && { content }),
      embeds: [
        { ...embed, url: link, color: COLOR, footer: footer(community) },
      ],
      components: [button(link, 'View more on Orbis')],
      allowed_mentions: { parse: [] },
    },
    threadName: excerpt(threadName, THREAD_NAME_LENGTH),
  };
}

export function postLink(communityId: number, postId: number) {
  return `${webUrl()}/communities/${communityId}?post=${postId}`;
}

export function activityLink(communityId: number, activityId: number) {
  return `${webUrl()}/communities/${communityId}?activity=${activityId}`;
}

export function postMessage(
  post: {
    id: number;
    content: string;
    linkUrl: string | null;
    createdAt: Date;
    author: MessageAuthor;
  },
  community: MessageCommunity,
) {
  const text = plainText(post.content);
  return fromAuthor(
    post.author,
    community,
    postLink(community.id, post.id),
    {
      ...(text && { description: escapeMarkdown(excerpt(text)) }),
      timestamp: post.createdAt.toISOString(),
    },
    firstLine(text) || `Post by ${webhookName(post.author)}`,
    post.linkUrl,
  );
}

function activityWords(
  status: LibraryStatus,
  type: MediaType,
  progress: { from: number; to: number } | null,
): [string, string] {
  if (progress) {
    const verb = type === 'manga' ? 'read' : 'watched';
    const unit = type === 'manga' ? 'chapter' : 'episode';
    const range =
      progress.from === progress.to
        ? `${unit} ${progress.to}`
        : `${unit}s ${progress.from}–${progress.to}`;
    return [`${verb} ${range} of`, ''];
  }
  const verb = { anime: 'watching', manga: 'reading', game: 'playing' }[type];
  const words: Record<LibraryStatus, [string, string]> = {
    current: [`started ${verb}`, ''],
    completed: ['completed', ''],
    on_hold: ['put', 'on hold'],
    dropped: ['dropped', ''],
    planned: [`plans to ${verb.replace(/ing$/, '')}`, ''],
  };
  return words[status];
}

export function activityMessage(
  activity: {
    id: number;
    status: LibraryStatus;
    progressFrom: number | null;
    progressTo: number | null;
    createdAt: Date;
    author: MessageAuthor;
    media: { type: MediaType; title: string; coverImage: string | null };
  },
  community: MessageCommunity,
) {
  const progress =
    activity.progressTo === null
      ? null
      : {
          from: activity.progressFrom ?? activity.progressTo,
          to: activity.progressTo,
        };
  const [before, after] = activityWords(
    activity.status,
    activity.media.type,
    progress,
  );
  const sentence = `${before} **${escapeMarkdown(activity.media.title)}**${after ? ` ${after}` : ''}`;
  const cover = absoluteUrl(activity.media.coverImage);
  return fromAuthor(
    activity.author,
    community,
    activityLink(community.id, activity.id),
    {
      description: `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`,
      ...(cover && { thumbnail: { url: cover } }),
      timestamp: activity.createdAt.toISOString(),
    },
    `${webhookName(activity.author)} ${before} ${activity.media.title}${after ? ` ${after}` : ''}`,
  );
}

export function connectedMessage(community: MessageCommunity): RenderedMessage {
  const link = `${webUrl()}/communities/${community.id}`;
  const icon = absoluteUrl(community.iconUrl) ?? `${webUrl()}/apple-icon`;
  return {
    identity: {
      username: allowedName(community.name) ?? 'Orbis',
      avatar_url: icon,
    },
    body: {
      embeds: [
        {
          title: 'Connected to Orbis',
          url: link,
          description: `New posts and library updates from **${escapeMarkdown(community.name)}** on Orbis will show up here.`,
          color: COLOR,
        },
      ],
      components: [button(link, 'View on Orbis')],
      allowed_mentions: { parse: [] },
    },
    threadName: 'Connected to Orbis',
  };
}
