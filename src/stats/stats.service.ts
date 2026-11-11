import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MINUTE } from '../common/throttle';
import {
  FacebookPage,
  facebookPage,
  NOT_SET_UP,
  pageFollowers,
} from '../facebook/facebook-page';
import { PrismaService } from '../prisma.service';

const FOLLOWERS_CACHE_MS = 5 * MINUTE;

export type Stats = {
  members: number;
  communities: number;
  posts: number;
  comments: number;
  facebookFollowers: number | null;
};

@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);
  private followers?: { count: number | null; checkedAt: number };
  private loading?: Promise<number | null>;

  constructor(private prisma: PrismaService) {}

  async summary(): Promise<Stats> {
    const [members, communities, posts, comments, facebookFollowers] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.community.count(),
        this.prisma.post.count(),
        this.prisma.comment.count(),
        this.facebookFollowers(),
      ]);

    return { members, communities, posts, comments, facebookFollowers };
  }

  async facebookFollowers(): Promise<number | null> {
    const page = facebookPage();
    if (!page) return null;
    const checked = this.followers;
    if (
      !this.loading &&
      (!checked || checked.checkedAt + FOLLOWERS_CACHE_MS <= Date.now())
    ) {
      this.loading = this.loadFollowers(page);
    }
    return checked?.count ?? this.loading ?? null;
  }

  async refreshFacebookFollowers(): Promise<number> {
    const page = facebookPage();
    if (!page) throw new BadRequestException(NOT_SET_UP);
    const count = await pageFollowers(page);
    this.followers = { count, checkedAt: Date.now() };
    return count;
  }

  private async loadFollowers(page: FacebookPage) {
    try {
      const count = await pageFollowers(page);
      this.followers = { count, checkedAt: Date.now() };
    } catch (error) {
      this.logger.warn(
        `Couldn’t load the Facebook Page’s followers: ${(error as Error).message}`,
      );
      this.followers = {
        count: this.followers?.count ?? null,
        checkedAt: Date.now(),
      };
    } finally {
      this.loading = undefined;
    }
    return this.followers.count;
  }
}
