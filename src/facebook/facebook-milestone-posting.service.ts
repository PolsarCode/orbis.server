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
import {
  FacebookError,
  FacebookPage,
  facebookPage,
  NOT_SET_UP,
} from './facebook-page';
import {
  FacebookPostingJob,
  postFailed,
  UnclearPostError,
} from './facebook-posting-job';
import { readSwitch, saveSwitch } from './facebook-switch';

const CHECK_MS = 10 * MINUTE;
const POST_LOCK = 727_012_054;
const ENABLED_KEY = 'facebook.milestones';
const BASELINE_KEY = 'facebook.milestones.baseline';
const IMAGE_TIMEOUT_MS = 30_000;
const UNCONFIRMED_AFTER_MS = 2 * MINUTE;
const ORBIS_SCOPE = 'orbis';
const STEPS = [1, 2.5, 5];

export type MilestoneCommunity = { id: number; name: string };

export type FacebookMilestonesStatus = {
  enabled: boolean;
  lastPost: {
    members: number;
    community: MilestoneCommunity | null;
    postId: string | null;
    postedAt: string;
  } | null;
};

export type MilestonePost = {
  postId: string;
  members: number;
  community: MilestoneCommunity | null;
};

type ScopeMilestone = {
  scope: string;
  members: number;
  community: MilestoneCommunity | null;
};

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

export function milestoneMessage(
  members: number,
  community: MilestoneCommunity | null,
) {
  const count = members.toLocaleString('en-US');
  return community
    ? `🎉 ${community.name} just reached ${count} members on Orbis!\n\nJoin them: ${webUrl()}/communities/${community.id}`
    : `🎉 Orbis just reached ${count} members!\n\nThank you to everyone who’s joined so far. Come say hi: ${webUrl()}`;
}

function milestoneImageUrl(
  members: number,
  community: MilestoneCommunity | null,
) {
  const params = new URLSearchParams({ members: String(members) });
  if (community) params.set('community', String(community.id));
  return `${webUrl()}/milestones/image?${params}`;
}

function milestoneLabel({ members, community }: ScopeMilestone) {
  return `the ${members}-member milestone for ${community?.name ?? 'Orbis'}`;
}

function staleClaims() {
  return {
    postId: null,
    createdAt: { lt: new Date(Date.now() - UNCONFIRMED_AFTER_MS) },
  };
}

@Injectable()
export class FacebookMilestonePostingService extends FacebookPostingJob {
  constructor(prisma: PrismaService) {
    super(prisma, {
      every: CHECK_MS,
      lock: POST_LOCK,
      failure: 'Posting a member milestone to Facebook failed',
    });
  }

  async status(): Promise<FacebookMilestonesStatus> {
    const lastPost = await this.prisma.facebookMilestonePost.findFirst({
      orderBy: { createdAt: 'desc' },
      select: {
        members: true,
        postId: true,
        createdAt: true,
        community: { select: { id: true, name: true } },
      },
    });
    return {
      enabled: await this.enabled(),
      lastPost: lastPost && {
        members: lastPost.members,
        community: lastPost.community,
        postId: lastPost.postId,
        postedAt: lastPost.createdAt.toISOString(),
      },
    };
  }

  async setEnabled(enabled: boolean) {
    if (enabled && !(await this.enabled())) {
      const baseline = JSON.stringify(
        Object.fromEntries(
          (await this.milestones({})).map(({ scope, members }) => [
            scope,
            members,
          ]),
        ),
      );
      await this.prisma.setting.upsert({
        where: { key: BASELINE_KEY },
        create: { key: BASELINE_KEY, value: baseline },
        update: { value: baseline },
      });
    }
    await saveSwitch(this.prisma, ENABLED_KEY, enabled);
    return this.status();
  }

  async sendNow(): Promise<MilestonePost> {
    const page = facebookPage();
    if (!page) throw new BadRequestException(NOT_SET_UP);

    const [all, settled] = await Promise.all([
      this.highest(),
      this.highest({ NOT: staleClaims() }),
    ]);
    const latest = (
      await this.candidates(
        ({ scope, members }) =>
          members > (settled.get(scope) ?? 0) &&
          members >= (all.get(scope) ?? 0),
      )
    ).at(-1);
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
    if (!(await this.enabled())) return;
    const [highest, baseline] = await Promise.all([
      this.highest(),
      this.baseline(),
    ]);
    const due = await this.candidates(
      ({ scope, members }) =>
        members > Math.max(highest.get(scope) ?? 0, baseline[scope] ?? 0),
    );
    for (const milestone of due) {
      try {
        if (await this.post(page, milestone)) return;
      } catch (error) {
        if (error instanceof UnclearPostError) return;
        if (error instanceof FacebookError) {
          this.logger.warn(
            `Facebook refused ${milestoneLabel(milestone)}: ${error.message}`,
          );
        } else if (!(error instanceof MilestoneImageError)) {
          throw error;
        }
      }
    }
  }

