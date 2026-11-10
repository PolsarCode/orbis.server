import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '../../prisma/generated/client';
import { HeadAdminGuard } from '../admin/head-admin.guard';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ChartShareService } from '../library/chart-share.service';
import { LibraryService } from '../library/library.service';
import { PrismaService } from '../prisma.service';
import { UpdateFacebookChartsDto } from './dto/update-facebook-charts.dto';
import { FacebookChartPostingService } from './facebook-chart-posting.service';
import { FacebookChartsController } from './facebook-charts.controller';

const STARTS_AT = Date.parse('2026-11-09T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const GRAPH = 'https://graph.facebook.com/v27.0/321';

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

describe('Posting weekly charts to Facebook', () => {
  type Key = { mediaType: string; week: string };
  const posts = new Map<string, { postId: string | null }>();
  const keyOf = ({ mediaType, week }: Key) => `${mediaType}:${week}`;
  const settings = new Map<string, string>();
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
    facebookChartPost: {
      findMany: jest.fn(async ({ where }: { where: { OR: Key[] } }) =>
        where.OR.filter((key) => posts.has(keyOf(key))).map(
          ({ mediaType }) => ({ mediaType }),
        ),
      ),
      create: jest.fn(async ({ data }: { data: Key }) => {
        if (posts.has(keyOf(data))) throw uniqueViolation();
        posts.set(keyOf(data), { postId: null });
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { mediaType_week: Key };
          data: { postId: string };
        }) => {
          posts.set(keyOf(where.mediaType_week), data);
        },
      ),
      deleteMany: jest.fn(async ({ where }: { where: Key }) => {
        posts.delete(keyOf(where));
      }),
      findFirst: jest.fn(),
    },
    $transaction: jest.fn((work: (tx: typeof lock) => Promise<unknown>) =>
      work(lock),
    ),
  };
  const library = { chart: jest.fn() };
  let service: FacebookChartPostingService;

  const fetchMock = jest.fn();
  const originalFetch = global.fetch;
  const previous = {
    WEB_URL: process.env.WEB_URL,
    FACEBOOK_PAGE_ID: process.env.FACEBOOK_PAGE_ID,
    FACEBOOK_PAGE_TOKEN: process.env.FACEBOOK_PAGE_TOKEN,
  };

  const graph = (status = 200, body: object = {}) => ({
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
  let photoCount = 0;
  const answer = async (url: string) => {
    if (url.startsWith('https://orbis.test/')) return png();
    if (url === `${GRAPH}/photos`) {
      photoCount += 1;
      return graph(200, {
        id: `photo-${photoCount}`,
        post_id: `321_90${photoCount}`,
      });
    }
    throw new Error(`Unexpected request to ${url}`);
  };
  const refused = graph(403, {
    error: { message: '(#200) Permissions error', code: 200 },
  });

  const photoCalls = () =>
    fetchMock.mock.calls.filter(([url]) => url === `${GRAPH}/photos`);
  const photoForm = (index: number) => photoCalls()[index][1].body as FormData;

  beforeAll(() => {
    process.env.WEB_URL = 'https://orbis.test';
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
    process.env.FACEBOOK_PAGE_ID = '321';
    process.env.FACEBOOK_PAGE_TOKEN = 'page-token';
    service = new FacebookChartPostingService(
      prisma as unknown as PrismaService,
      new ChartShareService(library as unknown as LibraryService),
    );
    jest.spyOn(Date, 'now').mockReturnValue(STARTS_AT + 8 * HOUR);
    lock.$queryRaw.mockResolvedValue([{ locked: true }]);
    prisma.facebookChartPost.findFirst.mockResolvedValue(null);
    library.chart.mockImplementation(async (_user: number, type: string) =>
      chart(type),
    );
    fetchMock.mockImplementation(answer);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('posts each chart as its own Page post, once a week', async () => {
    await service.run();
    await service.run();

    expect(photoCalls()).toHaveLength(3);
    const forms = [0, 1, 2].map(photoForm);
    expect(forms.map((form) => (form.get('source') as File).name)).toEqual([
      'orbis-anime-chart-2026-11-09.png',
      'orbis-manga-chart-2026-11-09.png',
      'orbis-game-chart-2026-11-09.png',
    ]);
    expect(forms[0].get('access_token')).toBe('page-token');
    expect(forms[0].get('published')).toBeNull();
    expect(await (forms[0].get('source') as File).text()).toBe('png-bytes');
    expect([...posts.entries()]).toEqual([
      ['anime:2026-W46', { postId: '321_901' }],
      ['manga:2026-W46', { postId: '321_902' }],
      ['game:2026-W46', { postId: '321_903' }],
    ]);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('page-token')),
    ).toBe(false);
  });

  it('captions each post with its chart and a link to its discussion', async () => {
    await service.run();

    expect([0, 1, 2].map((index) => photoForm(index).get('message'))).toEqual([
      'Trending Anime of Nov 9 – Nov 15, 2026 on Orbis!\n\n' +
        'Join the discussion: https://orbis.test/library?tab=charts&week=2026-W46#discussion',
      'Trending Manga of Nov 9 – Nov 15, 2026 on Orbis!\n\n' +
        'Join the discussion: https://orbis.test/library?tab=charts&type=manga&week=2026-W46#discussion',
      'Trending Games of Nov 9 – Nov 15, 2026 on Orbis!\n\n' +
        'Join the discussion: https://orbis.test/library?tab=charts&type=game&week=2026-W46#discussion',
    ]);
  });

  it('does nothing until the Page is set up', async () => {
    delete process.env.FACEBOOK_PAGE_TOKEN;

    await service.run();

    expect(library.chart).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(service.sendNow()).rejects.toBeInstanceOf(BadRequestException);
  });

  it('only posts on the first day of the week', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(STARTS_AT + 25 * HOUR);

    await service.run();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.facebookChartPost.create).not.toHaveBeenCalled();
  });

  it('posts the charts that are ready and the rest on a later run', async () => {
    library.chart.mockImplementationOnce(async () => {
      throw new Error('Library unavailable');
    });

    await service.run();

    expect([...posts.keys()]).toEqual(['manga:2026-W46', 'game:2026-W46']);

    await service.run();

    expect(photoCalls()).toHaveLength(3);
    expect(posts.get('anime:2026-W46')).toEqual({ postId: '321_903' });
  });

  it('skips a chart that hasn’t moved to the new week yet', async () => {
    library.chart.mockImplementation(async (_user: number, type: string) =>
      type === 'anime'
        ? {
            ...chart(type),
            week: '2026-W45',
            startsAt: '2026-11-02T00:00:00.000Z',
          }
        : chart(type),
    );

    await service.run();

    expect([...posts.keys()]).toEqual(['manga:2026-W46', 'game:2026-W46']);
  });

  it('tries again on the next run when Facebook refuses', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === `${GRAPH}/photos` ? refused : answer(url),
    );

    await service.run();

    expect(posts.size).toBe(0);

    fetchMock.mockImplementation(answer);
    await service.run();

    expect(photoCalls()).toHaveLength(6);
    expect(posts.get('anime:2026-W46')).toEqual({ postId: '321_901' });
  });

  it.each([
    [
      'an error page',
      () => ({ ...graph(502), json: async () => JSON.parse('<html>') }),
    ],
    [
      'a server error',
      () =>
        graph(500, {
          error: { message: 'Unknown error', code: 2, is_transient: true },
        }),
    ],
    ['an answer without a post', () => graph(200, { id: 'photo-1' })],
    [
      'no answer in time',
      () => {
        throw new DOMException('Timed out', 'TimeoutError');
      },
    ],
  ])('never posts twice when a post gets %s back', async (_case, reply) => {
    fetchMock.mockImplementation(async (url: string) =>
      url === `${GRAPH}/photos` ? reply() : answer(url),
    );

    await service.run();
    await service.run();

    expect(photoCalls()).toHaveLength(3);
    expect([...posts.values()]).toEqual([
      { postId: null },
      { postId: null },
      { postId: null },
    ]);
  });

  it('leaves a chart another server already claimed', async () => {
    prisma.facebookChartPost.create.mockRejectedValueOnce(uniqueViolation());

    await service.run();

    expect(photoCalls()).toHaveLength(2);
    expect(posts.has('anime:2026-W46')).toBe(false);
  });

  it('skips Monday’s posts while they’re switched off, but can still post right away', async () => {
    settings.set('facebook.charts', 'false');

    await service.run();

    expect(library.chart).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.facebookChartPost.create).not.toHaveBeenCalled();

    await expect(service.sendNow()).resolves.toEqual({
      postIds: ['321_901', '321_902', '321_903'],
    });
  });

  it('does nothing while another server is posting', async () => {
    lock.$queryRaw.mockResolvedValue([{ locked: false }]);

    await service.run();

    expect(library.chart).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('posting right away', () => {
    it('posts this week’s three charts without using up Monday’s posts', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(STARTS_AT + 3 * 24 * HOUR);

      await expect(service.sendNow()).resolves.toEqual({
        postIds: ['321_901', '321_902', '321_903'],
      });
      expect(posts.size).toBe(0);

      jest.spyOn(Date, 'now').mockReturnValue(STARTS_AT + 8 * HOUR);
      await service.run();

      expect(photoCalls()).toHaveLength(6);
    });

    it('passes on what Facebook said when it refuses', async () => {
      fetchMock.mockImplementation(async (url: string) =>
        url === `${GRAPH}/photos` ? refused : answer(url),
      );

      await expect(service.sendNow()).rejects.toThrow(
        new BadGatewayException('Facebook said: (#200) Permissions error'),
      );
      expect(photoCalls()).toHaveLength(1);
    });

    it('says which charts went out before something failed', async () => {
      fetchMock.mockImplementation(async (url: string) =>
        url === `${GRAPH}/photos` && photoCount >= 1 ? refused : answer(url),
      );

      await expect(service.sendNow()).rejects.toThrow(
        new BadGatewayException(
          'Posted Anime, then Facebook said: (#200) Permissions error',
        ),
      );
    });

    it('says to check the Page when Facebook doesn’t answer clearly', async () => {
      fetchMock.mockImplementation(async (url: string) =>
        url === `${GRAPH}/photos` ? graph(502) : answer(url),
      );

      await expect(service.sendNow()).rejects.toThrow(
        new BadGatewayException(
          'Facebook didn’t answer. Check the Page before trying again, in case it was posted',
        ),
      );
    });

    it('says so when a chart image can’t be made', async () => {
      fetchMock.mockImplementation(async (url: string) =>
        url.startsWith('https://orbis.test/') ? png(502) : answer(url),
      );

      await expect(service.sendNow()).rejects.toThrow(
        new BadGatewayException(
          'Couldn’t make the Anime chart image. Try again in a moment',
        ),
      );
      expect(photoCalls()).toHaveLength(0);
    });
  });

  describe('the Facebook settings', () => {
    const controller = () => new FacebookChartsController(service);
    const lookups = () =>
      fetchMock.mock.calls.filter(([url]) => url === `${GRAPH}?fields=name`);

    it('says when the Page isn’t set up', async () => {
      delete process.env.FACEBOOK_PAGE_TOKEN;

      await expect(controller().status()).resolves.toEqual({
        configured: false,
        page: null,
        pageError: null,
        enabled: true,
        lastPost: null,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('shows the Page’s name and the last post, keeping the token out of the URL', async () => {
      fetchMock.mockImplementation(async (url: string) =>
        url === `${GRAPH}?fields=name`
          ? graph(200, { name: 'Orbis', id: '321' })
          : answer(url),
      );
      prisma.facebookChartPost.findFirst.mockResolvedValue({
        week: '2026-W46',
        postId: '321_900',
        createdAt: new Date('2026-11-09T08:00:00.000Z'),
      });

      await expect(controller().status()).resolves.toEqual({
        configured: true,
        page: { id: '321', name: 'Orbis' },
        pageError: null,
        enabled: true,
        lastPost: {
          week: '2026-W46',
          postId: '321_900',
          postedAt: '2026-11-09T08:00:00.000Z',
        },
      });
      expect(lookups()).toHaveLength(1);
      expect(lookups()[0][1].headers).toEqual({
        Authorization: 'Bearer page-token',
      });
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes('page-token'),
        ),
      ).toBe(false);
      expect(prisma.facebookChartPost.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
      );
    });

    it.each([
      [
        'a Facebook error',
        async () =>
          graph(400, {
            error: { message: 'Invalid OAuth access token.', code: 190 },
          }),
        'Invalid OAuth access token',
      ],
      [
        'an error page',
        async () => ({ ...graph(502), json: async () => JSON.parse('<html>') }),
        'Facebook didn’t answer',
      ],
      [
        'no answer in time',
        async () => {
          throw new DOMException('Timed out', 'TimeoutError');
        },
        'Facebook didn’t answer',
      ],
    ])('passes on %s from the Page lookup', async (_case, reply, pageError) => {
      fetchMock.mockImplementation(reply);

      await expect(controller().status()).resolves.toMatchObject({
        configured: true,
        page: { id: '321', name: null },
        pageError,
      });
    });

    it('saves the switch for Monday’s post', async () => {
      await expect(controller().update({ enabled: false })).resolves.toEqual(
        expect.objectContaining({ enabled: false }),
      );
      expect(prisma.setting.upsert).toHaveBeenCalledWith({
        where: { key: 'facebook.charts' },
        create: { key: 'facebook.charts', value: 'false' },
        update: { value: 'false' },
      });

      await expect(controller().update({ enabled: true })).resolves.toEqual(
        expect.objectContaining({ enabled: true }),
      );
    });

    it('only takes a yes or no for the switch', async () => {
      const invalid = async (body: object) =>
        (await validate(plainToInstance(UpdateFacebookChartsDto, body))).map(
          ({ property }) => property,
        );

      await expect(invalid({ enabled: false })).resolves.toEqual([]);
      await expect(invalid({ enabled: 'no' })).resolves.toEqual(['enabled']);
      await expect(invalid({})).resolves.toEqual(['enabled']);
    });

    it('is only for the signed-in head admin', () => {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, FacebookChartsController),
      ).toEqual([JwtAuthGuard, HeadAdminGuard]);
    });
  });
});
