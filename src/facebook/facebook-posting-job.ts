import {
  BadGatewayException,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { runLocked } from '../common/locked-job';
import { isUniqueViolation } from '../common/prisma-errors';
import { ChartImage } from '../library/chart-share.service';
import { PrismaService } from '../prisma.service';
import {
  FacebookError,
  FacebookPage,
  facebookPage,
  postPhoto,
} from './facebook-page';

export class UnclearPostError extends Error {}

export function postFailed(error: unknown, postedSoFar = '') {
  return new BadGatewayException(
    `${postedSoFar}${
      error instanceof FacebookError
        ? `Facebook said: ${error.message.replace(/\.$/, '')}`
        : 'Facebook didn’t answer. Check the Page before trying again, in case it was posted'
    }`,
  );
}

type PostingJob = { every: number; lock: number; failure: string };

type PostOnce = {
  page: FacebookPage;
  image: Pick<ChartImage, 'filename' | 'data'>;
  message: string;
  label: string;
  claim: () => Promise<unknown>;
  release: () => Promise<unknown>;
  confirm: (postId: string) => Promise<unknown>;
};

export abstract class FacebookPostingJob
  implements OnModuleInit, OnModuleDestroy
{
  protected readonly logger = new Logger(this.constructor.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    protected readonly prisma: PrismaService,
    private readonly job: PostingJob,
  ) {}

  onModuleInit() {
    if (!facebookPage()) return;
    this.timer = setInterval(() => void this.run(), this.job.every);
    this.timer.unref();
    void this.run();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async run() {
    const page = facebookPage();
    if (!page || this.running) return;
    this.running = true;
    try {
      await runLocked(this.prisma, this.job.lock, this.job.every, () =>
        this.postDue(page),
      );
    } catch (error) {
      this.logger.warn(`${this.job.failure}: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  protected abstract postDue(page: FacebookPage): Promise<void>;

  protected async postOnce({
    page,
    image,
    message,
    label,
    claim,
    release,
    confirm,
  }: PostOnce) {
    try {
      if ((await claim()) === false) return null;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }

    let postId: string;
    try {
      postId = await postPhoto(page, image, message);
    } catch (error) {
      if (error instanceof FacebookError) {
        await release();
        throw error;
      }
      this.logger.warn(
        `Facebook didn’t answer when posting ${label}, so it won’t be tried again in case it went through: ${(error as Error).message}`,
      );
      throw new UnclearPostError((error as Error).message);
    }
    await confirm(postId);
    return postId;
  }
}
