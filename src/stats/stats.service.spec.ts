import { BadRequestException } from '@nestjs/common';
import { MINUTE } from '../common/throttle';
import { FacebookError, NOT_SET_UP } from '../facebook/facebook-page';
import { PrismaService } from '../prisma.service';
import { StatsService } from './stats.service';

const FOLLOWERS = 'https://graph.facebook.com/v27.0/321?fields=followers_count';
const NOW = Date.parse('2026-11-11T03:00:00.000Z');

describe('Orbis stats', () => {
  const prisma = {
    user: { count: jest.fn(async () => 18) },
    community: { count: jest.fn(async () => 4) },
    post: { count: jest.fn(async () => 120) },
    comment: { count: jest.fn(async () => 340) },
  };
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;
  const previous = {
    FACEBOOK_PAGE_ID: process.env.FACEBOOK_PAGE_ID,
    FACEBOOK_PAGE_TOKEN: process.env.FACEBOOK_PAGE_TOKEN,
  };
  const graph = (status: number, body: object) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const later = () => {
    let answer!: (reply: object) => void;
    fetchMock.mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    return (reply: object) => answer(reply);
  };
  let now: jest.SpyInstance;
  let service: StatsService;

  beforeAll(() => {
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
    process.env.FACEBOOK_PAGE_ID = '321';
    process.env.FACEBOOK_PAGE_TOKEN = 'page-token';
    now = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    fetchMock.mockImplementation(async (url: string) => {
      if (url === FOLLOWERS) {
        return graph(200, { followers_count: 1234, id: '321' });
      }
      throw new Error(`Unexpected request to ${url}`);
    });
    service = new StatsService(prisma as unknown as PrismaService);
  });

  afterEach(() => now.mockRestore());

  it('counts everything on Orbis and the Facebook Page’s followers', async () => {
    await expect(service.summary()).resolves.toEqual({
      members: 18,
      communities: 4,
      posts: 120,
      comments: 340,
      facebookFollowers: 1234,
    });
    expect(fetchMock).toHaveBeenCalledWith(FOLLOWERS, {
      headers: { Authorization: 'Bearer page-token' },
      signal: expect.any(AbortSignal),
    });
  });

  it('waits for the first count, sharing one request', async () => {
    await expect(
      Promise.all([
        service.facebookFollowers(),
        service.facebookFollowers(),
        service.summary(),
      ]),
    ).resolves.toEqual([
      1234,
      1234,
      expect.objectContaining({ facebookFollowers: 1234 }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks Facebook for the followers at most once every 5 minutes', async () => {
    await service.facebookFollowers();
    now.mockReturnValue(NOW + 5 * MINUTE - 1);

    await expect(service.facebookFollowers()).resolves.toBe(1234);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers with the last count right away while it asks again in the background', async () => {
    await service.facebookFollowers();
    const answer = later();
    now.mockReturnValue(NOW + 5 * MINUTE);

    await expect(service.facebookFollowers()).resolves.toBe(1234);
    await expect(service.summary()).resolves.toEqual(
      expect.objectContaining({ facebookFollowers: 1234 }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    answer(graph(200, { followers_count: 1300 }));
    await settle();
    await expect(service.facebookFollowers()).resolves.toBe(1300);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the last count when asking again fails, and waits 5 minutes before the next try', async () => {
    await service.facebookFollowers();
    fetchMock.mockResolvedValue(graph(502, {}));
    now.mockReturnValue(NOW + 5 * MINUTE);

    await expect(service.facebookFollowers()).resolves.toBe(1234);
    await settle();
    await expect(service.facebookFollowers()).resolves.toBe(1234);
    now.mockReturnValue(NOW + 9 * MINUTE);
    await expect(service.facebookFollowers()).resolves.toBe(1234);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    now.mockReturnValue(NOW + 10 * MINUTE);
    await service.facebookFollowers();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('asks Facebook right away when refreshing, and keeps the new count', async () => {
    await service.facebookFollowers();
    fetchMock.mockResolvedValue(graph(200, { followers_count: 1300 }));

    await expect(service.refreshFacebookFollowers()).resolves.toBe(1300);
    await expect(service.facebookFollowers()).resolves.toBe(1300);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says why when refreshing fails, keeping the last count', async () => {
    await service.facebookFollowers();
    fetchMock.mockResolvedValue(
      graph(400, { error: { message: 'Invalid OAuth access token.' } }),
    );

    await expect(service.refreshFacebookFollowers()).rejects.toThrow(
      new FacebookError('Invalid OAuth access token.'),
    );
    await expect(service.facebookFollowers()).resolves.toBe(1234);
  });

  it('refuses to refresh when Facebook isn’t set up', async () => {
    delete process.env.FACEBOOK_PAGE_TOKEN;

    await expect(service.refreshFacebookFollowers()).rejects.toThrow(
      new BadRequestException(NOT_SET_UP),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('has no followers when Facebook isn’t set up', async () => {
    delete process.env.FACEBOOK_PAGE_TOKEN;

    await expect(service.summary()).resolves.toEqual(
      expect.objectContaining({ members: 18, facebookFollowers: null }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'refuses',
      async () =>
        graph(400, {
          error: { message: 'Invalid OAuth access token.', code: 190 },
        }),
    ],
    ['doesn’t answer', async () => graph(502, {})],
    [
      'times out',
      async () => {
        throw new DOMException('Timed out', 'TimeoutError');
      },
    ],
    ['sends something odd', async () => graph(200, { followers_count: -1 })],
  ])(
    'has no followers for 5 minutes when Facebook %s',
    async (_case, reply) => {
      fetchMock.mockImplementation(reply);

      await expect(service.facebookFollowers()).resolves.toBeNull();
      now.mockReturnValue(NOW + 4 * MINUTE);
      await expect(service.summary()).resolves.toEqual(
        expect.objectContaining({ facebookFollowers: null }),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockResolvedValue(graph(200, { followers_count: 1234 }));
      now.mockReturnValue(NOW + 5 * MINUTE);
      await expect(service.facebookFollowers()).resolves.toBe(1234);
    },
  );
});
