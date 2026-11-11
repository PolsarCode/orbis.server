import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { MediaType } from '../../prisma/generated/client';
import { GUEST_USER_ID } from '../auth/allow-guest';
import { CommunitiesService } from '../communities/communities.service';
import { fetchImage } from '../common/fetch-image';
import { DAY, MINUTE } from '../common/throttle';
import { webUrl } from '../common/web-url';
import { dayKey, startOfDay } from '../common/weekly-window';
import {
  CHART_LABELS,
  CHART_TYPES,
  ChartShareService,
  typeList,
  weekRange,
} from '../library/chart-share.service';
import { LibraryService } from '../library/library.service';
import { PrismaService } from '../prisma.service';
import { TagsService } from '../tags/tags.service';
import {
  FacebookError,
  FacebookPage,
  facebookPage,
  NOT_SET_UP,
  postPhoto,
  setCover,
  uploadPhoto,
} from './facebook-page';
import {
  communityCaption,
  comingCaption,
  debateCaption,
  FACEBOOK_POST_KINDS,
  facebookImage,
  FacebookPostKind,
  hashtagsCaption,
  isSeasonKind,
  mostAddedCaption,
  postingStarted,
  rotation,
  Season,
  seasonCaption,
  seasonFor,
  SeasonKind,
  seasonTypesDue,
  spotlightCaption,
  Tip,
  tipCaption,
  typeLabel,
  weeklyDue,
  WeeklyKind,
} from './facebook-post-kinds';
import {
  FacebookPostingJob,
  postFailed,
  UnclearPostError,
} from './facebook-posting-job';
import { readSwitch, saveSwitch } from './facebook-switch';

const CHECK_MS = 10 * MINUTE;
const POST_LOCK = 727_012_055;
const IMAGE_TIMEOUT_MS = 30_000;
const TIP_TIMEOUT_MS = 10_000;
const WEEK_MS = 7 * DAY;
const SPOTLIGHT_WEEKS = 26;
const COMMUNITY_WEEKS = 8;
const MIN_COMMENTS = 3;
const MIN_ADDED = 3;
const MIN_TAGS = 3;
const MIN_GAINED = 3;
const MIN_SEASON = 4;
const MIN_COMING = 3;

const NOTHING_TO_POST: Record<FacebookPostKind, string> = {
  cover: 'This week’s charts aren’t all ready yet',
  spotlight:
    'Everything on this week’s chart with a synopsis and an image has been in the spotlight lately',
  debate: `This week’s charts don’t have ${MIN_COMMENTS} comments yet`,
  'most-added': `Nothing has been added to libraries ${MIN_ADDED} times this week yet`,
  hashtags: `Fewer than ${MIN_TAGS} hashtags were used this week`,
  community: `No community has gained ${MIN_GAINED} members this week, apart from ones featured lately`,
  tip: 'There’s no tip of the week to post',
  season: 'This season doesn’t have enough titles to post yet',
  coming: 'Next season doesn’t have enough titles to post yet',
};

export type FacebookPostsStatus = {
  configured: boolean;
  posts: {
    kind: FacebookPostKind;
    enabled: boolean;
    lastPost: {
      period: string;
      label: string;
      postId: string | null;
      postedAt: string;
    } | null;
  }[];
};

type Target = {
  type?: MediaType;
  subject: string | null;
  label: string;
  image: string;
  message: string;
};

type Slot = { period: string; pick: () => Promise<Target | null> };

function switchKey(kind: FacebookPostKind) {
  return `facebook.posts.${kind}`;
}

function filename(kind: FacebookPostKind, period: string) {
  return `orbis-${kind}-${period.replace(/:/g, '-')}.png`;
}

function tipFrom(value: unknown): Tip | null {
  const { id, title, body, href } = (value ?? {}) as Record<string, unknown>;
  if (
    typeof id !== 'string' ||
    typeof title !== 'string' ||
    typeof body !== 'string'
  ) {
    return null;
  }
  return {
    id,
    title,
    body,
    href: typeof href === 'string' && href.startsWith('/') ? href : null,
  };
}

