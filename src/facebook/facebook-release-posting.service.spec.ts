import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Prisma } from '../../prisma/generated/client';
import { HeadAdminGuard } from '../admin/head-admin.guard';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PrismaService } from '../prisma.service';
import {
  ChangelogDay,
  FacebookReleasePostingService,
  releaseMessage,
} from './facebook-release-posting.service';
import { FacebookReleasesController } from './facebook-releases.controller';

const GRAPH = 'https://graph.facebook.com/v27.0/321';
const CHANGELOG = 'https://orbis.test/changelog.json';

const nov9 = {
  date: '2026-11-09',
  versions: ['v0.116.0', 'v0.119.0'],
  entries: [
    {
      type: 'new',
      title: 'Weekly charts for anime, manga, and games',
      description: 'See the most popular titles each week.',
    },
    { type: 'improved', title: 'The library is now the Catalog' },
  ],
};
const nov10 = {
  date: '2026-11-10',
  versions: ['v0.124.0', 'v0.124.4'],
  entries: [
    { type: 'new', title: 'Find us on Facebook' },
    { type: 'fixed', title: 'Chart titles no longer cut off' },
  ],
};

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('Posting what’s new in Orbis to Facebook', () => {
  type Row = {
    date: string;
    version: string | null;
    postId: string | null;
    createdAt: Date;
  };
  const posts = new Map<string, Row>();
  const settings = new Map<string, string>();
  const lock = { $queryRaw: jest.fn() };
  const newest = () =>
    [...posts.values()].sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
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
    facebookReleasePost: {
      findFirst: jest.fn(async () => newest()),
      create: jest.fn(
        async ({
          data,
        }: {
          data: { date: string; version: string | null };
        }) => {
          if (posts.has(data.date)) throw uniqueViolation();
          posts.set(data.date, {
            ...data,
            postId: null,
            createdAt: new Date('2026-11-11T01:00:00.000Z'),
          });
        },
      ),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { date: string };
          data: { postId: string };
        }) => {
          posts.set(where.date, { ...posts.get(where.date)!, ...data });
        },
      ),
      deleteMany: jest.fn(
        async ({
          where,
        }: {
          where: { date?: string; postId?: null; createdAt?: { lt: Date } };
        }) => {
          for (const [date, row] of posts) {
            const matches =
              where.date !== undefined
                ? date === where.date
                : row.postId === null && row.createdAt < where.createdAt!.lt;
            if (matches) posts.delete(date);
          }
        },
      ),
    },
    $transaction: jest.fn((work: (tx: typeof lock) => Promise<unknown>) =>
      work(lock),
    ),
  };
  let service: FacebookReleasePostingService;
  let days: object[];
  let feedAnswer: () => object;

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
  const IMAGES = 'https://orbis.test/changelog/image?';
  const png = (status = 200) => ({
    ok: status === 200,
    status,
    headers: new Headers({ 'content-type': 'image/png' }),
    arrayBuffer: async () => new TextEncoder().encode('png-bytes').buffer,
  });
  let imageAnswer: () => object;
  const feedCalls = () =>
    fetchMock.mock.calls.filter(([url]) => url === `${GRAPH}/photos`);
  const feedForm = (index = 0) => feedCalls()[index][1].body as FormData;
  const imageUrls = () =>
    fetchMock.mock.calls
      .map(([url]) => url as string)
      .filter((url) => url.startsWith(IMAGES));

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
    settings.set('facebook.releases', 'true');
    process.env.FACEBOOK_PAGE_ID = '321';
    process.env.FACEBOOK_PAGE_TOKEN = 'page-token';
    days = [nov10, nov9];
    let count = 0;
    feedAnswer = () =>
      json(200, { id: `photo-${count}`, post_id: `321_70${++count}` });
    imageAnswer = () => png();
    lock.$queryRaw.mockResolvedValue([{ locked: true }]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url === CHANGELOG) return json(200, { days });
      if (url.startsWith(IMAGES)) return imageAnswer();
      if (url === `${GRAPH}/photos`) return feedAnswer();
      throw new Error(`Unexpected request to ${url}`);
    });
    service = new FacebookReleasePostingService(
      prisma as unknown as PrismaService,
    );
  });

  it('writes the version, the changes and a link to that day’s changelog', () => {
    expect(releaseMessage([nov10 as ChangelogDay])).toBe(
      'What’s new in Orbis v0.124.4\n\n' +
        '✨ Find us on Facebook\n' +
        '🐛 Chart titles no longer cut off\n\n' +
        'See all the changes: https://orbis.test/changelog/2026-11-10',
    );
  });

  it('keeps long updates short and links to the whole changelog for several days', () => {
    const busy = {
      date: '2026-11-12',
      versions: [],
      entries: Array.from({ length: 9 }, (_, index) => ({
        type: 'improved' as const,
        title: `Change ${index + 1}`,
      })),
    };
    const message = releaseMessage([busy, nov10 as ChangelogDay]);

    expect(message.startsWith('What’s new in Orbis\n\n')).toBe(true);
    expect(message).toContain('💄 Change 8\n…and 3 more');
    expect(message).not.toContain('Change 9');
    expect(message.endsWith('https://orbis.test/changelog')).toBe(true);
  });

  it('leaves the version out when the changelog has none', () => {
    expect(
      releaseMessage([
        {
          date: '2026-11-12',
          versions: [],
          entries: nov10.entries,
        } as ChangelogDay,
      ]).startsWith('What’s new in Orbis\n\n'),
    ).toBe(true);
  });

  it('starts with the newest update, then posts each new day once', async () => {
    await service.run();
    await service.run();

    expect(feedCalls()).toHaveLength(1);
    const form = feedForm();
    expect(form.get('message')).toContain('What’s new in Orbis v0.124.4');
    expect(form.get('message')).not.toContain('Weekly charts');
    expect(form.get('message')).toContain(
      'See all the changes: https://orbis.test/changelog/2026-11-10',
    );
    expect((form.get('source') as File).name).toBe(
      'orbis-update-2026-11-10.png',
    );
    expect(imageUrls()).toEqual([`${IMAGES}date=2026-11-10`]);
    expect(form.get('access_token')).toBe('page-token');
    expect(posts.get('2026-11-10')).toEqual(
      expect.objectContaining({ version: 'v0.124.4', postId: '321_701' }),
    );

    days = [
      {
        date: '2026-11-11',
        versions: ['v0.125.0'],
        entries: [{ type: 'new', title: 'What’s new posts' }],
      },
      nov10,
      nov9,
    ];
    await service.run();

    expect(feedCalls()).toHaveLength(2);
    expect(feedForm(1).get('message')).toContain('v0.125.0');
    expect(feedForm(1).get('message')).not.toContain('Find us on Facebook');
  });

  it('puts every day since the last post into one post', async () => {
    posts.set('2026-11-08', {
      date: '2026-11-08',
      version: 'v0.110.0',
      postId: '321_1',
      createdAt: new Date(),
    });

    await service.run();

    expect(feedCalls()).toHaveLength(1);
    const message = feedForm().get('message') as string;
    expect(message).toContain('Find us on Facebook');
    expect(message).toContain('Weekly charts for anime, manga, and games');
    expect(message.endsWith('https://orbis.test/changelog')).toBe(true);
    expect(imageUrls()).toEqual([`${IMAGES}date=2026-11-10&from=2026-11-09`]);
    expect(posts.has('2026-11-10')).toBe(true);
  });

  it('doesn’t post while the switch is off, which is how it starts', async () => {
    settings.delete('facebook.releases');
    await service.run();
    settings.set('facebook.releases', 'false');
    await service.run();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips days with nothing in them and anything that isn’t a changelog day', async () => {
    days = [
      { date: '2026-11-12', entries: [] },
      { date: 'soon', entries: nov10.entries },
      { date: '2026-11-11', entries: [{ type: 'other', title: 'Hidden' }] },
      nov10,
    ];
    await service.run();

    expect(imageUrls()).toEqual([`${IMAGES}date=2026-11-10`]);
  });

  it('waits for the next check when the image can’t be made', async () => {
    imageAnswer = () => png(502);
    await service.run();
    expect(feedCalls()).toHaveLength(0);
    expect(posts.size).toBe(0);

    imageAnswer = () => png();
    await service.run();
    expect(feedCalls()).toHaveLength(1);
  });

  it('tries again later when Facebook refuses the post', async () => {
    feedAnswer = () =>
      json(403, { error: { message: '(#200) Permissions error' } });
    await service.run();
    expect(posts.size).toBe(0);

    feedAnswer = () => json(200, { post_id: '321_9' });
    await service.run();
    expect(posts.get('2026-11-10')?.postId).toBe('321_9');
  });

  it('doesn’t post again when Facebook didn’t answer, in case it went through', async () => {
    feedAnswer = () => json(502, {});
    await service.run();
    await service.run();

    expect(feedCalls()).toHaveLength(1);
    expect(posts.get('2026-11-10')?.postId).toBeNull();
  });

  it('keeps going when the website can’t be reached', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === CHANGELOG ? json(503, {}) : feedAnswer(),
    );

    await expect(service.run()).resolves.toBeUndefined();
    expect(feedCalls()).toHaveLength(0);
  });

  it('does nothing when Facebook isn’t set up', async () => {
    delete process.env.FACEBOOK_PAGE_TOKEN;
    await service.run();

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(service.sendNow()).rejects.toThrow(BadRequestException);
  });

  describe('Post now', () => {
    it('posts the newest update even while the switch is off', async () => {
      settings.set('facebook.releases', 'false');

      await expect(service.sendNow()).resolves.toEqual({
        postId: '321_701',
        date: '2026-11-10',
        version: 'v0.124.4',
      });
    });

    it('says so when the newest update is already on Facebook', async () => {
      await service.sendNow();

      await expect(service.sendNow()).rejects.toThrow(
        'There’s no new update to post. The newest one, v0.124.4, is already on Facebook',
      );
      expect(feedCalls()).toHaveLength(1);
    });

    it('passes on what Facebook said', async () => {
      feedAnswer = () =>
        json(403, { error: { message: '(#200) Permissions error.' } });

      await expect(service.sendNow()).rejects.toThrow(
        new BadGatewayException('Facebook said: (#200) Permissions error'),
      );
      expect(posts.size).toBe(0);
    });

    it('warns to check the Page when Facebook didn’t answer', async () => {
      feedAnswer = () => json(500, {});

      await expect(service.sendNow()).rejects.toThrow(
        'Facebook didn’t answer. Check the Page before trying again, in case it was posted',
      );
    });

    it('explains when the changelog can’t be loaded', async () => {
      fetchMock.mockImplementation(async () => json(404, {}));

      await expect(service.sendNow()).rejects.toThrow(
        'Couldn’t load the changelog from the website. Try again in a moment',
      );
    });

    it('tries again once Facebook has had time to answer an unclear post', async () => {
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(Date.parse('2026-11-11T01:01:00.000Z'));
      feedAnswer = () => json(502, {});
      await service.run();
      expect(posts.get('2026-11-10')?.postId).toBeNull();

      feedAnswer = () => json(200, { post_id: '321_8' });
      await expect(service.sendNow()).rejects.toThrow(BadRequestException);

      now.mockReturnValue(Date.parse('2026-11-11T01:05:00.000Z'));
      await expect(service.sendNow()).resolves.toEqual(
        expect.objectContaining({ postId: '321_8', date: '2026-11-10' }),
      );
      now.mockRestore();
    });

    it('says so when the update gets posted by the timer at the same moment', async () => {
      prisma.facebookReleasePost.create.mockRejectedValueOnce(
        uniqueViolation(),
      );

      await expect(service.sendNow()).rejects.toThrow(
        'This update was just posted. Check the Page',
      );
      expect(feedCalls()).toHaveLength(0);
    });

    it('explains when the website sends something that isn’t the changelog', async () => {
      fetchMock.mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      }));

      await expect(service.run()).resolves.toBeUndefined();
      await expect(service.sendNow()).rejects.toThrow(
        'Couldn’t load the changelog from the website. Try again in a moment',
      );
    });

    it('explains when the image can’t be made', async () => {
      imageAnswer = () => png(500);

      await expect(service.sendNow()).rejects.toThrow(
        'Couldn’t make the update image. Try again in a moment',
      );
      expect(posts.size).toBe(0);
    });

    it('says so when the changelog has nothing in it yet', async () => {
      days = [];

      await expect(service.sendNow()).rejects.toThrow(
        'The changelog is empty, so there’s nothing to post yet',
      );
      expect(feedCalls()).toHaveLength(0);
    });
  });

  describe('Admin settings', () => {
    const controller = () => new FacebookReleasesController(service);

    it('shows the switch and the last post', async () => {
      settings.delete('facebook.releases');
      await expect(controller().status()).resolves.toEqual({
        enabled: false,
        lastPost: null,
      });

      await service.sendNow();
      await expect(controller().status()).resolves.toEqual({
        enabled: false,
        lastPost: {
          date: '2026-11-10',
          version: 'v0.124.4',
          postId: '321_701',
          postedAt: '2026-11-11T01:00:00.000Z',
        },
      });
    });

    it('saves the switch and posts the newest update once it’s on', async () => {
      settings.delete('facebook.releases');

      await expect(controller().update({ enabled: true })).resolves.toEqual({
        enabled: true,
        lastPost: expect.objectContaining({
          version: 'v0.124.4',
          postId: '321_701',
        }),
      });
      expect(prisma.setting.upsert).toHaveBeenCalledWith({
        where: { key: 'facebook.releases' },
        create: { key: 'facebook.releases', value: 'true' },
        update: { value: 'true' },
      });
      expect(feedCalls()).toHaveLength(1);
    });

    it('is only for the signed-in head admin', () => {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, FacebookReleasesController),
      ).toEqual([JwtAuthGuard, HeadAdminGuard]);
    });
  });
});
