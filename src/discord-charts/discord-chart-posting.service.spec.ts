import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../prisma/generated/client';
import { CommunitiesService } from '../communities/communities.service';
import { ChartShareService } from '../library/chart-share.service';
import { LibraryService } from '../library/library.service';
import { PrismaService } from '../prisma.service';
import { DiscordChartPostingService } from './discord-chart-posting.service';
import { DiscordChartService } from './discord-chart.service';

type Row = {
  communityId: number;
  webhookId: string;
  webhookToken: string;
  isForum: boolean;
  sendAnime: boolean;
  sendManga: boolean;
  sendGames: boolean;
  message: string | null;
  lostAt: Date | null;
  createdAt: Date;
  community: { id: number; name: string; iconUrl: string | null };
};

type Where = Record<string, unknown> & { OR?: Partial<Row>[] };
type PostKey = { mediaType: string; week: string };
type PostWhere = {
  communityId: number | { in: number[] };
  OR: PostKey[];
};

const STARTS_AT = Date.parse('2026-11-09T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function connection(overrides: Partial<Row> = {}): Row {
  const communityId = overrides.communityId ?? 7;
  return {
    communityId,
    webhookId: `hook-${communityId}`,
    webhookToken: `token-${communityId}`,
    isForum: false,
    sendAnime: true,
    sendManga: false,
    sendGames: false,
    message: null,
    lostAt: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    community: {
      id: communityId,
      name: 'Hidden Leaf Village',
      iconUrl: '/images/communities/leaf.webp',
    },
    ...overrides,
  };
}

