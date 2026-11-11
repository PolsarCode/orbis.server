import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '../../prisma/generated/client';
import { HeadAdminGuard } from '../admin/head-admin.guard';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CommunitiesService } from '../communities/communities.service';
import { ChartShareService } from '../library/chart-share.service';
import { LibraryService } from '../library/library.service';
import { PrismaService } from '../prisma.service';
import { TagsService } from '../tags/tags.service';
import { UpdateFacebookPostsDto } from './dto/update-facebook-posts.dto';
import { NOT_SET_UP } from './facebook-page';
import {
  excerpt,
  FACEBOOK_POST_KINDS,
  FacebookPostKind,
  seasonFor,
  seasonTypesDue,
} from './facebook-post-kinds';
import { FacebookPostsController } from './facebook-posts.controller';
import { FacebookPostsService } from './facebook-posts.service';

jest.mock('../common/rich-text', () => ({ sanitizeRichText: jest.fn() }));

const GRAPH = 'https://graph.facebook.com/v27.0/321';
const WEB = 'https://orbis.test';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEKLY: FacebookPostKind[] = [
  'cover',
  'spotlight',
  'debate',
  'most-added',
  'hashtags',
  'community',
  'tip',
];

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function media(type: string, sourceId: string, extra: object = {}) {
  return {
    id: Number(sourceId),
    type,
    sourceId,
    title: `Title ${sourceId}`,
    coverImage: `https://images.test/${sourceId}.jpg`,
    bannerImage: null,
    synopsis: `The story of ${sourceId}.`,
    year: 2026,
    score: 80,
    releaseStatus: null,
    genres: [],
    details: {},
    inLibrary: false,
    entry: null,
    ...extra,
  };
}

const SURVEY_CORPS = {
  id: 12,
  name: 'Survey Corps',
  description: '  We fight titans.  ',
  iconUrl: null,
  coverUrl: null,
  isVerified: false,
  members: 40,
  gained: 5,
  startsAt: '2026-11-07T00:00:00.000Z',
  endsAt: '2026-11-14T00:00:00.000Z',
};

function added(type: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    media: {
      type,
      sourceId: String(index + 1),
      title: `${type} hit ${index + 1}`,
      coverImage: null,
    },
    adds: 10 - index,
  }));
}

