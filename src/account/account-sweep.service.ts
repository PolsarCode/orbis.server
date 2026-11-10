import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { runLocked } from '../common/locked-job';
import { StorageService } from '../storage/storage.service';
import { CommunitiesService } from '../communities/communities.service';
import { communitySuccessor } from '../communities/successor';
import { MessagesService } from '../messages/messages.service';
import { ForumService } from '../forum/forum.service';
import { PostsService } from '../posts/posts.service';
import { LibraryService } from '../library/library.service';
import { CommentsService } from '../comments/comments.service';
import { LikesService } from '../likes/likes.service';
import { DAY, HOUR } from '../common/throttle';
import { ignoreMissing } from '../common/not-found';

const SWEEP_MS = HOUR;
const SWEEP_BATCH = 20;
const SWEEP_LOCK = 727_012_050;

@Injectable()
export class AccountSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountSweepService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private failures = new Map<number, number>();

  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private communities: CommunitiesService,
    private messages: MessagesService,
    private forum: ForumService,
    private posts: PostsService,
    private library: LibraryService,
    private comments: CommentsService,
    private likes: LikesService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref();
    void this.sweep();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async sweep() {
    if (this.running) return;
    this.running = true;
    try {
      await runLocked(this.prisma, SWEEP_LOCK, SWEEP_MS, () =>
        this.deleteDue(),
      );
    } catch (error) {
      this.logger.warn(
        `Account deletion sweep failed: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async deleteDue() {
    const now = Date.now();
    for (const [id, failedAt] of this.failures) {
      if (now - failedAt > DAY) this.failures.delete(id);
    }
    const due = await this.prisma.user.findMany({
      where: {
        deleteAt: { lte: new Date(now) },
        id: { notIn: [...this.failures.keys()] },
      },
      orderBy: { deleteAt: 'asc' },
      take: SWEEP_BATCH,
      select: { id: true },
    });
    for (const { id } of due) {
      try {
        await this.deleteAccount(id);
      } catch (error) {
        this.failures.set(id, Date.now());
        this.logger.warn(
          `Couldn’t delete account ${id}: ${(error as Error).message}`,
        );
      }
    }
  }

  async deleteAccount(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        deleteAt: true,
        avatarUrl: true,
        coverUrl: true,
        backgroundUrl: true,
      },
    });
    if (!user?.deleteAt || user.deleteAt > new Date()) return false;

    await this.passOnCommunities(userId);
    await this.messages.removeUser(userId);
    await this.removeForumContent(userId);
    await this.removePosts(userId);
    await this.removeLibrary(userId);
    await this.removeComments(userId);
    await this.likes.removeAllBy(userId);

    const placeholders = await this.prisma.comment.findMany({
      where: { authorId: userId },
      select: { id: true },
    });
    await this.prisma.$transaction([
      this.prisma.contentReport.deleteMany({
        where: {
          OR: [
            { targetType: 'user', targetId: userId },
            {
              targetType: 'comment',
              targetId: { in: placeholders.map(({ id }) => id) },
            },
          ],
        },
      }),
      this.prisma.notification.deleteMany({ where: { actorId: userId } }),
      this.prisma.user.delete({ where: { id: userId } }),
    ]);

    await this.storage.deleteUrl(user.avatarUrl);
    await this.storage.deleteUrl(user.coverUrl);
    await this.storage.deleteUrl(user.backgroundUrl);
    return true;
  }

  private async passOnCommunities(userId: number) {
    const owned = await this.prisma.community.findMany({
      where: { ownerId: userId },
      select: { id: true },
    });
    for (const { id } of owned) {
      const successor = await communitySuccessor(this.prisma, id, userId);
      if (successor) {
        await this.prisma.$transaction([
          this.prisma.community.update({
            where: { id },
            data: { ownerId: successor.id },
          }),
          this.prisma.invite.updateMany({
            where: { communityId: id, creatorId: userId },
            data: { creatorId: successor.id },
          }),
        ]);
      } else {
        await this.communities.remove(userId, id);
      }
    }
  }

  private async removeForumContent(userId: number) {
    const threads = await this.prisma.forumThread.findMany({
      where: { authorId: userId },
      select: { id: true, communityId: true },
    });
    for (const { id, communityId } of threads) {
      await this.forum
        .removeThread(userId, communityId, id)
        .catch(ignoreMissing);
    }

    const posts = await this.prisma.forumPost.findMany({
      where: { authorId: userId },
      orderBy: { id: 'desc' },
      select: { id: true, communityId: true },
    });
    for (const { id, communityId } of posts) {
      await this.forum.removePost(userId, communityId, id).catch(ignoreMissing);
    }
  }

  private async removePosts(userId: number) {
    const posts = await this.prisma.post.findMany({
      where: { OR: [{ authorId: userId }, { wallUserId: userId }] },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    for (const { id } of posts) {
      await this.posts.remove(userId, id).catch(ignoreMissing);
    }
  }

  private async removeLibrary(userId: number) {
    const entries = await this.prisma.libraryEntry.findMany({
      where: { userId },
      select: { id: true },
    });
    for (const { id } of entries) {
      await this.library.remove(userId, id).catch(ignoreMissing);
    }
  }

  private async removeComments(userId: number) {
    const comments = await this.prisma.comment.findMany({
      where: { authorId: userId, deletedAt: null },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    for (const { id } of comments) {
      await this.comments.remove(userId, id).catch(ignoreMissing);
    }
  }
}
