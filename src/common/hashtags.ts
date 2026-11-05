import { PrismaService } from '../prisma.service';
import { filterText } from './mentions';

export const MAX_HASHTAGS = 10;

const TAG_CHAR = '[\\p{L}\\p{M}\\p{N}_]';
const HASHTAG = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{N}_&/])(?<!&amp;)#(${TAG_CHAR}{1,50})(?!${TAG_CHAR})`,
  'gu',
);
const TAG_NAME = new RegExp(`^${TAG_CHAR}{1,50}$`, 'u');
const LETTER = /\p{L}/u;
const LINKED_HASHTAG = /<a\b[^>]*\bhref="\/tags\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

export type ParsedHashtag = { name: string; display: string };

export type HashtagSource =
  | { postId: number }
  | {
      commentId: number;
      targetPostId: number | null;
      targetActivityId: number | null;
    }
  | { forumPostId: number };

export type HashtagUse = { authorId: number; createdAt: Date };

function normalize(typed: string) {
  return typed.normalize('NFC').toLowerCase();
}

export function hashtagName(raw: string) {
  const typed = raw.normalize('NFC');
  if (!TAG_NAME.test(typed) || !LETTER.test(typed)) return null;
  return typed.toLowerCase();
}

export function hashtagsIn(html: string): ParsedHashtag[] {
  const found = new Map<string, string>();
  filterText(html, (text) => {
    for (const [, typed] of text.matchAll(HASHTAG)) {
      const name = normalize(typed);
      if (LETTER.test(typed) && TAG_NAME.test(name) && !found.has(name)) {
        found.set(name, typed.normalize('NFC'));
      }
    }
    return text;
  });
  return [...found]
    .slice(0, MAX_HASHTAGS)
    .map(([name, display]) => ({ name, display }));
}

export function linkHashtags(html: string, names: Set<string>) {
  if (names.size === 0) return html;
  return filterText(html, (text) =>
    text.replace(HASHTAG, (match, typed: string) => {
      const name = normalize(typed);
      return names.has(name)
        ? `<a href="/tags/${encodeURIComponent(name)}" class="hashtag">#${typed}</a>`
        : match;
    }),
  );
}

export function unlinkHashtags(html: string) {
  return html.replace(LINKED_HASHTAG, (_match, text: string) => text);
}

export function resolveHashtags(html: string) {
  const hashtags = hashtagsIn(html);
  return {
    html: linkHashtags(html, new Set(hashtags.map(({ name }) => name))),
    hashtags,
  };
}

function sourceOf(source: HashtagSource) {
  if ('postId' in source) return { postId: source.postId };
  if ('commentId' in source) return { commentId: source.commentId };
  return { forumPostId: source.forumPostId };
}

async function usages(
  prisma: PrismaService,
  source: HashtagSource,
  { authorId, createdAt }: HashtagUse,
  hashtags: ParsedHashtag[],
) {
  const saved = await Promise.all(
    hashtags.map(({ name, display }) =>
      prisma.hashtag.upsert({
        where: { name },
        create: { name, display },
        update: { display },
        select: { id: true },
      }),
    ),
  );
  return saved.map(({ id }) => ({
    hashtagId: id,
    ...source,
    authorId,
    createdAt,
  }));
}

export async function addHashtags(
  prisma: PrismaService,
  source: HashtagSource,
  use: HashtagUse,
  hashtags: ParsedHashtag[],
) {
  if (hashtags.length === 0) return;
  await prisma.hashtagUsage.createMany({
    data: await usages(prisma, source, use, hashtags),
    skipDuplicates: true,
  });
}

export async function replaceHashtags(
  prisma: PrismaService,
  source: HashtagSource,
  use: HashtagUse,
  hashtags: ParsedHashtag[],
) {
  const data = await usages(prisma, source, use, hashtags);
  await prisma.$transaction([
    prisma.hashtagUsage.deleteMany({ where: sourceOf(source) }),
    prisma.hashtagUsage.createMany({ data }),
  ]);
}
