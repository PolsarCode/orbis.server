import { createInterface } from 'node:readline';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../prisma/generated/client';

const ANILIST_URL = 'https://graphql.anilist.co';
const BATCH_SIZE = 50;
const REQUEST_GAP_MS = 2500;
const SPOTLIGHT_KEY = 'anime-spotlight';

type AniListTitle = {
  id: number;
  idMal: number | null;
  title: {
    romaji: string | null;
    english: string | null;
    native: string | null;
  };
};

type Entry = {
  id: number;
  mediaId: string;
  mediaType: 'anime' | 'manga';
  sourceId: string;
  title: string;
  updatedAt: Date;
  user: { id: number; username: string };
};

type Plan =
  | { action: 'switch'; entry: Entry; malId: number }
  | { action: 'keep'; entry: Entry }
  | { action: 'unmatched'; entry: Entry }
  | { action: 'remove'; entry: Entry; reason: string };

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();

async function ask(question: string) {
  process.stdout.write(question);
  const { value } = await lines.next();
  return typeof value === 'string' ? value.trim() : '';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function lookUp(
  field: 'id_in' | 'idMal_in',
  type: Entry['mediaType'],
  ids: number[],
) {
  const query = `query ($ids: [Int], $type: MediaType) {
    Page(perPage: ${BATCH_SIZE}) {
      media(${field}: $ids, type: $type) { id idMal title { romaji english native } }
    }
  }`;
  for (;;) {
    const response = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { ids, type: type.toUpperCase() },
      }),
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after') ?? 60);
      console.log(`⏳ AniList asked us to wait ${seconds} seconds...`);
      await sleep(seconds * 1000);
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `AniList refused the lookup with ${response.status}: ${await response.text()}`,
      );
    }
    const { data } = (await response.json()) as {
      data: { Page: { media: AniListTitle[] } };
    };
    await sleep(REQUEST_GAP_MS);
    return data.Page.media;
  }
}

async function lookUpAll(
  field: 'id_in' | 'idMal_in',
  type: Entry['mediaType'],
  ids: number[],
) {
  const found = new Map<number, AniListTitle>();
  for (let start = 0; start < ids.length; start += BATCH_SIZE) {
    for (const title of await lookUp(
      field,
      type,
      ids.slice(start, start + BATCH_SIZE),
    )) {
      const key = field === 'id_in' ? title.id : title.idMal;
      if (key !== null) found.set(key, title);
    }
  }
  return found;
}

function sameTitle(media: AniListTitle | undefined, title: string) {
  const wanted = title.trim().toLowerCase();
  return Boolean(
    media &&
    [media.title.romaji, media.title.english, media.title.native].some(
      (name) => name?.trim().toLowerCase() === wanted,
    ),
  );
}

function decide(
  entry: Entry,
  byAniListId: Map<number, AniListTitle>,
  byMalId: Map<number, AniListTitle>,
): Plan {
  const id = Number(entry.sourceId);
  const asAniList = byAniListId.get(id);
  if (sameTitle(asAniList, entry.title)) {
    const malId = asAniList!.idMal;
    if (malId === null) {
      return { action: 'remove', entry, reason: 'no MyAnimeList id' };
    }
    return malId === id
      ? { action: 'keep', entry }
      : { action: 'switch', entry, malId };
  }
  if (sameTitle(byMalId.get(id), entry.title)) return { action: 'keep', entry };
  return { action: 'unmatched', entry };
}

const finalMediaId = (plan: Plan) =>
  plan.action === 'switch'
    ? `${plan.entry.mediaType.toUpperCase()}_${plan.malId}`
    : plan.entry.mediaId;

function removeDuplicates(plans: Plan[]): Plan[] {
  const rank = (plan: Plan) => (plan.action === 'switch' ? 1 : 0);
  const ordered = [...plans].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.entry.updatedAt.getTime() - a.entry.updatedAt.getTime(),
  );
  const claimed = new Set<string>();
  return ordered.map((plan) => {
    if (plan.action === 'remove') return plan;
    const key = `${plan.entry.user.id}:${finalMediaId(plan)}`;
    if (!claimed.has(key)) {
      claimed.add(key);
      return plan;
    }
    return {
      action: 'remove',
      entry: plan.entry,
      reason: 'already in their library under its MyAnimeList id',
    };
  });
}