describe('Posting weekly and seasonal posts to Facebook', () => {
  type Row = {
    kind: string;
    period: string;
    subject: string | null;
    label: string;
    postId: string | null;
    createdAt: Date;
  };
  type Key = { kind: string; period: string };
  const posts = new Map<string, Row>();
  const settings = new Map<string, string>();
  const keyOf = ({ kind, period }: Key) => `${kind}|${period}`;
  let discussions: { mediaType: string; week: string; commentCount: number }[];
  const lock = { $queryRaw: jest.fn() };
  const prisma = {
    setting: {
      findUnique: jest.fn(async ({ where }: { where: { key: string } }) =>
        settings.has(where.key) ? { value: settings.get(where.key) } : null,
      ),
      upsert: jest.fn(
        async ({ create }: { create: { key: string; value: string } }) => {
          settings.set(create.key, create.value);
        },
      ),
    },
    chartDiscussion: {
      findMany: jest.fn(async ({ where }: { where: { week: string } }) =>
        discussions.filter(({ week }) => week === where.week),
      ),
    },
    facebookPost: {
      findUnique: jest.fn(
        async ({ where }: { where: { kind_period: Key } }) =>
          posts.get(keyOf(where.kind_period)) ?? null,
      ),
      findFirst: jest.fn(
        async ({ where }: { where: { kind: string } }) =>
          [...posts.values()]
            .filter(({ kind }) => kind === where.kind)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ??
          null,
      ),
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: { kind: string; createdAt: { gte: Date } };
        }) =>
          [...posts.values()].filter(
            ({ kind, subject, createdAt }) =>
              kind === where.kind &&
              subject !== null &&
              createdAt >= where.createdAt.gte,
          ),
      ),
      create: jest.fn(
        async ({
          data,
        }: {
          data: Key & { subject: string | null; label: string };
        }) => {
          if (posts.has(keyOf(data))) throw uniqueViolation();
          posts.set(keyOf(data), {
            ...data,
            postId: null,
            createdAt: new Date(Date.now()),
          });
        },
      ),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { kind_period: Key };
          data: { postId: string };
        }) => {
          const key = keyOf(where.kind_period);
          posts.set(key, { ...posts.get(key)!, ...data });
        },
      ),
      deleteMany: jest.fn(async ({ where }: { where: Key }) => {
        posts.delete(keyOf(where));
      }),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { kind_period: Key };
          create: Omit<Row, 'createdAt'>;
          update: Partial<Row>;
        }) => {
          const key = keyOf(where.kind_period);
          const row = posts.get(key);
          posts.set(
            key,
            row
              ? { ...row, ...update }
              : { ...create, createdAt: new Date(Date.now()) },
          );
        },
      ),
    },
    $transaction: jest.fn((work: (tx: typeof lock) => Promise<unknown>) =>
      work(lock),
    ),
  };

  let weeks: Record<string, string>;
  let entries: Record<string, { rank: number; media: object }[]>;
  let seasonSizes: Record<string, number>;
  let addedSizes: Record<string, number>;
  let tagCount: number;
  let tipAnswer: () => object;
  const library = {
    chart: jest.fn(),
    mostAdded: jest.fn(),
    season: jest.fn(),
  };
  const tags = { weekly: jest.fn() };
  const communities = { topGrowing: jest.fn(), weekly: jest.fn() };
  let service: FacebookPostsService;

  const fetchMock = jest.fn();
  const originalFetch = global.fetch;
  const previous = {
    WEB_URL: process.env.WEB_URL,
    FACEBOOK_PAGE_ID: process.env.FACEBOOK_PAGE_ID,
    FACEBOOK_PAGE_TOKEN: process.env.FACEBOOK_PAGE_TOKEN,
  };
  const json = (status: number, body: object) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const png = (status = 200) => ({
    ok: status === 200,
    status,
    headers: new Headers({ 'content-type': 'image/png' }),
    arrayBuffer: async () => new TextEncoder().encode('png-bytes').buffer,
  });
  const refused = json(403, {
    error: { message: '(#200) Permissions error', code: 200 },
  });
  let photoCount = 0;
  const answer = async (url: string, init?: RequestInit) => {
    if (url.startsWith(`${WEB}/facebook/tip?`)) return tipAnswer();
    if (url.startsWith(`${WEB}/facebook/`)) return png();
    if (url === `${GRAPH}/photos`) {
      photoCount += 1;
      const unpublished = (init?.body as FormData).get('published') === 'false';
      return json(
        200,
        unpublished
          ? { id: `photo-${photoCount}` }
          : { id: `photo-${photoCount}`, post_id: `321_90${photoCount}` },
      );
    }
    if (url === GRAPH) return json(200, { success: true });
    throw new Error(`Unexpected request to ${url}`);
  };
  const failing = (
    match: (url: string) => boolean,
    reply: () => object | Promise<object>,
  ) =>
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      match(url) ? reply() : answer(url, init),
    );

  const photoCalls = () =>
    fetchMock.mock.calls.filter(([url]) => url === `${GRAPH}/photos`);
  const photoForm = (index = 0) => photoCalls()[index][1].body as FormData;
  const messages = () =>
    photoCalls().map(([, init]) => (init.body as FormData).get('message'));
  const imageUrls = () =>
    fetchMock.mock.calls
      .map(([url]) => url as string)
      .filter(
        (url) => url.startsWith(`${WEB}/facebook/`) && url.includes('/image'),
      );
  const coverCalls = () =>
    fetchMock.mock.calls.filter(([url]) => url === GRAPH);
  const rows = () =>
    [...posts.values()].map(({ kind, period, subject, label, postId }) => ({
      kind,
      period,
      subject,
      label,
      postId,
    }));
  const periods = () =>
    [...posts.values()].map(({ kind, period }) => `${kind}|${period}`);
  const at = (iso: string) =>
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(iso));
  const turnOn = (...kinds: FacebookPostKind[]) => {
    for (const kind of kinds) settings.set(`facebook.posts.${kind}`, 'true');
  };
  const addPost = (row: Partial<Row> & Key & { createdAt: Date }) =>
    posts.set(keyOf(row), {
      subject: null,
      label: 'Earlier',
      postId: '321_800',
      ...row,
    });
  const controller = () => new FacebookPostsController(service);

  beforeAll(() => {
    process.env.WEB_URL = WEB;
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    Object.assign(process.env, previous);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
    }
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    posts.clear();
    settings.clear();
    photoCount = 0;
    discussions = [];
    weeks = { anime: '2026-W46', manga: '2026-W46', game: '2026-W46' };
    entries = {
      anime: [{ rank: 1, media: media('anime', '1') }],
      manga: [{ rank: 1, media: media('manga', '11') }],
      game: [{ rank: 1, media: media('game', '21') }],
    };
    seasonSizes = { anime: 5, manga: 5, game: 5 };
    addedSizes = { anime: 3, manga: 3, game: 3 };
    tagCount = 3;
    tipAnswer = () =>
      json(200, {
        id: 'bookmarks',
        title: 'Save posts for later',
        body: 'Choose Save post in a post’s menu to keep it.',
        href: '/?tab=bookmarks',
      });
    process.env.FACEBOOK_PAGE_ID = '321';
    process.env.FACEBOOK_PAGE_TOKEN = 'page-token';
    lock.$queryRaw.mockResolvedValue([{ locked: true }]);
    library.chart.mockImplementation(async (_user: number, type: string) => ({
      type,
      week: weeks[type],
      startsAt: '2026-11-09T00:00:00.000Z',
      endsAt: '2026-11-16T00:00:00.000Z',
      previousWeek: '2026-W45',
      nextWeek: null,
      entries: entries[type],
      updatedAt: '2026-11-09T00:05:00.000Z',
    }));
    library.mostAdded.mockImplementation(async (type: string) => ({
      startsAt: '2026-11-05T00:00:00.000Z',
      endsAt: '2026-11-12T00:00:00.000Z',
      items: added(type, addedSizes[type]),
    }));
    library.season.mockImplementation(
      async (_user: number, type: string, season: string) => ({
        type,
        season: season.slice(5),
        year: Number(season.slice(0, 4)),
        startsAt: '2026-10-01T00:00:00.000Z',
        endsAt: '2027-01-01T00:00:00.000Z',
        items: Array.from({ length: seasonSizes[type] }, (_, index) =>
          media(type, String(index + 1)),
        ),
      }),
    );
    tags.weekly.mockImplementation(async () => ({
      startsAt: '2026-11-06T00:00:00.000Z',
      endsAt: '2026-11-13T00:00:00.000Z',
      tags: [
        { name: 'frieren', display: 'Frieren', people: 9 },
        { name: 'onepiece', display: 'OnePiece', people: 7 },
        { name: 'eldenring', display: 'EldenRing', people: 4 },
        { name: 'chainsawman', display: 'ChainsawMan', people: 3 },
      ].slice(0, tagCount),
    }));
    communities.topGrowing.mockResolvedValue({ id: 12, gained: 5 });
    communities.weekly.mockResolvedValue(SURVEY_CORPS);
    fetchMock.mockImplementation(answer);
    service = new FacebookPostsService(
      prisma as unknown as PrismaService,
      new ChartShareService(library as unknown as LibraryService),
      library as unknown as LibraryService,
      tags as unknown as TagsService,
      communities as unknown as CommunitiesService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('starts with every kind switched off', async () => {
    at('2026-11-09T08:00:00.000Z');

    await service.run();

    expect(library.chart).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.facebookPost.create).not.toHaveBeenCalled();
  });

  it.each([
    ['2026-11-09', 'cover'],
    ['2026-11-10', 'spotlight'],
    ['2026-11-11', 'debate'],
    ['2026-11-12', 'most-added'],
    ['2026-11-13', 'hashtags'],
    ['2026-11-14', 'community'],
    ['2026-11-15', 'tip'],
  ])(
    'on %s posts only the %s post, once, from 04:00 UTC',
    async (day, kind) => {
      turnOn(...WEEKLY);
      discussions = [{ mediaType: 'anime', week: '2026-W46', commentCount: 3 }];

      at(`${day}T03:59:59.999Z`);
      await service.run();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(posts.size).toBe(0);

      at(`${day}T04:00:00.000Z`);
      await service.run();
      at(`${day}T23:59:00.000Z`);
      await service.run();

      expect(periods()).toEqual([`${kind}|2026-W46`]);
      expect(kind === 'cover' ? coverCalls() : photoCalls()).toHaveLength(1);
    },
  );

  it('does nothing until the Page is set up', async () => {
    delete process.env.FACEBOOK_PAGE_TOKEN;
    turnOn(...WEEKLY);
    at('2026-11-09T08:00:00.000Z');

    await service.run();

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(service.sendNow('cover')).rejects.toThrow(
      new BadRequestException(NOT_SET_UP),
    );
  });

  it('does nothing while another server is posting', async () => {
    lock.$queryRaw.mockResolvedValue([{ locked: false }]);
    turnOn('cover');
    at('2026-11-09T08:00:00.000Z');

    await service.run();

    expect(library.chart).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('the Page cover', () => {
    beforeEach(() => {
      turnOn('cover');
      at('2026-11-09T04:10:00.000Z');
    });

    it('uploads the image without a feed post, then sets it as the cover quietly', async () => {
      await service.run();

      expect(imageUrls()).toEqual([
        `${WEB}/facebook/cover/image?week=2026-W46`,
      ]);
      expect(photoCalls()).toHaveLength(1);
      const form = photoForm();
      expect(form.get('published')).toBe('false');
      expect(form.get('message')).toBeNull();
      expect(form.get('access_token')).toBe('page-token');
      expect((form.get('source') as File).name).toBe(
        'orbis-cover-2026-W46.png',
      );
      expect(await (form.get('source') as File).text()).toBe('png-bytes');

      expect(coverCalls()).toHaveLength(1);
      const [, init] = coverCalls()[0];
      expect(init.method).toBe('POST');
      expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
        cover: 'photo-1',
        no_feed_story: 'true',
        no_notification: 'true',
        access_token: 'page-token',
      });
      const order = fetchMock.mock.calls.map(([url]) => url);
      expect(order.indexOf(`${GRAPH}/photos`)).toBeLessThan(
        order.indexOf(GRAPH),
      );
      expect(rows()).toEqual([
        {
          kind: 'cover',
          period: '2026-W46',
          subject: null,
          label: 'Trending · Nov 9 – Nov 15, 2026',
          postId: 'photo-1',
        },
      ]);
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes('page-token'),
        ),
      ).toBe(false);
    });

    it('waits for all three charts', async () => {
      const chart = library.chart.getMockImplementation()!;
      library.chart.mockImplementation(async (user: number, type: string) => {
        if (type === 'manga') throw new Error('Library unavailable');
        return chart(user, type);
      });

      await service.run();

      expect(fetchMock).not.toHaveBeenCalled();

      library.chart.mockImplementation(chart);
      weeks.game = '2026-W45';
      await service.run();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(posts.size).toBe(0);

      weeks.game = '2026-W46';
      await service.run();

      expect(coverCalls()).toHaveLength(1);
    });

    it('tries again when Facebook refuses the upload', async () => {
      failing(
        (url) => url === `${GRAPH}/photos`,
        () => refused,
      );

      await service.run();

      expect(posts.size).toBe(0);
      expect(coverCalls()).toHaveLength(0);

      fetchMock.mockImplementation(answer);
      await service.run();

      expect(photoCalls()).toHaveLength(2);
      expect(coverCalls()).toHaveLength(1);
      expect(posts.get('cover|2026-W46')?.postId).toBe('photo-1');
    });

    it('doesn’t upload again when Facebook refuses to set the uploaded cover', async () => {
      failing(
        (url) => url === GRAPH,
        () => refused,
      );

      await service.run();
      await service.run();

      expect(photoCalls()).toHaveLength(1);
      expect(coverCalls()).toHaveLength(1);
      expect(posts.get('cover|2026-W46')?.postId).toBeNull();
    });

    it('keeps the claim when Facebook doesn’t confirm the cover', async () => {
      failing(
        (url) => url === GRAPH,
        () => json(200, { success: false }),
      );

      await service.run();
      await service.run();

      expect(coverCalls()).toHaveLength(1);
      expect(posts.get('cover|2026-W46')?.postId).toBeNull();
    });
  });

  describe('the spotlight', () => {
    beforeEach(() => {
      turnOn('spotlight');
      at('2026-11-10T05:00:00.000Z');
    });

    it('picks the highest-ranked title with a synopsis and an image that wasn’t in the spotlight for 26 weeks', async () => {
      entries.manga = [
        { rank: 4, media: media('manga', '104', { synopsis: 'Fourth.' }) },
        { rank: 1, media: media('manga', '101', { synopsis: '  ' }) },
        {
          rank: 2,
          media: media('manga', '102', { coverImage: null, bannerImage: null }),
        },
        { rank: 3, media: media('manga', '103') },
        { rank: 5, media: media('manga', '105') },
      ];
      addPost({
        kind: 'spotlight',
        period: '2026-W36',
        subject: 'manga:103',
        createdAt: new Date(
          Date.parse('2026-11-10T05:00:00.000Z') - 10 * WEEK_MS,
        ),
      });
      addPost({
        kind: 'spotlight',
        period: '2026-W19',
        subject: 'manga:104',
        createdAt: new Date(
          Date.parse('2026-11-10T05:00:00.000Z') - 27 * WEEK_MS,
        ),
      });

      await service.run();

      expect(library.chart).toHaveBeenCalledWith(0, 'manga');
      expect(imageUrls()).toEqual([
        `${WEB}/facebook/spotlight/manga/104/image`,
      ]);
      expect(messages()).toEqual([
        'Manga spotlight: Title 104\n\nFourth.\n\n' +
          'See it on Orbis: https://orbis.test/library/manga/104',
      ]);
      expect((photoForm().get('source') as File).name).toBe(
        'orbis-spotlight-2026-W46.png',
      );
      expect(posts.get('spotlight|2026-W46')).toMatchObject({
        subject: 'manga:104',
        label: 'Title 104',
        postId: '321_901',
      });
    });

    it('trims a long synopsis at a word', async () => {
      entries.manga = [
        {
          rank: 1,
          media: media('manga', '101', {
            synopsis: `${'word '.repeat(30)}\n\n${'word '.repeat(30)}`,
          }),
        },
      ];

      await service.run();

      expect(messages()[0]).toBe(
        `Manga spotlight: Title 101\n\n${Array(44).fill('word').join(' ')}…\n\n` +
          'See it on Orbis: https://orbis.test/library/manga/101',
      );
    });

    it.each([
      ['2026-W45', 'anime'],
      ['2026-W46', 'manga'],
      ['2026-W47', 'game'],
    ])('in %s spotlights %s', async (week, type) => {
      weeks.anime = week;

      await service.run();

      expect(library.chart).toHaveBeenLastCalledWith(0, type);
      expect(posts.get(`spotlight|${week}`)?.subject).toMatch(
        new RegExp(`^${type}:`),
      );
    });

    it('skips the week when everything has been in the spotlight lately', async () => {
      addPost({
        kind: 'spotlight',
        period: '2026-W40',
        subject: 'manga:11',
        createdAt: new Date('2026-10-01T05:00:00.000Z'),
      });

      await service.run();

      expect(photoCalls()).toHaveLength(0);
      expect(posts.has('spotlight|2026-W46')).toBe(false);
    });
  });

  describe('the chart debate', () => {
    beforeEach(() => {
      turnOn('debate');
      at('2026-11-11T04:00:00.000Z');
    });

    it('posts the chart with the most comments this week, choosing anime, then manga on a tie', async () => {
      discussions = [
        { mediaType: 'anime', week: '2026-W46', commentCount: 2 },
        { mediaType: 'manga', week: '2026-W46', commentCount: 5 },
        { mediaType: 'game', week: '2026-W46', commentCount: 5 },
        { mediaType: 'anime', week: '2026-W45', commentCount: 50 },
      ];

      await service.run();

      expect(imageUrls()).toEqual([
        `${WEB}/facebook/debate/manga/image?week=2026-W46`,
      ]);
      expect(messages()).toEqual([
        '5 comments on this week’s manga chart so far. Does #1 deserve it?\n\n' +
          'Join the debate: https://orbis.test/c/775',
      ]);
      expect(posts.get('debate|2026-W46')).toMatchObject({
        label: 'Manga chart · 5 comments',
        postId: '321_901',
      });
    });

    it('prefers anime when it ties for the most comments', async () => {
      discussions = [
        { mediaType: 'anime', week: '2026-W46', commentCount: 4 },
        { mediaType: 'game', week: '2026-W46', commentCount: 4 },
      ];

      await service.run();

      expect(imageUrls()).toEqual([
        `${WEB}/facebook/debate/anime/image?week=2026-W46`,
      ]);
    });

    it('waits for 3 comments', async () => {
      discussions = [
        { mediaType: 'anime', week: '2026-W46', commentCount: 2 },
        { mediaType: 'manga', week: '2026-W46', commentCount: 2 },
      ];

      await service.run();

      expect(photoCalls()).toHaveLength(0);

      discussions[1].commentCount = 3;
      await service.run();

      expect(photoCalls()).toHaveLength(1);
    });

    it('posts once, even when another server claims it first', async () => {
      discussions = [{ mediaType: 'game', week: '2026-W46', commentCount: 3 }];
      prisma.facebookPost.create.mockRejectedValueOnce(uniqueViolation());

      await service.run();

      expect(photoCalls()).toHaveLength(0);
    });

    it('tries again on the next run when Facebook refuses', async () => {
      discussions = [{ mediaType: 'game', week: '2026-W46', commentCount: 3 }];
      failing(
        (url) => url === `${GRAPH}/photos`,
        () => refused,
      );

      await service.run();

      expect(posts.size).toBe(0);

      fetchMock.mockImplementation(answer);
      await service.run();

      expect(photoCalls()).toHaveLength(2);
      expect(posts.get('debate|2026-W46')?.postId).toBe('321_901');
    });

    it('never posts twice when Facebook doesn’t answer clearly', async () => {
      discussions = [{ mediaType: 'game', week: '2026-W46', commentCount: 3 }];
      failing(
        (url) => url === `${GRAPH}/photos`,
        () => json(502, {}),
      );

      await service.run();
      fetchMock.mockImplementation(answer);
      await service.run();

      expect(photoCalls()).toHaveLength(1);
      expect(posts.get('debate|2026-W46')?.postId).toBeNull();
    });

    it('tries again later when the image can’t be made', async () => {
      discussions = [{ mediaType: 'game', week: '2026-W46', commentCount: 3 }];
      failing(
        (url) => url.includes('/image'),
        () => png(502),
      );

      await service.run();

      expect(photoCalls()).toHaveLength(0);
      expect(posts.size).toBe(0);
    });
  });

  describe('the most added', () => {
    beforeEach(() => {
      turnOn('most-added');
      at('2026-11-12T09:00:00.000Z');
    });

    it('starts with this week’s type and moves on to the next one with 3 titles', async () => {
      addedSizes.manga = 2;
      addedSizes.game = 5;

      await service.run();

      const until = new Date('2026-11-12T00:00:00.000Z');
      expect(library.mostAdded.mock.calls).toEqual([
        ['manga', until],
        ['game', until],
      ]);
      expect(imageUrls()).toEqual([
        `${WEB}/facebook/most-added/game/image?until=2026-11-12`,
      ]);
      expect(messages()).toEqual([
        'The most added games on Orbis this week:\n' +
          '1. game hit 1\n2. game hit 2\n3. game hit 3\n\n' +
          'Keep track of yours: https://orbis.test/library?tab=discover&type=game',
      ]);
      expect(posts.get('most-added|2026-W46')?.label).toBe('Most added games');
    });

    it('wraps around to anime', async () => {
      addedSizes = { anime: 3, manga: 0, game: 1 };

      await service.run();

      expect(messages()[0]).toMatch(
        /Keep track of yours: https:\/\/orbis\.test\/library\?tab=discover$/,
      );
      expect(imageUrls()).toEqual([
        `${WEB}/facebook/most-added/anime/image?until=2026-11-12`,
      ]);
    });

    it('skips the week when no type has 3 titles', async () => {
      addedSizes = { anime: 2, manga: 2, game: 2 };

      await service.run();

      expect(photoCalls()).toHaveLength(0);
    });
  });

  describe('the trending hashtags', () => {
    beforeEach(() => {
      turnOn('hashtags');
      at('2026-11-13T04:30:00.000Z');
    });

    it('lists the week’s hashtags and links to the top one', async () => {
      tagCount = 4;

      await service.run();

      expect(tags.weekly).toHaveBeenCalledWith(
        new Date('2026-11-13T00:00:00.000Z'),
      );
      expect(imageUrls()).toEqual([
        `${WEB}/facebook/hashtags/image?until=2026-11-13`,
      ]);
      expect(messages()).toEqual([
        'Trending on Orbis this week: #Frieren, #OnePiece, #EldenRing, #ChainsawMan\n\n' +
          'https://orbis.test/tags/frieren',
      ]);
      expect(posts.get('hashtags|2026-W46')?.label).toBe('#Frieren');
    });

    it('waits for 3 hashtags', async () => {
      tagCount = 2;

      await service.run();

      expect(photoCalls()).toHaveLength(0);
    });
  });

  describe('the community of the week', () => {
    beforeEach(() => {
      turnOn('community');
      at('2026-11-14T06:00:00.000Z');
    });

    it('features the fastest-growing community that wasn’t featured in the last 8 weeks', async () => {
      const now = Date.parse('2026-11-14T06:00:00.000Z');
      addPost({
        kind: 'community',
        period: '2026-W43',
        subject: '7',
        createdAt: new Date(now - 3 * WEEK_MS),
      });
      addPost({
        kind: 'community',
        period: '2026-W37',
        subject: '9',
        createdAt: new Date(now - 9 * WEEK_MS),
      });
      addPost({
        kind: 'spotlight',
        period: '2026-W45',
        subject: '8',
        createdAt: new Date(now - WEEK_MS),
      });

      await service.run();

      const until = new Date('2026-11-14T00:00:00.000Z');
      expect(communities.topGrowing).toHaveBeenCalledWith(until, [7]);
      expect(communities.weekly).toHaveBeenCalledWith(12, until);
      expect(imageUrls()).toEqual([
        `${WEB}/facebook/community/12/image?until=2026-11-14`,
      ]);
      expect(messages()).toEqual([
        'Community of the week: Survey Corps!\n\nWe fight titans.\n\n' +
          'Join them on Orbis: https://orbis.test/communities/12',
      ]);
      expect(posts.get('community|2026-W46')).toMatchObject({
        subject: '12',
        label: 'Survey Corps',
      });
    });

    it('leaves out a missing description', async () => {
      communities.weekly.mockResolvedValue({
        ...SURVEY_CORPS,
        description: null,
      });

      await service.run();

      expect(messages()).toEqual([
        'Community of the week: Survey Corps!\n\n' +
          'Join them on Orbis: https://orbis.test/communities/12',
      ]);
    });

    it.each([
      ['no community grew', null],
      ['the top one gained fewer than 3 members', { id: 12, gained: 2 }],
    ])('skips the week when %s', async (_case, top) => {
      communities.topGrowing.mockResolvedValue(top);

      await service.run();

      expect(communities.weekly).not.toHaveBeenCalled();
      expect(photoCalls()).toHaveLength(0);
    });
  });

  describe('the tip of the week', () => {
    beforeEach(() => {
      turnOn('tip');
      at('2026-11-15T04:00:00.000Z');
    });

    it('posts the website’s tip for the week', async () => {
      await service.run();

      expect(fetchMock.mock.calls[0][0]).toBe(
        `${WEB}/facebook/tip?week=2026-W46`,
      );
      expect(imageUrls()).toEqual([`${WEB}/facebook/tip/image?week=2026-W46`]);
      expect(messages()).toEqual([
        'Tip of the week: Save posts for later\n\n' +
          'Choose Save post in a post’s menu to keep it.\n\n' +
          'https://orbis.test/?tab=bookmarks',
      ]);
      expect(posts.get('tip|2026-W46')).toMatchObject({
        subject: 'bookmarks',
        label: 'Save posts for later',
      });
    });

    it('links to Orbis when the tip has no link', async () => {
      tipAnswer = () =>
        json(200, {
          id: 'spoilers',
          title: 'Hide spoilers',
          body: 'Use the eye.',
          href: null,
        });

      await service.run();

      expect(messages()).toEqual([
        'Tip of the week: Hide spoilers\n\nUse the eye.\n\nhttps://orbis.test',
      ]);
    });

    it('tries again later when the website doesn’t answer', async () => {
      tipAnswer = () => json(500, {});

      await service.run();

      expect(photoCalls()).toHaveLength(0);

      tipAnswer = () =>
        json(200, {
          id: 'spoilers',
          title: 'Hide spoilers',
          body: 'Use the eye.',
          href: null,
        });
      await service.run();

      expect(photoCalls()).toHaveLength(1);
    });
  });

  describe('seasons', () => {
    it.each([
      ['2026-10-01T04:00:00.000Z', ['anime']],
      ['2026-10-02T12:00:00.000Z', ['manga']],
      ['2026-10-03T23:59:00.000Z', ['game']],
      ['2027-01-01T04:00:00.000Z', ['anime']],
      ['2027-04-02T04:00:00.000Z', ['manga']],
      ['2027-07-03T04:00:00.000Z', ['game']],
      ['2026-10-01T03:59:00.000Z', []],
      ['2026-10-04T04:00:00.000Z', []],
      ['2026-09-30T04:00:00.000Z', []],
    ])('on %s the new season is due for %p', (iso, types) => {
      expect(seasonTypesDue('season', new Date(iso))).toEqual(types);
    });

    it.each([
      ['2026-12-18T04:00:00.000Z', ['anime']],
      ['2026-12-19T04:00:00.000Z', ['game']],
      ['2026-12-20T04:00:00.000Z', ['manga']],
      ['2027-03-18T04:00:00.000Z', ['anime']],
      ['2027-09-17T04:00:00.000Z', ['anime']],
      ['2026-12-18T03:00:00.000Z', []],
      ['2026-12-17T04:00:00.000Z', []],
      ['2026-12-21T04:00:00.000Z', []],
    ])('on %s the coming season is due for %p', (iso, types) => {
      expect(seasonTypesDue('coming', new Date(iso))).toEqual(types);
    });

    it.each([
      ['season', '2026-03-31T12:00:00.000Z', '2026-winter', 'Winter 2026'],
      ['season', '2026-11-11T12:00:00.000Z', '2026-fall', 'Fall 2026'],
      ['coming', '2026-11-11T12:00:00.000Z', '2027-winter', 'Winter 2027'],
      ['coming', '2026-05-01T12:00:00.000Z', '2026-summer', 'Summer 2026'],
    ] as const)('the %s on %s is %s', (kind, iso, id, title) => {
      expect(seasonFor(kind, new Date(iso))).toMatchObject({ id, title });
    });

    it('posts each type on its own day of the new season', async () => {
      turnOn('season');

      for (const day of ['01', '02', '03', '04']) {
        at(`2026-10-${day}T04:00:00.000Z`);
        await service.run();
      }

      expect(library.season.mock.calls).toEqual([
        [0, 'anime', '2026-fall'],
        [0, 'manga', '2026-fall'],
        [0, 'game', '2026-fall'],
      ]);
      expect(imageUrls()).toEqual([
        `${WEB}/facebook/season/anime/image?season=2026-fall`,
        `${WEB}/facebook/season/manga/image?season=2026-fall`,
        `${WEB}/facebook/season/game/image?season=2026-fall`,
      ]);
      expect(messages()).toEqual([
        'Fall 2026 anime is here! The most popular new shows this season.\n\n' +
          'Find them on Orbis: https://orbis.test/library?tab=discover',
        'Fall 2026 manga is here! The most popular new manga this season.\n\n' +
          'Find them on Orbis: https://orbis.test/library?tab=discover&type=manga',
        'Fall 2026 games are here! The most popular games out this season.\n\n' +
          'Find them on Orbis: https://orbis.test/library?tab=discover&type=game',
      ]);
      expect(rows().map(({ period, label }) => [period, label])).toEqual([
        ['2026-fall:anime', 'Fall 2026 anime'],
        ['2026-fall:manga', 'Fall 2026 manga'],
        ['2026-fall:game', 'Fall 2026 games'],
      ]);
      expect((photoForm().get('source') as File).name).toBe(
        'orbis-season-2026-fall-anime.png',
      );
    });

    it('skips a new season with fewer than 4 titles', async () => {
      turnOn('season');
      seasonSizes.anime = 3;
      at('2027-01-01T04:00:00.000Z');

      await service.run();

      expect(library.season).toHaveBeenCalledWith(0, 'anime', '2027-winter');
      expect(photoCalls()).toHaveLength(0);
    });

    it('announces the next season two weeks ahead, into the next year', async () => {
      turnOn('coming');

      for (const day of ['17', '18', '19', '20', '21']) {
        at(`2026-12-${day}T04:00:00.000Z`);
        await service.run();
      }

      expect(periods()).toEqual([
        'coming|2027-winter:anime',
        'coming|2027-winter:game',
        'coming|2027-winter:manga',
      ]);
      expect(imageUrls()[0]).toBe(
        `${WEB}/facebook/season/anime/image?season=2027-winter`,
      );
      expect(messages()).toEqual([
        'Coming in Winter 2027: the anime everyone’s waiting for.\n\n' +
          'Get ready on Orbis: https://orbis.test/library?tab=discover',
        'Coming in Winter 2027: the games everyone’s waiting for.\n\n' +
          'Get ready on Orbis: https://orbis.test/library?tab=discover&type=game',
        'Coming in Winter 2027: the manga everyone’s waiting for.\n\n' +
          'Get ready on Orbis: https://orbis.test/library?tab=discover&type=manga',
      ]);
      expect(posts.get('coming|2027-winter:anime')?.label).toBe(
        'Winter 2027 anime',
      );
    });

    it('skips a coming season with fewer than 3 titles', async () => {
      turnOn('coming');
      seasonSizes.anime = 2;
      at('2026-12-18T04:00:00.000Z');

      await service.run();

      expect(photoCalls()).toHaveLength(0);
    });
  });

  it('trims text at a word without cutting it mid-word', () => {
    expect(excerpt('  A short\n\nsynopsis.  ')).toBe('A short synopsis.');
    const trimmed = excerpt(`${'a'.repeat(215)} bcdefghij, klm`);
    expect(trimmed).toBe(`${'a'.repeat(215)}…`);
    expect(excerpt(`${'b'.repeat(214)}, cdefgh ijk`)).toBe(
      `${'b'.repeat(214)}…`,
    );
  });

  describe('Post now', () => {
    it('posts this week’s pick right away and keeps the scheduled run from posting it again', async () => {
      turnOn('spotlight');
      at('2026-11-09T10:00:00.000Z');

      await expect(service.sendNow('spotlight')).resolves.toEqual({
        postIds: ['321_901'],
      });
      expect(posts.get('spotlight|2026-W46')).toMatchObject({
        subject: 'manga:11',
        postId: '321_901',
      });

      at('2026-11-10T04:00:00.000Z');
      await service.run();

      expect(photoCalls()).toHaveLength(1);
    });

    it('posts something new when this week’s post already went out', async () => {
      entries.manga = [
        { rank: 1, media: media('manga', '11') },
        { rank: 2, media: media('manga', '12') },
      ];
      addPost({
        kind: 'spotlight',
        period: '2026-W46',
        subject: 'manga:11',
        createdAt: new Date('2026-11-10T04:00:00.000Z'),
      });
      at('2026-11-10T10:00:00.000Z');

      await service.sendNow('spotlight');

      expect(posts.get('spotlight|2026-W46')).toMatchObject({
        subject: 'manga:12',
        label: 'Title 12',
        postId: '321_901',
        createdAt: new Date('2026-11-10T10:00:00.000Z'),
      });
    });

    it('changes the cover without a feed post', async () => {
      at('2026-11-12T10:00:00.000Z');

      await expect(service.sendNow('cover')).resolves.toEqual({
        postIds: ['photo-1'],
      });
      expect(photoForm().get('published')).toBe('false');
      expect(coverCalls()).toHaveLength(1);
      expect(posts.get('cover|2026-W46')?.postId).toBe('photo-1');
    });

    it('posts every type with enough titles this season', async () => {
      seasonSizes.manga = 3;
      at('2026-11-11T10:00:00.000Z');

      await expect(service.sendNow('season')).resolves.toEqual({
        postIds: ['321_901', '321_902'],
      });
      expect(periods()).toEqual([
        'season|2026-fall:anime',
        'season|2026-fall:game',
      ]);
    });

    it('posts next season for what’s coming', async () => {
      at('2026-11-11T10:00:00.000Z');

      await expect(service.sendNow('coming')).resolves.toEqual({
        postIds: ['321_901', '321_902', '321_903'],
      });
      expect(periods()).toEqual([
        'coming|2027-winter:anime',
        'coming|2027-winter:manga',
        'coming|2027-winter:game',
      ]);
    });

    it.each([
      ['debate', 'This week’s charts don’t have 3 comments yet'],
      ['hashtags', 'Fewer than 3 hashtags were used this week'],
    ] as const)(
      'explains when there’s no %s to post',
      async (kind, message) => {
        tagCount = 2;
        at('2026-11-11T10:00:00.000Z');

        await expect(service.sendNow(kind)).rejects.toThrow(
          new BadRequestException(message),
        );
        expect(photoCalls()).toHaveLength(0);
      },
    );

    it('says when no season type has enough titles', async () => {
      seasonSizes = { anime: 3, manga: 1, game: 0 };
      at('2026-11-11T10:00:00.000Z');

      await expect(service.sendNow('season')).rejects.toThrow(
        new BadRequestException(
          'This season doesn’t have enough titles to post yet',
        ),
      );
    });

    it('passes on what Facebook said without saving the post', async () => {
      failing(
        (url) => url === `${GRAPH}/photos`,
        () => refused,
      );
      at('2026-11-11T10:00:00.000Z');

      await expect(service.sendNow('hashtags')).rejects.toThrow(
        new BadGatewayException('Facebook said: (#200) Permissions error'),
      );
      expect(posts.size).toBe(0);
    });

    it('says which types went out before something failed', async () => {
      failing(
        (url) => url === `${GRAPH}/photos` && photoCount >= 1,
        () => refused,
      );
      at('2026-11-11T10:00:00.000Z');

      await expect(service.sendNow('season')).rejects.toThrow(
        new BadGatewayException(
          'Posted Anime, then Facebook said: (#200) Permissions error',
        ),
      );
    });

    it('keeps an unclear post so the scheduled one doesn’t go out too', async () => {
      turnOn('spotlight');
      failing(
        (url) => url === `${GRAPH}/photos`,
        () => json(502, {}),
      );
      at('2026-11-09T10:00:00.000Z');

      await expect(service.sendNow('spotlight')).rejects.toThrow(
        new BadGatewayException(
          'Facebook didn’t answer. Check the Page before trying again, in case it was posted',
        ),
      );
      expect(posts.get('spotlight|2026-W46')?.postId).toBeNull();

      fetchMock.mockImplementation(answer);
      at('2026-11-10T04:00:00.000Z');
      await service.run();

      expect(photoCalls()).toHaveLength(1);
    });

    it('says so when the image can’t be made', async () => {
      failing(
        (url) => url.includes('/image'),
        () => png(502),
      );
      at('2026-11-11T10:00:00.000Z');

      await expect(service.sendNow('tip')).rejects.toThrow(
        new BadGatewayException(
          'Couldn’t make the image for this post. Try again in a moment',
        ),
      );
      expect(photoCalls()).toHaveLength(0);
    });

    it('says so when the post can’t be put together', async () => {
      tipAnswer = () => json(500, {});
      at('2026-11-11T10:00:00.000Z');

      await expect(service.sendNow('tip')).rejects.toThrow(
        new BadGatewayException(
          'Couldn’t get this post ready. Try again in a moment',
        ),
      );
    });
  });

  describe('the admin settings', () => {
    it('lists every kind in order with its switch and newest post', async () => {
      settings.set('facebook.posts.spotlight', 'true');
      addPost({
        kind: 'cover',
        period: '2026-W45',
        label: 'Trending · Nov 2 – Nov 8, 2026',
        createdAt: new Date('2026-11-02T04:00:00.000Z'),
      });
      addPost({
        kind: 'cover',
        period: '2026-W46',
        label: 'Trending · Nov 9 – Nov 15, 2026',
        postId: 'photo-9',
        createdAt: new Date('2026-11-09T04:00:00.000Z'),
      });

      const status = await controller().status();

      expect(status.configured).toBe(true);
      expect(status.posts.map(({ kind }) => kind)).toEqual([
        'cover',
        'spotlight',
        'debate',
        'most-added',
        'hashtags',
        'community',
        'tip',
        'season',
        'coming',
      ]);
      expect(status.posts.map(({ kind }) => kind)).toEqual([
        ...FACEBOOK_POST_KINDS,
      ]);
      expect(status.posts[0]).toEqual({
        kind: 'cover',
        enabled: false,
        lastPost: {
          period: '2026-W46',
          label: 'Trending · Nov 9 – Nov 15, 2026',
          postId: 'photo-9',
          postedAt: '2026-11-09T04:00:00.000Z',
        },
      });
      expect(status.posts[1]).toEqual({
        kind: 'spotlight',
        enabled: true,
        lastPost: null,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('says when Facebook isn’t set up', async () => {
      delete process.env.FACEBOOK_PAGE_ID;

      await expect(controller().status()).resolves.toMatchObject({
        configured: false,
      });
    });

    it('saves one kind’s switch', async () => {
      const status = await controller().update({
        kind: 'most-added',
        enabled: true,
      });

      expect(prisma.setting.upsert).toHaveBeenCalledWith({
        where: { key: 'facebook.posts.most-added' },
        create: { key: 'facebook.posts.most-added', value: 'true' },
        update: { value: 'true' },
      });
      expect(
        status.posts.filter(({ enabled }) => enabled).map(({ kind }) => kind),
      ).toEqual(['most-added']);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('only takes a known kind and a yes or no', async () => {
      const invalid = async (body: object) =>
        (await validate(plainToInstance(UpdateFacebookPostsDto, body))).map(
          ({ property }) => property,
        );

      await expect(
        invalid({ kind: 'coming', enabled: false }),
      ).resolves.toEqual([]);
      await expect(invalid({ kind: 'reels', enabled: 'yes' })).resolves.toEqual(
        ['kind', 'enabled'],
      );
      await expect(invalid({})).resolves.toEqual(['kind', 'enabled']);
    });

    it('posts a known kind right away and refuses others', async () => {
      at('2026-11-11T10:00:00.000Z');

      await expect(controller().send('tip')).resolves.toEqual({
        postIds: ['321_901'],
      });
      expect(() => controller().send('reels')).toThrow(NotFoundException);
    });

    it('is only for the signed-in head admin', () => {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, FacebookPostsController),
      ).toEqual([JwtAuthGuard, HeadAdminGuard]);
    });
  });
});
