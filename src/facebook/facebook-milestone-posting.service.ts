import {
  BadGatewayException,
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '../../prisma/generated/client';
import { fetchImage } from '../common/fetch-image';
import { MINUTE } from '../common/throttle';
import { webUrl } from '../common/web-url';
import { PrismaService } from '../prisma.service';
import { StatsService } from '../stats/stats.service';
import {
  FacebookError,
  FacebookPage,
  facebookPage,
  NOT_SET_UP,
} from './facebook-page';
import {
  facebookSaid,
  FacebookPostingJob,
  postFailed,
  UnclearPostError,
} from './facebook-posting-job';
import { readSwitch, saveSwitch } from './facebook-switch';

const CHECK_MS = 10 * MINUTE;
const POST_LOCK = 727_012_054;
const IMAGE_TIMEOUT_MS = 30_000;
const UNCONFIRMED_AFTER_MS = 2 * MINUTE;
const ORBIS_SCOPE = 'orbis';
const FACEBOOK_SCOPE = 'facebook';
const STEPS = [1, 2.5, 5];

export type MilestoneKind = 'members' | 'communities' | 'followers';

const KINDS: MilestoneKind[] = ['members', 'communities', 'followers'];

export type MilestoneCommunity = { id: number; name: string };

export type FacebookMilestonesStatus = {
  members: boolean;
  communities: boolean;
  followers: boolean;
  lastPost: {
    kind: MilestoneKind;
    milestone: number;
    community: MilestoneCommunity | null;
    postId: string | null;
    postedAt: string;
  } | null;
};

export type MilestonePost = {
  postId: string;
  kind: MilestoneKind;
  milestone: number;
  community: MilestoneCommunity | null;
};

type MilestoneTarget = Omit<MilestonePost, 'postId'>;

type ScopeMilestone = MilestoneTarget & { scope: string };

type ScopeCount = Omit<ScopeMilestone, 'milestone'> & { count: number };

type Milestone = ScopeMilestone & { reachedAt: Date };

class MilestoneImageError extends Error {}

export function milestoneReached(count: number): number | null {
  let reached: number | null = null;
  for (let base = 10; base <= count; base *= 10) {
    for (const step of STEPS) {
      if (base * step <= count) reached = base * step;
    }
  }
  return reached;
}

export function milestoneMessage({
  kind,
  milestone,
  community,
}: MilestoneTarget) {
  const count = milestone.toLocaleString('en-US');
  if (kind === 'followers') {
    return `🎉 Orbis just reached ${count} followers on Facebook!\n\nThank you for following along. Come say hi on Orbis: ${webUrl()}`;
  }
  return community
    ? `🎉 ${community.name} just reached ${count} members on Orbis!\n\nJoin them: ${webUrl()}/communities/${community.id}`
    : `🎉 Orbis just reached ${count} members!\n\nThank you to everyone who’s joined so far. Come say hi: ${webUrl()}`;
}

function milestoneImageUrl({ kind, milestone, community }: MilestoneTarget) {
  const params = new URLSearchParams({
    [kind === 'followers' ? 'followers' : 'members']: String(milestone),
  });
  if (community) params.set('community', String(community.id));
  return `${webUrl()}/milestones/image?${params}`;
}

function milestoneFilename({ kind, milestone, community }: MilestoneTarget) {
  if (kind === 'followers') return `orbis-facebook-milestone-${milestone}.png`;
  return community
    ? `orbis-${community.id}-milestone-${milestone}.png`
    : `orbis-milestone-${milestone}.png`;
}

function milestoneLabel({ kind, milestone, community }: MilestoneTarget) {
  return kind === 'followers'
    ? `the ${milestone}-follower milestone for the Facebook Page`
    : `the ${milestone}-member milestone for ${community?.name ?? 'Orbis'}`;
}

function kindOf(scope: string): MilestoneKind {
  if (scope === ORBIS_SCOPE) return 'members';
  if (scope === FACEBOOK_SCOPE) return 'followers';
  return 'communities';
}

function switchKey(kind: MilestoneKind) {
  return `facebook.milestones.${kind}`;
}

function baselineKey(kind: MilestoneKind) {
  return `facebook.milestones.${kind}.baseline`;
}

function inOrder(direction: 1 | -1) {
  return (a: Milestone, b: Milestone) =>
    Number(a.kind === 'followers') - Number(b.kind === 'followers') ||
    direction * (a.reachedAt.getTime() - b.reachedAt.getTime());
}

function staleClaims() {
  return {
    postId: null,
    createdAt: { lt: new Date(Date.now() - UNCONFIRMED_AFTER_MS) },
  };
}

@Injectable()
export class FacebookMilestonePostingService extends FacebookPostingJob {
  constructor(
    prisma: PrismaService,
    private stats: StatsService,
  ) {
    super(prisma, {
      every: CHECK_MS,
      lock: POST_LOCK,
      failure: 'Posting a milestone to Facebook failed',
    });
  }

  async status(): Promise<FacebookMilestonesStatus> {
    const lastPost = await this.prisma.facebookMilestonePost.findFirst({
      orderBy: { createdAt: 'desc' },
      select: {
        scope: true,
        milestone: true,
        postId: true,
        createdAt: true,
        community: { select: { id: true, name: true } },
      },
    });
    return {
      ...(await this.switches()),
      lastPost: lastPost && {
        kind: kindOf(lastPost.scope),
        milestone: lastPost.milestone,
        community: lastPost.community,
        postId: lastPost.postId,
        postedAt: lastPost.createdAt.toISOString(),
      },
    };
  }

  async setSwitches(changes: Partial<Record<MilestoneKind, boolean>>) {
    const switches = await this.switches();
    const turnedOn = KINDS.filter((kind) => changes[kind] && !switches[kind]);
    const baselines = await Promise.all(
      turnedOn.map(async (kind) => ({
        key: baselineKey(kind),
        value: JSON.stringify(await this.reachedNow(kind)),
      })),
    );
    for (const { key, value } of baselines) {
      await this.prisma.setting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }
    for (const kind of KINDS) {
      const enabled = changes[kind];
      if (typeof enabled === 'boolean') {
        await saveSwitch(this.prisma, switchKey(kind), enabled);
      }
    }
    return this.status();
  }

  async sendNow(): Promise<MilestonePost> {
    const page = facebookPage();
    if (!page) throw new BadRequestException(NOT_SET_UP);
    const kinds = await this.enabledKinds();
    if (kinds.length === 0) {
      throw new BadRequestException(
        'Turn on at least one kind of milestone first',
      );
    }

    const [all, settled] = await Promise.all([
      this.highest(),
      this.highest({ NOT: staleClaims() }),
    ]);
    const [latest] = (
      await this.candidates(
        kinds,
        ({ scope, milestone }) =>
          milestone > (settled.get(scope) ?? 0) &&
          milestone >= (all.get(scope) ?? 0),
      )
    ).sort(inOrder(-1));
    if (!latest) {
      throw new BadRequestException('There’s no new milestone to post yet');
    }

    try {
      const posted = await this.post(page, latest);
      if (!posted) {
        throw new BadRequestException(
          'This milestone was just posted. Check the Page',
        );
      }
      return posted;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if (error instanceof MilestoneImageError) {
        throw new BadGatewayException(
          'Couldn’t make the milestone image. Try again in a moment',
        );
      }
      throw postFailed(error);
    }
  }

  protected async postDue(page: FacebookPage) {
    const kinds = await this.enabledKinds();
    if (kinds.length === 0) return;
    const [highest, baseline] = await Promise.all([
      this.highest(),
      this.baseline(kinds),
    ]);
    const due = await this.candidates(
      kinds,
      ({ scope, milestone }) =>
        milestone > Math.max(highest.get(scope) ?? 0, baseline[scope] ?? 0),
    );
    for (const candidate of due.sort(inOrder(1))) {
      try {
        if (await this.post(page, candidate)) return;
      } catch (error) {
        if (error instanceof UnclearPostError) return;
        if (error instanceof FacebookError) {
          this.logger.warn(
            `Facebook refused ${milestoneLabel(candidate)}: ${error.message}`,
          );
        } else if (!(error instanceof MilestoneImageError)) {
          throw error;
        }
      }
    }
  }

  private async switches(): Promise<Record<MilestoneKind, boolean>> {
    const [members, communities, followers] = await Promise.all(
      KINDS.map((kind) => readSwitch(this.prisma, switchKey(kind), false)),
    );
    return { members, communities, followers };
  }

  private async enabledKinds() {
    const switches = await this.switches();
    return KINDS.filter((kind) => switches[kind]);
  }

  private async baseline(
    kinds: MilestoneKind[],
  ): Promise<Record<string, number>> {
    const baselines = await this.prisma.setting.findMany({
      where: { key: { in: kinds.map(baselineKey) } },
      select: { value: true },
    });
    return Object.assign(
      {},
      ...baselines.map(({ value }) => JSON.parse(value)),
    );
  }

  private async reachedNow(kind: MilestoneKind) {
    if (kind === 'followers') {
      const milestone = milestoneReached(await this.freshFollowers());
      return milestone === null ? {} : { [FACEBOOK_SCOPE]: milestone };
    }
    return Object.fromEntries(
      (await this.milestones([kind], {})).map(({ scope, milestone }) => [
        scope,
        milestone,
      ]),
    );
  }

  private async freshFollowers() {
    try {
      return await this.stats.refreshFacebookFollowers();
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadGatewayException(
        `Couldn’t read the Page’s followers, so follower milestones weren’t turned on. ${facebookSaid(
          error,
          'Facebook didn’t answer. Try again in a moment',
        )}`,
      );
    }
  }

  private async highest(where?: Prisma.FacebookMilestonePostWhereInput) {
    const posted = await this.prisma.facebookMilestonePost.groupBy({
      by: ['scope'],
      where,
      _max: { milestone: true },
    });
    return new Map(
      posted.map(({ scope, _max }) => [scope, _max.milestone ?? 0]),
    );
  }

  private async counts(
    kind: MilestoneKind,
    communities: Prisma.CommunityWhereInput,
  ): Promise<ScopeCount[]> {
    switch (kind) {
      case 'members':
        return [
          {
            kind,
            scope: ORBIS_SCOPE,
            community: null,
            count: await this.prisma.user.count(),
          },
        ];
      case 'communities':
        return (
          await this.prisma.community.findMany({
            where: communities,
            select: {
              id: true,
              name: true,
              _count: { select: { memberships: true } },
            },
          })
        ).map(({ id, name, _count }) => ({
          kind,
          scope: `community:${id}`,
          community: { id, name },
          count: _count.memberships,
        }));
      case 'followers': {
        const count = await this.stats.facebookFollowers();
        return count === null
          ? []
          : [{ kind, scope: FACEBOOK_SCOPE, community: null, count }];
      }
    }
  }

  private async milestones(
    kinds: MilestoneKind[],
    communities: Prisma.CommunityWhereInput,
  ): Promise<ScopeMilestone[]> {
    const counts = await Promise.all(
      kinds.map((kind) => this.counts(kind, communities)),
    );
    return counts.flat().flatMap(({ count, ...scope }) => {
      const milestone = milestoneReached(count);
      return milestone === null ? [] : [{ ...scope, milestone }];
    });
  }

  private async candidates(
    kinds: MilestoneKind[],
    isDue: (milestone: ScopeMilestone) => boolean,
  ): Promise<Milestone[]> {
    const due = (await this.milestones(kinds, { isPublic: true })).filter(
      isDue,
    );
    const reached = await Promise.all(
      due.map(async (milestone) => ({
        ...milestone,
        reachedAt: await this.reachedAt(milestone),
      })),
    );
    return reached.flatMap(({ reachedAt, ...milestone }) =>
      reachedAt ? [{ ...milestone, reachedAt }] : [],
    );
  }

  private async reachedAt({ kind, milestone, community }: ScopeMilestone) {
    if (kind === 'followers') return new Date();
    if (!community) {
      const user = await this.prisma.user.findFirst({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: milestone - 1,
        select: { createdAt: true },
      });
      return user?.createdAt ?? null;
    }
    const membership = await this.prisma.membership.findFirst({
      where: { communityId: community.id },
      orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
      skip: milestone - 1,
      select: { joinedAt: true },
    });
    return membership?.joinedAt ?? null;
  }

  private async post(
    page: FacebookPage,
    candidate: Milestone,
  ): Promise<MilestonePost | null> {
    const { kind, scope, milestone, community } = candidate;
    const data = await fetchImage(
      milestoneImageUrl(candidate),
      IMAGE_TIMEOUT_MS,
    ).catch((error: Error) => {
      this.logger.warn(
        `Couldn’t load the image for ${milestoneLabel(candidate)}: ${error.message}`,
      );
      throw new MilestoneImageError(error.message);
    });
    const key = { scope, milestone };
    const postId = await this.postOnce({
      page,
      image: { filename: milestoneFilename(candidate), data },
      message: milestoneMessage(candidate),
      label: milestoneLabel(candidate),
      claim: async () => {
        await this.prisma.facebookMilestonePost.deleteMany({
          where: { ...key, ...staleClaims() },
        });
        await this.prisma.facebookMilestonePost.create({
          data: { ...key, communityId: community?.id ?? null },
        });
        const higher = await this.prisma.facebookMilestonePost.count({
          where: { scope, milestone: { gt: milestone } },
        });
        if (higher === 0) return true;
        await this.prisma.facebookMilestonePost.deleteMany({ where: key });
        return false;
      },
      release: () =>
        this.prisma.facebookMilestonePost.deleteMany({ where: key }),
      confirm: (postId) =>
        this.prisma.facebookMilestonePost.update({
          where: { scope_milestone: key },
          data: { postId },
        }),
    });
    return postId ? { postId, kind, milestone, community } : null;
  }
}