async function plan(prisma: PrismaClient) {
  const entries = (await prisma.libraryEntry.findMany({
    where: { mediaType: { in: ['anime', 'manga'] } },
    select: {
      id: true,
      mediaId: true,
      mediaType: true,
      sourceId: true,
      title: true,
      updatedAt: true,
      user: { select: { id: true, username: true } },
    },
  })) as Entry[];

  const plans: Plan[] = [];
  for (const type of ['anime', 'manga'] as const) {
    const ofType = entries.filter((entry) => entry.mediaType === type);
    const ids = [
      ...new Set(
        ofType
          .map((entry) => Number(entry.sourceId))
          .filter((id) => Number.isInteger(id) && id > 0),
      ),
    ];
    console.log(`🔎 Looking up ${ids.length} ${type} titles on AniList...`);
    const byAniListId = await lookUpAll('id_in', type, ids);
    const byMalId = await lookUpAll('idMal_in', type, ids);
    plans.push(...ofType.map((entry) => decide(entry, byAniListId, byMalId)));
  }
  return { entries, plans: removeDuplicates(plans) };
}

function describe(plans: Plan[]) {
  const of = <A extends Plan['action']>(action: A) =>
    plans.filter(
      (plan): plan is Extract<Plan, { action: A }> => plan.action === action,
    );
  const line = (plan: Plan) =>
    `     - ${plan.entry.title} (${plan.entry.mediaType} ${plan.entry.sourceId}, @${plan.entry.user.username})`;

  console.log(`\n✅ ${of('switch').length} switch to their MyAnimeList id`);
  console.log(`➖ ${of('keep').length} already use the right id`);
  const removed = of('remove');
  console.log(`🗑️  ${removed.length} will be removed with their updates:`);
  for (const plan of removed) console.log(`${line(plan)}: ${plan.reason}`);
  const unmatched = of('unmatched');
  console.log(
    `⚠️  ${unmatched.length} couldn't be matched on AniList and stay as they are:`,
  );
  for (const plan of unmatched) console.log(line(plan));
  console.log('🔄 The anime spotlight will be rebuilt.\n');
}

async function apply(prisma: PrismaClient, plans: Plan[]) {
  const removed = plans
    .filter((plan) => plan.action === 'remove')
    .map((plan) => plan.entry.id);
  const switched = plans.filter(
    (plan): plan is Extract<Plan, { action: 'switch' }> =>
      plan.action === 'switch',
  );

  await prisma.$transaction(
    async (tx) => {
      const activities = (
        await tx.libraryActivity.findMany({
          where: { entryId: { in: removed } },
          select: { id: true },
        })
      ).map((activity) => activity.id);
      const comments = (
        await tx.comment.findMany({
          where: {
            commentableType: 'activity',
            commentableId: { in: activities },
          },
          select: { id: true },
        })
      ).map((comment) => comment.id);
      await tx.like.deleteMany({
        where: { likeableType: 'comment', likeableId: { in: comments } },
      });
      await tx.comment.deleteMany({ where: { id: { in: comments } } });
      await tx.like.deleteMany({
        where: { likeableType: 'activity', likeableId: { in: activities } },
      });
      await tx.libraryEntry.deleteMany({ where: { id: { in: removed } } });

      for (const { entry } of switched) {
        await tx.libraryEntry.update({
          where: { id: entry.id },
          data: {
            mediaId: `switching_${entry.id}`,
            updatedAt: entry.updatedAt,
          },
        });
      }
      for (const plan of switched) {
        await tx.libraryEntry.update({
          where: { id: plan.entry.id },
          data: {
            mediaId: finalMediaId(plan),
            sourceId: String(plan.malId),
            updatedAt: plan.entry.updatedAt,
          },
        });
      }

      await tx.setting.deleteMany({ where: { key: SPOTLIGHT_KEY } });
    },
    { timeout: 120_000 },
  );
  return { removed: removed.length, switched: switched.length };
}

async function main() {
  console.log(
    'Switches saved anime and manga in Orbis from AniList ids to MyAnimeList ids.',
  );
  console.log('Run it right after the library switch is deployed.\n');
  const url =
    (await ask('Database URL (press Enter to use DATABASE_URL): ')) ||
    process.env.DATABASE_URL ||
    '';
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error('That isn’t a PostgreSQL URL.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  try {
    const { entries, plans } = await plan(prisma);
    console.log(`\nFound ${entries.length} anime and manga entries.`);
    describe(plans);
    if (
      (await ask('Type yes to apply these changes: ')).toLowerCase() !== 'yes'
    ) {
      console.log('Nothing was changed.');
      return;
    }
    const { switched, removed } = await apply(prisma, plans);
    console.log(
      `🎉 Done: switched ${switched} and removed ${removed}. The spotlight rebuilds on its next visit.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch((error: unknown) => {
    console.error(
      `❌ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  })
  .finally(() => process.stdin.destroy());