@Injectable()
export class FacebookPostsService extends FacebookPostingJob {
  constructor(
    prisma: PrismaService,
    private charts: ChartShareService,
    private library: LibraryService,
    private tags: TagsService,
    private communities: CommunitiesService,
  ) {
    super(prisma, {
      every: CHECK_MS,
      lock: POST_LOCK,
      failure: 'Posting to Facebook failed',
    });
  }

  async status(): Promise<FacebookPostsStatus> {
    const posts = await Promise.all(
      FACEBOOK_POST_KINDS.map(async (kind) => {
        const [enabled, lastPost] = await Promise.all([
          this.enabled(kind),
          this.prisma.facebookPost.findFirst({
            where: { kind },
            orderBy: { createdAt: 'desc' },
            select: {
              period: true,
              label: true,
              postId: true,
              createdAt: true,
            },
          }),
        ]);
        return {
          kind,
          enabled,
          lastPost: lastPost && {
            period: lastPost.period,
            label: lastPost.label,
            postId: lastPost.postId,
            postedAt: lastPost.createdAt.toISOString(),
          },
        };
      }),
    );
    return { configured: facebookPage() !== null, posts };
  }

  async setEnabled(kind: FacebookPostKind, enabled: boolean) {
    await saveSwitch(this.prisma, switchKey(kind), enabled);
    return this.status();
  }

  async sendNow(kind: FacebookPostKind) {
    const page = facebookPage();
    if (!page) throw new BadRequestException(NOT_SET_UP);

    const picked = await this.pickNow(kind).catch((error: Error) => {
      if (error instanceof HttpException) throw error;
      this.logger.warn(`Couldn’t get the ${kind} post ready: ${error.message}`);
      throw new BadGatewayException(
        'Couldn’t get this post ready. Try again in a moment',
      );
    });
    if (picked.length === 0) {
      throw new BadRequestException(NOTHING_TO_POST[kind]);
    }

    const posted: MediaType[] = [];
    const postIds: string[] = [];
    for (const { period, target } of picked) {
      const postedSoFar = posted.length
        ? `Posted ${typeList(posted)}, then `
        : '';
      postIds.push(await this.postNow(page, kind, period, target, postedSoFar));
      if (target.type) posted.push(target.type);
    }
    return { postIds };
  }

  protected async postDue(page: FacebookPage) {
    const now = new Date(Date.now());
    if (!postingStarted(now)) return;
    for (const kind of FACEBOOK_POST_KINDS) {
      try {
        if (!(await this.enabled(kind))) continue;
        for (const { period, pick } of await this.slots(kind, now, true)) {
          if (await this.posted(kind, period)) continue;
          const target = await pick();
          if (target) await this.post(page, kind, period, target);
        }
      } catch (error) {
        if (error instanceof UnclearPostError) continue;
        this.logger.warn(
          `Posting the ${kind} post to Facebook failed: ${(error as Error).message}`,
        );
      }
    }
  }

  private enabled(kind: FacebookPostKind) {
    return readSwitch(this.prisma, switchKey(kind), false);
  }

  private async posted(kind: FacebookPostKind, period: string) {
    const post = await this.prisma.facebookPost.findUnique({
      where: { kind_period: { kind, period } },
      select: { period: true },
    });
    return post !== null;
  }

  private async pickNow(kind: FacebookPostKind) {
    const slots = await this.slots(kind, new Date(Date.now()), false);
    const picked: { period: string; target: Target }[] = [];
    for (const { period, pick } of slots) {
      const target = await pick();
      if (target) picked.push({ period, target });
    }
    return picked;
  }

  private async slots(
    kind: FacebookPostKind,
    now: Date,
    scheduled: boolean,
  ): Promise<Slot[]> {
    if (isSeasonKind(kind)) {
      const season = seasonFor(kind, now);
      const types = scheduled ? seasonTypesDue(kind, now) : CHART_TYPES;
      return types.map((type) => ({
        period: `${season.id}:${type}`,
        pick: () => this.season(kind, season, type),
      }));
    }
    if (scheduled && !weeklyDue(kind, now)) return [];
    const { week } = await this.charts.current(MediaType.anime);
    return [{ period: week, pick: () => this.weekly(kind, week, now) }];
  }