  private enabled() {
    return readSwitch(this.prisma, ENABLED_KEY, false);
  }

  private async baseline() {
    const setting = await this.prisma.setting.findUnique({
      where: { key: BASELINE_KEY },
      select: { value: true },
    });
    return JSON.parse(setting?.value ?? '{}') as Record<string, number>;
  }

  private async highest(where?: Prisma.FacebookMilestonePostWhereInput) {
    const posted = await this.prisma.facebookMilestonePost.groupBy({
      by: ['scope'],
      where,
      _max: { members: true },
    });
    return new Map(posted.map(({ scope, _max }) => [scope, _max.members ?? 0]));
  }

  private async milestones(
    where: Prisma.CommunityWhereInput,
  ): Promise<ScopeMilestone[]> {
    const [users, communities] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.community.findMany({
        where,
        select: {
          id: true,
          name: true,
          _count: { select: { memberships: true } },
        },
      }),
    ]);
    return [
      { scope: ORBIS_SCOPE, count: users, community: null },
      ...communities.map(({ id, name, _count }) => ({
        scope: `community:${id}`,
        count: _count.memberships,
        community: { id, name },
      })),
    ].flatMap(({ count, ...scope }) => {
      const members = milestoneReached(count);
      return members === null ? [] : [{ ...scope, members }];
    });
  }

  private async candidates(
    isDue: (milestone: ScopeMilestone) => boolean,
  ): Promise<Milestone[]> {
    const due = (await this.milestones({ isPublic: true })).filter(isDue);
    const reached = await Promise.all(
      due.map(async (milestone) => ({
        ...milestone,
        reachedAt: await this.reachedAt(milestone),
      })),
    );
    return reached
      .flatMap(({ reachedAt, ...milestone }) =>
        reachedAt ? [{ ...milestone, reachedAt }] : [],
      )
      .sort((a, b) => a.reachedAt.getTime() - b.reachedAt.getTime());
  }

  private async reachedAt({ members, community }: ScopeMilestone) {
    if (!community) {
      const user = await this.prisma.user.findFirst({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: members - 1,
        select: { createdAt: true },
      });
      return user?.createdAt ?? null;
    }
    const membership = await this.prisma.membership.findFirst({
      where: { communityId: community.id },
      orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
      skip: members - 1,
      select: { joinedAt: true },
    });
    return membership?.joinedAt ?? null;
  }

  private async post(
    page: FacebookPage,
    milestone: Milestone,
  ): Promise<MilestonePost | null> {
    const { scope, members, community } = milestone;
    const data = await fetchImage(
      milestoneImageUrl(members, community),
      IMAGE_TIMEOUT_MS,
    ).catch((error: Error) => {
      this.logger.warn(
        `Couldn’t load the image for ${milestoneLabel(milestone)}: ${error.message}`,
      );
      throw new MilestoneImageError(error.message);
    });
    const key = { scope, members };
    const postId = await this.postOnce({
      page,
      image: {
        filename: community
          ? `orbis-${community.id}-milestone-${members}.png`
          : `orbis-milestone-${members}.png`,
        data,
      },
      message: milestoneMessage(members, community),
      label: milestoneLabel(milestone),
      claim: async () => {
        await this.prisma.facebookMilestonePost.deleteMany({
          where: { ...key, ...staleClaims() },
        });
        await this.prisma.facebookMilestonePost.create({
          data: { ...key, communityId: community?.id ?? null },
        });
        const higher = await this.prisma.facebookMilestonePost.count({
          where: { scope, members: { gt: members } },
        });
        if (higher === 0) return true;
        await this.prisma.facebookMilestonePost.deleteMany({ where: key });
        return false;
      },
      release: () =>
        this.prisma.facebookMilestonePost.deleteMany({ where: key }),
      confirm: (postId) =>
        this.prisma.facebookMilestonePost.update({
          where: { scope_members: key },
          data: { postId },
        }),
    });
    return postId ? { postId, members, community } : null;
  }
}