function chart(type: string) {
  return {
    type: type.toUpperCase(),
    week: '2026-W46',
    startsAt: '2026-11-09T00:00:00.000Z',
    endsAt: '2026-11-16T00:00:00.000Z',
    previousWeek: '2026-W45',
    nextWeek: null,
    entries: [],
    updatedAt: '2026-11-09T00:05:00.000Z',
  };
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('Posting weekly charts to Discord', () => {
  let rows: Row[];
  const posts = new Map<string, { messageId: string | null }>();
  const keyOf = (key: {
    communityId: number;
    mediaType: string;
    week: string;
  }) => `${key.communityId}:${key.mediaType}:${key.week}`;

  const matches = (row: Row, where: Where): boolean =>
    Object.entries(where).every(([field, value]) =>
      field === 'OR'
        ? (value as Where[]).some((option) => matches(row, option))
        : row[field as keyof Row] === value,
    );
  const postsMatching = ({ communityId, OR }: PostWhere) =>
    [...posts.keys()].filter((key) => {
      const [id, mediaType, week] = key.split(':');
      const ids =
        typeof communityId === 'number' ? [communityId] : communityId.in;
      return (
        ids.includes(Number(id)) &&
        OR.some(
          (option) => option.mediaType === mediaType && option.week === week,
        )
      );
    });

  const lock = { $queryRaw: jest.fn() };
  const prisma = {
    discordChartChannel: {
      findUnique: jest.fn(
        async ({ where }: { where: { communityId: number } }) => {
          const row = rows.find(
            ({ communityId }) => communityId === where.communityId,
          );
          return row ? { ...row, community: { ...row.community } } : null;
        },
      ),
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        rows
          .filter((row) => matches(row, where))
          .map((row) => ({ ...row, community: { ...row.community } })),
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { communityId: number; webhookId: string };
          data: Partial<Row>;
        }) => {
          for (const row of rows) {
            if (
              row.communityId === where.communityId &&
              row.webhookId === where.webhookId
            ) {
              Object.assign(row, data);
            }
          }
        },
      ),
    },
    discordChartPost: {
      create: jest.fn(
        async ({
          data,
        }: {
          data: { communityId: number; mediaType: string; week: string };
        }) => {
          if (posts.has(keyOf(data))) throw uniqueViolation();
          posts.set(keyOf(data), { messageId: null });
        },
      ),
      findMany: jest.fn(async ({ where }: { where: PostWhere }) =>
        postsMatching(where).map((key) => {
          const [communityId, mediaType] = key.split(':');
          return { communityId: Number(communityId), mediaType };
        }),
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: PostWhere;
          data: { messageId: string };
        }) => {
          for (const key of postsMatching(where)) posts.set(key, data);
        },
      ),
      deleteMany: jest.fn(async ({ where }: { where: PostWhere }) => {
        for (const key of postsMatching(where)) posts.delete(key);
      }),
    },
    $transaction: jest.fn((work: (tx: typeof lock) => Promise<unknown>) =>
      work(lock),
    ),
  };
  const library = { chart: jest.fn() };
  const communities = { assertCanManage: jest.fn() };
  const charts = new DiscordChartService(
    prisma as unknown as PrismaService,
    communities as unknown as CommunitiesService,
  );
  let service: DiscordChartPostingService;

  const fetchMock = jest.fn();
  const originalFetch = global.fetch;
  const previousWebUrl = process.env.WEB_URL;

  const discord = (status = 200, body: object = { id: '900' }) => ({
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

  const discordCalls = () =>
    fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith('https://discord.com/'),
    );
  const imageCalls = () =>
    fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith('https://orbis.test/charts/'),
    );
  const payload = (index = 0) => {
    const form = discordCalls()[index][1].body as FormData;
    return {
      body: JSON.parse(form.get('payload_json') as string),
      file: form.get('files[0]') as File,
    };
  };

  beforeAll(() => {
    process.env.WEB_URL = 'https://orbis.test';
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    process.env.WEB_URL = previousWebUrl;
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    rows = [connection()];
    posts.clear();
    service = new DiscordChartPostingService(
      prisma as unknown as PrismaService,
      new ChartShareService(library as unknown as LibraryService),
      charts,
    );
    jest.spyOn(Date, 'now').mockReturnValue(STARTS_AT + 8 * HOUR);
    lock.$queryRaw.mockResolvedValue([{ locked: true }]);
    library.chart.mockImplementation(async (_user: number, type: string) =>
      chart(type),
    );
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith('https://orbis.test/') ? png() : discord(),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('posts each turned-on chart once per community and week, even across runs', async () => {
    rows = [
      connection({ communityId: 7 }),
      connection({ communityId: 8, sendManga: true }),
    ];

    await service.run();
    await service.run();

    expect(library.chart).toHaveBeenCalledWith(0, 'anime');
    expect(library.chart).toHaveBeenCalledWith(0, 'manga');
    expect(library.chart).not.toHaveBeenCalledWith(0, 'game');
    expect(imageCalls().map(([url]) => url)).toEqual([
      'https://orbis.test/charts/anime/image?week=2026-W46',
      'https://orbis.test/charts/manga/image?week=2026-W46',
    ]);
    expect(discordCalls().map(([url]) => url)).toEqual([
      'https://discord.com/api/v10/webhooks/hook-7/token-7?wait=true&with_components=true',
      'https://discord.com/api/v10/webhooks/hook-8/token-8?wait=true&with_components=true',
    ]);
    expect([...posts.entries()]).toEqual([
      ['7:anime:2026-W46', { messageId: '900' }],
      ['8:anime:2026-W46', { messageId: '900' }],
      ['8:manga:2026-W46', { messageId: '900' }],
    ]);
  });

  it('posts the chart image with the community’s message and a link to the discussion', async () => {
    rows = [connection({ message: '@everyone New chart is out!' })];

    await service.run();

    const { body, file } = payload();
    expect(body).toMatchObject({
      content:
        '@everyone New chart is out!\n\n[Join the discussion](https://orbis.test/library?tab=charts&week=2026-W46#discussion)',
      allowed_mentions: { parse: ['everyone'] },
      flags: 4,
      username: 'Hidden Leaf Village',
      avatar_url: 'https://orbis.test/images/communities/leaf.webp',
      attachments: [
        {
          id: 0,
          filename: 'orbis-anime-chart-2026-11-09.png',
          description: 'Anime chart · Nov 9 – Nov 15, 2026',
        },
      ],
    });
    expect(body).not.toHaveProperty('thread_name');
    expect(body).not.toHaveProperty('embeds');
    expect(file.name).toBe('orbis-anime-chart-2026-11-09.png');
    expect(file.type).toBe('image/png');
    expect(await file.text()).toBe('png-bytes');
  });

  it('fills in the message’s variables, in any letter case', async () => {
    rows = [
      connection({
        message:
          '@here The {TYPE} chart for week {week} of {Year} is out: {dates} (from {date}) {other}',
      }),
    ];

    await service.run();

    expect(payload().body.content).toBe(
      '@here The Anime chart for week 46 of 2026 is out: Nov 9 – Nov 15, 2026 (from Nov 9, 2026) {other}\n\n[Join the discussion](https://orbis.test/library?tab=charts&week=2026-W46#discussion)',
    );
    expect(payload().body.allowed_mentions).toEqual({ parse: ['everyone'] });
  });

  it('links to the right chart and leaves out an empty message', async () => {
    rows = [connection({ sendAnime: false, sendGames: true })];

    await service.run();

    expect(payload().body.content).toBe(
      '[Join the discussion](https://orbis.test/library?tab=charts&type=game&week=2026-W46#discussion)',
    );
    expect(payload().file.name).toBe('orbis-game-chart-2026-11-09.png');
  });

  it('puts every turned-on chart in one post and lists them in {type}', async () => {
    rows = [
      connection({
        sendManga: true,
        sendGames: true,
        message: 'Hello, @everyone! Trending {type} of {dates} is here!',
      }),
    ];

    await service.run();

    expect(discordCalls()).toHaveLength(1);
    const { body } = payload();
    expect(body.content).toBe(
      'Hello, @everyone! Trending Anime, Manga and Games of Nov 9 – Nov 15, 2026 is here!\n\n' +
        'Join the discussion: ' +
        '[Anime](https://orbis.test/library?tab=charts&week=2026-W46#discussion) · ' +
        '[Manga](https://orbis.test/library?tab=charts&type=manga&week=2026-W46#discussion) · ' +
        '[Games](https://orbis.test/library?tab=charts&type=game&week=2026-W46#discussion)',
    );
    expect(
      body.attachments.map(({ filename }: { filename: string }) => filename),
    ).toEqual([
      'orbis-anime-chart-2026-11-09.png',
      'orbis-manga-chart-2026-11-09.png',
      'orbis-game-chart-2026-11-09.png',
    ]);
    const form = discordCalls()[0][1].body as FormData;
    expect((form.get('files[2]') as File).name).toBe(
      'orbis-game-chart-2026-11-09.png',
    );
    expect([...posts.values()]).toEqual([
      { messageId: '900' },
      { messageId: '900' },
      { messageId: '900' },
    ]);
  });

  it('lists two charts with “and”', async () => {
    rows = [
      connection({
        sendManga: true,
        isForum: true,
        message: 'Trending {type}',
      }),
    ];

    await service.run();

    expect(payload().body.content).toMatch(/^Trending Anime and Manga\n\n/);
    expect(payload().body.thread_name).toBe(
      'Anime and Manga · Nov 9 – Nov 15, 2026',
    );
  });

  it('sends a chart turned on later that day as its own post', async () => {
    rows = [connection({ message: 'Trending {type}' })];
    await service.run();

    rows[0].sendManga = true;
    await service.run();
    await service.run();

    expect(discordCalls()).toHaveLength(2);
    expect(payload(1).body.content).toMatch(/^Trending Manga\n\n/);
    expect(payload(1).body.attachments).toHaveLength(1);
  });

  it('starts a titled post in forum channels', async () => {
    rows = [connection({ isForum: true })];

    await service.run();

    expect(payload().body.thread_name).toBe('Anime · Nov 9 – Nov 15, 2026');
  });

  it('switches to forum posts when Discord asks for a title', async () => {
    fetchMock
      .mockResolvedValueOnce(png())
      .mockResolvedValueOnce(discord(400, { code: 220001 }));

    await service.run();

    expect(prisma.discordChartChannel.updateMany).toHaveBeenCalledWith({
      where: { communityId: 7, webhookId: 'hook-7' },
      data: { isForum: true },
    });
    expect(payload(1).body.thread_name).toBe('Anime · Nov 9 – Nov 15, 2026');
    expect(posts.get('7:anime:2026-W46')).toEqual({ messageId: '900' });
  });

  it('skips lost connections and charts nobody turned on', async () => {
    rows = [connection({ lostAt: new Date() })];

    await service.run();

    expect(library.chart).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only posts on the first day of the week', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(STARTS_AT + 25 * HOUR);

    await service.run();

    jest.spyOn(Date, 'now').mockReturnValue(STARTS_AT - HOUR);
    await service.run();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.discordChartPost.create).not.toHaveBeenCalled();
  });

  it('tries again on the next run when sending fails', async () => {
    fetchMock.mockResolvedValueOnce(png()).mockResolvedValueOnce(discord(500));

    await service.run();

    expect(posts.size).toBe(0);
    expect(rows[0].lostAt).toBeNull();

    await service.run();

    expect(discordCalls()).toHaveLength(2);
    expect(imageCalls()).toHaveLength(1);
    expect(posts.get('7:anime:2026-W46')).toEqual({ messageId: '900' });
  });

  it('never posts twice when Discord doesn’t answer in time', async () => {
    fetchMock
      .mockResolvedValueOnce(png())
      .mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'));

    await service.run();
    await service.run();

    expect(discordCalls()).toHaveLength(1);
    expect(posts.get('7:anime:2026-W46')).toEqual({ messageId: null });
  });

  it('doesn’t keep retrying a post Discord refuses', async () => {
    fetchMock
      .mockResolvedValueOnce(png())
      .mockResolvedValueOnce(discord(403, { code: 50013 }));

    await service.run();
    await service.run();

    expect(discordCalls()).toHaveLength(1);
    expect(rows[0].lostAt).toBeNull();
  });

  it('marks the connection as lost when the webhook was deleted in Discord', async () => {
    fetchMock
      .mockResolvedValueOnce(png())
      .mockResolvedValueOnce(discord(404, { code: 10015 }));

    await service.run();
    await service.run();

    expect(rows[0].lostAt).toBeInstanceOf(Date);
    expect(posts.size).toBe(0);
    expect(discordCalls()).toHaveLength(1);
  });

  it('waits for the next run when the chart image can’t be loaded', async () => {
    fetchMock.mockResolvedValueOnce(png(502));

    await service.run();

    expect(discordCalls()).toHaveLength(0);
    expect(posts.size).toBe(0);

    await service.run();

    expect(discordCalls()).toHaveLength(1);
  });

  it('waits for every chart in a post to load, and still sends the others', async () => {
    rows = [
      connection({ communityId: 7, sendManga: true }),
      connection({ communityId: 8, sendAnime: false, sendManga: true }),
    ];
    library.chart.mockImplementationOnce(async () => {
      throw new Error('Library unavailable');
    });

    await service.run();

    expect(discordCalls().map(([url]) => url)).toEqual([
      'https://discord.com/api/v10/webhooks/hook-8/token-8?wait=true&with_components=true',
    ]);
    expect([...posts.keys()]).toEqual(['8:manga:2026-W46']);

    await service.run();

    expect(discordCalls()).toHaveLength(2);
    expect(payload(1).body.attachments).toHaveLength(2);
    expect(posts.size).toBe(3);
  });

  it('leaves a chart another server already claimed', async () => {
    prisma.discordChartChannel.findMany.mockImplementationOnce(
      async ({ where }: { where: Where }) => {
        const found = rows.filter((row) => matches(row, where));
        posts.set('7:anime:2026-W46', { messageId: null });
        return found;
      },
    );

    await service.run();

    expect(discordCalls()).toHaveLength(0);
    expect(posts.get('7:anime:2026-W46')).toEqual({ messageId: null });
  });

  it('does nothing while another server is posting', async () => {
    lock.$queryRaw.mockResolvedValue([{ locked: false }]);

    await service.run();

    expect(prisma.discordChartChannel.findMany).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('sending right away', () => {
    it('posts this week’s turned-on charts now without using up Monday’s post', async () => {
      rows = [
        connection({ sendGames: true, message: 'Testing the {type} chart' }),
      ];
      jest.spyOn(Date, 'now').mockReturnValue(STARTS_AT + 3 * 24 * HOUR);

      await service.sendNow(1, 7);

      expect(communities.assertCanManage).toHaveBeenCalledWith(1, 7);
      expect(imageCalls().map(([url]) => url)).toEqual([
        'https://orbis.test/charts/anime/image?week=2026-W46',
        'https://orbis.test/charts/game/image?week=2026-W46',
      ]);
      expect(discordCalls()).toHaveLength(1);
      expect(payload(0).body.content).toBe(
        'Testing the Anime and Games chart\n\nJoin the discussion: ' +
          '[Anime](https://orbis.test/library?tab=charts&week=2026-W46#discussion) · ' +
          '[Games](https://orbis.test/library?tab=charts&type=game&week=2026-W46#discussion)',
      );
      expect(payload(0).body.attachments).toHaveLength(2);
      expect(posts.size).toBe(0);

      jest.spyOn(Date, 'now').mockReturnValue(STARTS_AT + 8 * HOUR);
      await service.run();

      expect(discordCalls()).toHaveLength(2);
      expect(posts.size).toBe(2);
    });

    it('sends the message being edited without saving it', async () => {
      rows = [connection({ message: 'Saved message' })];

      await service.sendNow(1, 7, '  Draft for the {type} chart  ');
      await service.sendNow(1, 7, '');

      expect(payload(0).body.content).toMatch(
        /^Draft for the Anime chart\n\n\[Join the discussion\]\(https:/,
      );
      expect(payload(1).body.content).toMatch(
        /^\[Join the discussion\]\(https:/,
      );
      expect(rows[0].message).toBe('Saved message');
    });

    it('explains when nothing can be sent', async () => {
      rows = [connection({ sendAnime: false })];
      await expect(service.sendNow(1, 7)).rejects.toThrow(
        new BadRequestException('Turn on at least one chart first'),
      );

      rows = [connection({ lostAt: new Date() })];
      await expect(service.sendNow(1, 7)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      rows = [];
      await expect(service.sendNow(1, 7)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('marks the connection as lost when the webhook was deleted in Discord', async () => {
      fetchMock
        .mockResolvedValueOnce(png())
        .mockResolvedValueOnce(discord(404, { code: 10015 }));

      await expect(service.sendNow(1, 7)).rejects.toThrow(
        'This channel was disconnected in Discord. Connect it again first',
      );
      expect(rows[0].lostAt).toBeInstanceOf(Date);
    });

    it('says so when the image or Discord fails', async () => {
      fetchMock.mockResolvedValueOnce(png(502));
      await expect(service.sendNow(1, 7)).rejects.toThrow(
        new BadGatewayException(
          'Couldn’t make the chart image. Try again in a moment',
        ),
      );
      expect(discordCalls()).toHaveLength(0);

      fetchMock
        .mockResolvedValueOnce(png())
        .mockResolvedValueOnce(discord(403, { code: 50013 }));
      await expect(service.sendNow(1, 7)).rejects.toThrow(
        new BadGatewayException(
          'Discord didn’t accept the post. Try again in a moment',
        ),
      );
      expect(rows[0].lostAt).toBeNull();
    });

    it('is only for owners and admins', async () => {
      communities.assertCanManage.mockRejectedValueOnce(
        new ForbiddenException(),
      );

      await expect(service.sendNow(2, 7)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.discordChartChannel.findUnique).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