  private weekly(kind: WeeklyKind, week: string, now: Date) {
    switch (kind) {
      case 'cover':
        return this.cover(week);
      case 'spotlight':
        return this.spotlight(week, now);
      case 'debate':
        return this.debate(week);
      case 'most-added':
        return this.mostAdded(week, startOfDay(now));
      case 'hashtags':
        return this.hashtags(startOfDay(now));
      case 'community':
        return this.community(startOfDay(now), now);
      case 'tip':
        return this.tip(week);
    }
  }

  private async cover(week: string): Promise<Target | null> {
    const charts = await Promise.all(
      CHART_TYPES.map((type) => this.charts.current(type)),
    );
    if (charts.some((chart) => chart.week !== week)) return null;
    return {
      subject: null,
      label: `Trending · ${weekRange(charts[0])}`,
      image: facebookImage('cover', { week }),
      message: '',
    };
  }

  private async spotlight(week: string, now: Date): Promise<Target | null> {
    const [type] = rotation(week);
    const [chart, recent] = await Promise.all([
      this.charts.current(type),
      this.recentSubjects('spotlight', SPOTLIGHT_WEEKS, now),
    ]);
    const media = [...chart.entries]
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => entry.media)
      .find(
        ({ sourceId, synopsis, bannerImage, coverImage }) =>
          synopsis?.trim() &&
          (bannerImage || coverImage) &&
          !recent.includes(`${type}:${sourceId}`),
      );
    if (!media?.synopsis) return null;
    return {
      type,
      subject: `${type}:${media.sourceId}`,
      label: media.title,
      image: facebookImage(
        `spotlight/${type}/${encodeURIComponent(media.sourceId)}`,
      ),
      message: spotlightCaption(type, { ...media, synopsis: media.synopsis }),
    };
  }

  private async debate(week: string): Promise<Target | null> {
    const discussions = await this.prisma.chartDiscussion.findMany({
      where: { week },
      select: { mediaType: true, commentCount: true },
    });
    const comments = (type: MediaType) =>
      discussions.find(({ mediaType }) => mediaType === type)?.commentCount ??
      0;
    const type = CHART_TYPES.reduce((best, type) =>
      comments(type) > comments(best) ? type : best,
    );
    const count = comments(type);
    if (count < MIN_COMMENTS) return null;
    return {
      type,
      subject: null,
      label: `${CHART_LABELS[type]} chart · ${count.toLocaleString('en-US')} comments`,
      image: facebookImage(`debate/${type}`, { week }),
      message: debateCaption(type, week, count),
    };
  }

  private async mostAdded(week: string, until: Date): Promise<Target | null> {
    for (const type of rotation(week)) {
      const { items } = await this.library.mostAdded(type, until);
      if (items.length < MIN_ADDED) continue;
      return {
        type,
        subject: null,
        label: `Most added ${typeLabel(type)}`,
        image: facebookImage(`most-added/${type}`, { until: dayKey(until) }),
        message: mostAddedCaption(
          type,
          items.slice(0, MIN_ADDED).map(({ media }) => media.title),
        ),
      };
    }
    return null;
  }

  private async hashtags(until: Date): Promise<Target | null> {
    const { tags } = await this.tags.weekly(until);
    if (tags.length < MIN_TAGS) return null;
    return {
      subject: null,
      label: `#${tags[0].display}`,
      image: facebookImage('hashtags', { until: dayKey(until) }),
      message: hashtagsCaption(tags),
    };
  }

  private async community(until: Date, now: Date): Promise<Target | null> {
    const featured = await this.recentSubjects(
      'community',
      COMMUNITY_WEEKS,
      now,
    );
    const top = await this.communities.topGrowing(
      until,
      featured.map(Number).filter(Number.isInteger),
    );
    if (!top || top.gained < MIN_GAINED) return null;
    const community = await this.communities.weekly(top.id, until);
    return {
      subject: String(community.id),
      label: community.name,
      image: facebookImage(`community/${community.id}`, {
        until: dayKey(until),
      }),
      message: communityCaption(community),
    };
  }

  private async tip(week: string): Promise<Target> {
    const response = await fetch(
      `${webUrl()}/facebook/tip?${new URLSearchParams({ week })}`,
      { signal: AbortSignal.timeout(TIP_TIMEOUT_MS) },
    );
    if (!response.ok) {
      throw new Error(`The website responded with ${response.status}`);
    }
    const tip = tipFrom(await response.json());
    if (!tip) throw new Error('The website didn’t send a tip of the week');
    return {
      subject: tip.id,
      label: tip.title,
      image: facebookImage('tip', { week }),
      message: tipCaption(tip),
    };
  }

  private async season(
    kind: SeasonKind,
    season: Season,
    type: MediaType,
  ): Promise<Target | null> {
    const { items } = await this.library.season(GUEST_USER_ID, type, season.id);
    if (items.length < (kind === 'season' ? MIN_SEASON : MIN_COMING)) {
      return null;
    }
    return {
      type,
      subject: null,
      label: `${season.title} ${typeLabel(type)}`,
      image: facebookImage(`season/${type}`, { season: season.id }),
      message:
        kind === 'season'
          ? seasonCaption(type, season)
          : comingCaption(type, season),
    };
  }

  private async recentSubjects(
    kind: FacebookPostKind,
    weeks: number,
    now: Date,
  ) {
    const posts = await this.prisma.facebookPost.findMany({
      where: {
        kind,
        subject: { not: null },
        createdAt: { gte: new Date(now.getTime() - weeks * WEEK_MS) },
      },
      select: { subject: true },
    });
    return posts.flatMap(({ subject }) => (subject ? [subject] : []));
  }

  private async image(kind: FacebookPostKind, period: string, url: string) {
    return {
      filename: filename(kind, period),
      data: await fetchImage(url, IMAGE_TIMEOUT_MS),
    };
  }

  private publisher(
    page: FacebookPage,
    kind: FacebookPostKind,
    image: { filename: string; data: Buffer },
    message: string,
  ) {
    if (kind !== 'cover') return () => postPhoto(page, image, message);
    return async () => {
      const photoId = await uploadPhoto(page, image);
      try {
        await setCover(page, photoId);
      } catch (error) {
        throw new Error(
          `The cover photo was uploaded but couldn’t be set as the cover: ${(error as Error).message}`,
        );
      }
      return photoId;
    };
  }

  private async post(
    page: FacebookPage,
    kind: FacebookPostKind,
    period: string,
    target: Target,
  ) {
    const image = await this.image(kind, period, target.image);
    const key = { kind, period };
    await this.postOnce({
      page,
      image,
      message: target.message,
      label: `the ${kind} post for ${period}`,
      publish: this.publisher(page, kind, image, target.message),
      claim: () =>
        this.prisma.facebookPost.create({
          data: { ...key, subject: target.subject, label: target.label },
        }),
      release: () => this.prisma.facebookPost.deleteMany({ where: key }),
      confirm: (postId) =>
        this.prisma.facebookPost.update({
          where: { kind_period: key },
          data: { postId },
        }),
    });
  }

  private async postNow(
    page: FacebookPage,
    kind: FacebookPostKind,
    period: string,
    target: Target,
    postedSoFar: string,
  ) {
    const image = await this.image(kind, period, target.image).catch(
      (error: Error) => {
        this.logger.warn(
          `Couldn’t load the image for the ${kind} post for ${period}: ${error.message}`,
        );
        throw new BadGatewayException(
          `${postedSoFar}Couldn’t make the image for this post. Try again in a moment`,
        );
      },
    );
    let postId: string;
    try {
      postId = await this.publisher(page, kind, image, target.message)();
    } catch (error) {
      this.logger.warn(
        `Posting the ${kind} post for ${period} to Facebook failed: ${(error as Error).message}`,
      );
      if (!(error instanceof FacebookError)) {
        await this.record(kind, period, target, null);
      }
      throw postFailed(error, postedSoFar);
    }
    await this.record(kind, period, target, postId);
    return postId;
  }

  private record(
    kind: FacebookPostKind,
    period: string,
    { subject, label }: Target,
    postId: string | null,
  ) {
    return this.prisma.facebookPost.upsert({
      where: { kind_period: { kind, period } },
      create: { kind, period, subject, label, postId },
      update: postId
        ? { subject, label, postId, createdAt: new Date(Date.now()) }
        : {},
    });
  }
}
