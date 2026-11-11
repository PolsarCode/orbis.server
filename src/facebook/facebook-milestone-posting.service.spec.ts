import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Prisma } from '../../prisma/generated/client';
import { HeadAdminGuard } from '../admin/head-admin.guard';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PrismaService } from '../prisma.service';
import { NOT_SET_UP } from './facebook-page';
import {
  FacebookMilestonePostingService,
  milestoneMessage,
  milestoneReached,
} from './facebook-milestone-posting.service';
import { FacebookMilestonesController } from './facebook-milestones.controller';

const GRAPH = 'https://graph.facebook.com/v27.0/321';
const IMAGES = 'https://orbis.test/milestones/image?';
const BEFORE = new Date('2026-11-10T00:00:00.000Z');
const AFTER = new Date('2026-11-11T01:00:00.000Z');
const LATER = new Date('2026-11-11T02:00:00.000Z');
const POSTED_AT = new Date('2026-11-11T03:00:00.000Z');
const STALE_BY = Date.parse('2026-11-11T03:05:00.000Z');

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('Posting member milestones to Facebook', () => {
  type Row = {
    scope: string;
    members: number;
    communityId: number | null;
    postId: string | null;
    createdAt: Date;
  };
  type Community = { id: number; name: string; isPublic: boolean };
  const posts = new Map<string, Row>();
  const settings = new Map<string, string>();
  let users: { id: number; createdAt: Date }[];
  let communities: Community[];
  let memberships: { userId: number; communityId: number; joinedAt: Date }[];
  const lock = { $queryRaw: jest.fn() };
  const keyOf = ({ scope, members }: { scope: string; members: number }) =>
    `${scope}|${members}`;
  const byTime = <T>(time: (row: T) => Date, id: (row: T) => number) => {
    return (a: T, b: T) =>
      time(a).getTime() - time(b).getTime() || id(a) - id(b);
  };
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
    user: {
      count: jest.fn(async () => users.length),
      findFirst: jest.fn(
        async ({ skip }: { skip: number }) =>
          [...users].sort(
            byTime(
              (user) => user.createdAt,
              (user) => user.id,
            ),
          )[skip] ?? null,
      ),
    },
    community: {
      findMany: jest.fn(async ({ where }: { where?: { isPublic?: boolean } }) =>
        communities
          .filter(
            (community) =>
              where?.isPublic === undefined ||
              community.isPublic === where.isPublic,
          )
          .map(({ id, name }) => ({
            id,
            name,
            _count: {
              memberships: memberships.filter(
                (membership) => membership.communityId === id,
              ).length,
            },
          })),
      ),
    },
    membership: {
      findFirst: jest.fn(
        async ({
          where,
          skip,
        }: {
          where: { communityId: number };
          skip: number;
        }) =>
          memberships
            .filter(
              (membership) => membership.communityId === where.communityId,
            )
            .sort(
              byTime(
                (membership) => membership.joinedAt,
                (membership) => membership.userId,
              ),
            )[skip] ?? null,
      ),
    },
    facebookMilestonePost: {
      groupBy: jest.fn(
        async ({
          where,
        }: {
          where?: { NOT: { postId: null; createdAt: { lt: Date } } };
        }) => {
          const highest = new Map<string, number>();
          for (const { scope, members, postId, createdAt } of posts.values()) {
            if (
              where &&
              postId === where.NOT.postId &&
              createdAt < where.NOT.createdAt.lt
            ) {
              continue;
            }
            highest.set(scope, Math.max(highest.get(scope) ?? 0, members));
          }
          return [...highest].map(([scope, members]) => ({
            scope,
            _max: { members },
          }));
        },
      ),
      count: jest.fn(
        async ({
          where,
        }: {
          where: { scope: string; members: { gt: number } };
        }) =>
          [...posts.values()].filter(
            (row) =>
              row.scope === where.scope && row.members > where.members.gt,
          ).length,
      ),
      findFirst: jest.fn(async () => {
        const row = [...posts.values()].sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
        )[0];
        if (!row) return null;
        const community = communities.find(({ id }) => id === row.communityId);
        return {
          ...row,
          community: community
            ? { id: community.id, name: community.name }
            : null,
        };
      }),
      create: jest.fn(
        async ({
          data,
        }: {
          data: { scope: string; members: number; communityId: number | null };
        }) => {
          if (posts.has(keyOf(data))) throw uniqueViolation();
          posts.set(keyOf(data), {
            ...data,
            postId: null,
            createdAt: POSTED_AT,
          });
        },
      ),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { scope_members: { scope: string; members: number } };
          data: { postId: string };
        }) => {
          const key = keyOf(where.scope_members);
          posts.set(key, { ...posts.get(key)!, ...data });
        },
      ),
      deleteMany: jest.fn(
        async ({
          where,
        }: {
          where: {
            scope: string;
            members?: number;
            postId?: null;
            createdAt?: { lt: Date };
          };
        }) => {
          for (const [key, row] of posts) {
            const matches =
              row.scope === where.scope &&
              (where.members === undefined || row.members === where.members) &&
              (where.createdAt === undefined ||
                (row.postId === null && row.createdAt < where.createdAt.lt));
            if (matches) posts.delete(key);
          }
        },
      ),
    },
    $transaction: jest.fn((work: (tx: typeof lock) => Promise<unknown>) =>
      work(lock),
    ),
  };
  let service: FacebookMilestonePostingService;
  let feedAnswer: () => object;
  let imageAnswer: (url: string) => object;

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
  const feedCalls = () =>
    fetchMock.mock.calls.filter(([url]) => url === `${GRAPH}/photos`);
  const feedForm = (index = 0) => feedCalls()[index][1].body as FormData;
  const imageUrls = () =>
    fetchMock.mock.calls
      .map(([url]) => url as string)
      .filter((url) => url.startsWith(IMAGES));

  const addUsers = (count: number, createdAt: Date) => {
    for (let index = 0; index < count; index++) {
      users.push({ id: users.length + 1, createdAt });
    }
  };
  const join = (communityId: number, count: number, joinedAt: Date) => {
    for (let index = 0; index < count; index++) {
      memberships.push({
        userId: memberships.length + 1,
        communityId,
        joinedAt,
      });
    }
  };
  const stalePost = (scope: string, members: number) =>
    posts.set(keyOf({ scope, members }), {
      scope,
      members,
      communityId: scope === 'orbis' ? null : Number(scope.split(':')[1]),
      postId: null,
      createdAt: POSTED_AT,
    });
  const turnOn = () => service.setEnabled(true);

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
    users = [];
    memberships = [];
    communities = [
      { id: 7, name: 'Survey Corps', isPublic: true },
      { id: 8, name: 'Akatsuki', isPublic: false },
    ];
    process.env.FACEBOOK_PAGE_ID = '321';
    process.env.FACEBOOK_PAGE_TOKEN = 'page-token';
    let count = 0;
    feedAnswer = () =>
      json(200, { id: `photo-${count}`, post_id: `321_70${++count}` });
    imageAnswer = () => png();
    lock.$queryRaw.mockResolvedValue([{ locked: true }]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith(IMAGES)) return imageAnswer(url);
      if (url === `${GRAPH}/photos`) return feedAnswer();
      throw new Error(`Unexpected request to ${url}`);
    });
    service = new FacebookMilestonePostingService(
      prisma as unknown as PrismaService,
    );
  });

  it.each([
    [9, null],
    [10, 10],
    [24, 10],
    [25, 25],
    [99, 50],
    [1000, 1000],
    [2600, 2500],
  ])('counts %i members as the %p milestone', (count, milestone) => {
    expect(milestoneReached(count)).toBe(milestone);
  });

  it('thanks everyone when Orbis reaches a milestone', () => {
    expect(milestoneMessage(1000, null)).toBe(
      '🎉 Orbis just reached 1,000 members!\n\n' +
        'Thank you to everyone who’s joined so far. Come say hi: https://orbis.test',
    );
  });

  it('links to the community when it reaches a milestone', () => {
    expect(milestoneMessage(25, { id: 7, name: 'Survey Corps' })).toBe(
      '🎉 Survey Corps just reached 25 members on Orbis!\n\n' +
        'Join them: https://orbis.test/communities/7',
    );
  });

  it('posts an Orbis milestone reached after the switch was turned on, once', async () => {
    addUsers(9, BEFORE);
    await turnOn();
    addUsers(1, AFTER);

    await service.run();
    await service.run();

    expect(feedCalls()).toHaveLength(1);
    const form = feedForm();
    expect(form.get('message')).toBe(milestoneMessage(10, null));
    expect((form.get('source') as File).name).toBe('orbis-milestone-10.png');
    expect(form.get('access_token')).toBe('page-token');
    expect(imageUrls()).toEqual([`${IMAGES}members=10`]);
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: 9,
      select: { createdAt: true },
    });
    expect(posts.get('orbis|10')).toEqual(
      expect.objectContaining({ communityId: null, postId: '321_701' }),
    );
  });

  it('skips a milestone reached before the switch was turned on', async () => {
    addUsers(10, BEFORE);
    await turnOn();
    addUsers(1, AFTER);

    await service.run();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(posts.size).toBe(0);
  });

  it('doesn’t post an old milestone again when someone leaves and someone new joins', async () => {
    addUsers(10, BEFORE);
    await turnOn();
    users.shift();
    addUsers(1, AFTER);

    await service.run();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('doesn’t post what a community reached while it was private once it’s public', async () => {
    join(8, 10, BEFORE);
    await turnOn();
    communities[1].isPublic = true;

    await service.run();
    expect(fetchMock).not.toHaveBeenCalled();

    join(8, 15, AFTER);
    await service.run();
    expect(feedCalls()).toHaveLength(1);
    expect(feedForm().get('message')).toBe(
      milestoneMessage(25, { id: 8, name: 'Akatsuki' }),
    );
  });

  it('posts the first milestone of a community made after the switch was on', async () => {
    addUsers(10, BEFORE);
    await turnOn();
    communities.push({ id: 9, name: 'Straw Hats', isPublic: true });
    join(9, 10, AFTER);

    await service.run();

    expect(feedCalls()).toHaveLength(1);
    expect(imageUrls()).toEqual([`${IMAGES}members=10&community=9`]);
  });

  it('posts public communities and never private ones', async () => {
    await turnOn();
    join(8, 10, AFTER);
    await service.run();
    expect(fetchMock).not.toHaveBeenCalled();

    join(7, 10, AFTER);
    await service.run();

    expect(feedCalls()).toHaveLength(1);
    expect(feedForm().get('message')).toBe(
      milestoneMessage(10, { id: 7, name: 'Survey Corps' }),
    );
    expect((feedForm().get('source') as File).name).toBe(
      'orbis-7-milestone-10.png',
    );
    expect(imageUrls()).toEqual([`${IMAGES}members=10&community=7`]);
    expect(prisma.community.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { isPublic: true } }),
    );
    expect(prisma.membership.findFirst).toHaveBeenCalledWith({
      where: { communityId: 7 },
      orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
      skip: 9,
      select: { joinedAt: true },
    });
    expect(posts.get('community:7|10')).toEqual(
      expect.objectContaining({ communityId: 7, postId: '321_701' }),
    );
  });

  it('starts over from what’s reached when the switch is turned back on', async () => {
    addUsers(10, BEFORE);
    await turnOn();
    addUsers(15, AFTER);
    await service.setEnabled(false);
    await turnOn();

    await service.run();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(settings.get('facebook.milestones.baseline')).toBe('{"orbis":25}');
  });

  it('keeps the baseline when the switch is saved on again', async () => {
    addUsers(10, BEFORE);
    await turnOn();
    addUsers(15, AFTER);
    await turnOn();

    await service.run();

    expect(feedCalls()).toHaveLength(1);
    expect(feedForm().get('message')).toBe(milestoneMessage(25, null));
  });

  it('never posts a lower milestone after a higher one', async () => {
    await turnOn();
    posts.set('orbis|50', {
      scope: 'orbis',
      members: 50,
      communityId: null,
      postId: '321_1',
      createdAt: BEFORE,
    });
    addUsers(30, AFTER);

    await service.run();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts one milestone per check, the earliest reached first', async () => {
    await turnOn();
    addUsers(10, LATER);
    join(7, 10, AFTER);

    await service.run();
    expect(feedCalls()).toHaveLength(1);
    expect(feedForm(0).get('message')).toContain('Survey Corps');

    await service.run();
    expect(feedCalls()).toHaveLength(2);
    expect(feedForm(1).get('message')).toBe(milestoneMessage(10, null));

    await service.run();
    expect(feedCalls()).toHaveLength(2);
  });

  it('moves on to the next milestone when Facebook refuses one', async () => {
    await turnOn();
    addUsers(10, LATER);
    join(7, 10, AFTER);
    let count = 0;
    feedAnswer = () =>
      ++count === 1
        ? json(403, { error: { message: '(#200) Permissions error' } })
        : json(200, { post_id: `321_8${count}` });

    await service.run();
    expect(feedCalls()).toHaveLength(2);
    expect(posts.has('community:7|10')).toBe(false);
    expect(posts.get('orbis|10')?.postId).toBe('321_82');

    await service.run();
    expect(posts.get('community:7|10')?.postId).toBe('321_83');
  });

  it('moves on to the next milestone when an image can’t be made', async () => {
    await turnOn();
    addUsers(10, LATER);
    join(7, 10, AFTER);
    imageAnswer = (url) => (url.includes('community=7') ? png(502) : png());

    await service.run();

    expect(feedCalls()).toHaveLength(1);
    expect(feedForm().get('message')).toBe(milestoneMessage(10, null));
    expect(posts.has('community:7|10')).toBe(false);
  });

  it('stops the check when Facebook doesn’t answer', async () => {
    await turnOn();
    addUsers(10, LATER);
    join(7, 10, AFTER);
    feedAnswer = () => json(502, {});

    await service.run();

    expect(feedCalls()).toHaveLength(1);
    expect(posts.get('community:7|10')?.postId).toBeNull();
    expect(posts.has('orbis|10')).toBe(false);
  });

  it('skips a milestone when a higher one is claimed at the same moment', async () => {
    await turnOn();
    addUsers(10, AFTER);
    prisma.facebookMilestonePost.create.mockImplementationOnce(
      async ({ data }) => {
        posts.set(keyOf(data), { ...data, postId: null, createdAt: AFTER });
        stalePost('orbis', 25);
      },
    );

    await service.run();

    expect(feedCalls()).toHaveLength(0);
    expect(posts.has('orbis|10')).toBe(false);
    expect(posts.has('orbis|25')).toBe(true);
  });

  it('doesn’t post while the switch is off, which is how it starts', async () => {
    addUsers(10, AFTER);
    await service.run();
    settings.set('facebook.milestones', 'false');
    await service.run();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tries again later when Facebook refuses the post', async () => {
    await turnOn();
    addUsers(10, AFTER);
    feedAnswer = () =>
      json(403, { error: { message: '(#200) Permissions error' } });
    await service.run();
    expect(posts.size).toBe(0);

    feedAnswer = () => json(200, { post_id: '321_9' });
    await service.run();
    expect(posts.get('orbis|10')?.postId).toBe('321_9');
  });

  it('doesn’t post again when Facebook didn’t answer, in case it went through', async () => {
    await turnOn();
    addUsers(10, AFTER);
    feedAnswer = () => json(502, {});
    await service.run();
    await service.run();

    expect(feedCalls()).toHaveLength(1);
    expect(posts.get('orbis|10')?.postId).toBeNull();
  });

  it('waits for the next check when the image can’t be made', async () => {
    await turnOn();
    addUsers(10, AFTER);
    imageAnswer = () => png(502);

    await expect(service.run()).resolves.toBeUndefined();
    expect(feedCalls()).toHaveLength(0);
    expect(posts.size).toBe(0);
  });

  it('does nothing when Facebook isn’t set up', async () => {
    await turnOn();
    addUsers(10, AFTER);
    delete process.env.FACEBOOK_PAGE_TOKEN;
    await service.run();

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(service.sendNow()).rejects.toThrow(
      new BadRequestException(NOT_SET_UP),
    );
  });

  describe('Post now', () => {
    it('posts the most recent milestone, even one reached before the switch was on', async () => {
      addUsers(10, new Date('2026-11-01T00:00:00.000Z'));
      join(7, 10, BEFORE);

      await expect(service.sendNow()).resolves.toEqual({
        postId: '321_701',
        members: 10,
        community: { id: 7, name: 'Survey Corps' },
      });
      expect(feedCalls()).toHaveLength(1);
    });

    it('says so when there’s no new milestone', async () => {
      addUsers(9, AFTER);
      await expect(service.sendNow()).rejects.toThrow(
        new BadRequestException('There’s no new milestone to post yet'),
      );

      addUsers(1, AFTER);
      await service.sendNow();
      await expect(service.sendNow()).rejects.toThrow(
        'There’s no new milestone to post yet',
      );
      expect(feedCalls()).toHaveLength(1);
    });

    it('says so when the milestone gets posted by the timer at the same moment', async () => {
      addUsers(10, AFTER);
      prisma.facebookMilestonePost.create.mockRejectedValueOnce(
        uniqueViolation(),
      );

      await expect(service.sendNow()).rejects.toThrow(
        new BadRequestException(
          'This milestone was just posted. Check the Page',
        ),
      );
      expect(feedCalls()).toHaveLength(0);
    });

    it('explains when the image can’t be made', async () => {
      addUsers(10, AFTER);
      imageAnswer = () => png(500);

      await expect(service.sendNow()).rejects.toThrow(
        new BadGatewayException(
          'Couldn’t make the milestone image. Try again in a moment',
        ),
      );
      expect(posts.size).toBe(0);
    });

    it('passes on what Facebook said', async () => {
      addUsers(10, AFTER);
      feedAnswer = () =>
        json(403, { error: { message: '(#200) Permissions error.' } });

      await expect(service.sendNow()).rejects.toThrow(
        new BadGatewayException('Facebook said: (#200) Permissions error'),
      );
      expect(posts.size).toBe(0);
    });

    it('warns to check the Page when Facebook didn’t answer', async () => {
      addUsers(10, AFTER);
      feedAnswer = () => json(500, {});

      await expect(service.sendNow()).rejects.toThrow(
        'Facebook didn’t answer. Check the Page before trying again, in case it was posted',
      );
      expect(posts.get('orbis|10')?.postId).toBeNull();
    });

    it('tries again once Facebook has had time to answer an unclear post', async () => {
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(Date.parse('2026-11-11T03:01:00.000Z'));
      await turnOn();
      addUsers(10, AFTER);
      feedAnswer = () => json(502, {});
      await service.run();
      expect(posts.get('orbis|10')?.postId).toBeNull();

      feedAnswer = () => json(200, { post_id: '321_8' });
      await expect(service.sendNow()).rejects.toThrow(
        'There’s no new milestone to post yet',
      );

      now.mockReturnValue(STALE_BY);
      await expect(service.sendNow()).resolves.toEqual({
        postId: '321_8',
        members: 10,
        community: null,
      });
      now.mockRestore();
    });

    it('leaves other unclear posts alone, so they’re never posted twice', async () => {
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(Date.parse('2026-11-11T03:01:00.000Z'));
      await turnOn();
      join(7, 10, AFTER);
      feedAnswer = () => json(502, {});
      await service.run();
      expect(posts.get('community:7|10')?.postId).toBeNull();

      addUsers(10, LATER);
      feedAnswer = () => json(200, { post_id: '321_9' });
      now.mockReturnValue(STALE_BY);
      await expect(service.sendNow()).resolves.toEqual({
        postId: '321_9',
        members: 10,
        community: null,
      });
      expect(posts.get('community:7|10')?.postId).toBeNull();

      await service.run();
      expect(feedCalls()).toHaveLength(2);
      now.mockRestore();
    });

    it('never posts a lower milestone after an unclear higher one', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(STALE_BY);
      stalePost('community:7', 50);
      join(7, 40, AFTER);

      await expect(service.sendNow()).rejects.toThrow(
        'There’s no new milestone to post yet',
      );
      expect(feedCalls()).toHaveLength(0);
      expect(posts.has('community:7|50')).toBe(true);
      now.mockRestore();
    });

    it('keeps an unclear post when trying it again fails before it’s sent', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(STALE_BY);
      await turnOn();
      addUsers(10, AFTER);
      stalePost('orbis', 10);
      imageAnswer = () => png(500);

      await expect(service.sendNow()).rejects.toThrow(
        'Couldn’t make the milestone image. Try again in a moment',
      );
      expect(posts.get('orbis|10')).toEqual(
        expect.objectContaining({ postId: null, createdAt: POSTED_AT }),
      );

      imageAnswer = () => png();
      await service.run();
      expect(feedCalls()).toHaveLength(0);
      now.mockRestore();
    });
  });

  describe('Admin settings', () => {
    const controller = () => new FacebookMilestonesController(service);

    it('shows the switch and the last post', async () => {
      await expect(controller().status()).resolves.toEqual({
        enabled: false,
        lastPost: null,
      });

      join(7, 25, AFTER);
      await controller().send();
      await expect(controller().status()).resolves.toEqual({
        enabled: false,
        lastPost: {
          members: 25,
          community: { id: 7, name: 'Survey Corps' },
          postId: '321_701',
          postedAt: POSTED_AT.toISOString(),
        },
      });
    });

    it('saves what every scope has reached, then the switch, without posting', async () => {
      addUsers(10, AFTER);
      join(8, 25, BEFORE);
      join(7, 9, BEFORE);

      await expect(controller().update({ enabled: true })).resolves.toEqual({
        enabled: true,
        lastPost: null,
      });
      expect(prisma.setting.upsert).toHaveBeenNthCalledWith(1, {
        where: { key: 'facebook.milestones.baseline' },
        create: {
          key: 'facebook.milestones.baseline',
          value: '{"orbis":10,"community:8":25}',
        },
        update: { value: '{"orbis":10,"community:8":25}' },
      });
      expect(prisma.setting.upsert).toHaveBeenNthCalledWith(2, {
        where: { key: 'facebook.milestones' },
        create: { key: 'facebook.milestones', value: 'true' },
        update: { value: 'true' },
      });
      expect(fetchMock).not.toHaveBeenCalled();

      await expect(controller().update({ enabled: false })).resolves.toEqual(
        expect.objectContaining({ enabled: false }),
      );
      expect(prisma.setting.upsert).toHaveBeenCalledTimes(3);
    });

    it('is only for the signed-in head admin', () => {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, FacebookMilestonesController),
      ).toEqual([JwtAuthGuard, HeadAdminGuard]);
    });
  });
});
