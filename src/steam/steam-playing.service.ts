import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { getPlayingGames, steamApiKey } from './steam-api';
import { PrismaService } from '../prisma.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { SteamSyncService } from '../library/steam-sync.service';

const POLL_MS = 60_000;
const BATCH_SIZE = 100;
const SYNC_AFTER_PLAYING_MS = 5 * 60_000;

@Injectable()
export class SteamPlayingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SteamPlayingService.name);
  private timer?: NodeJS.Timeout;
  private online?: Subscription;
  private playing = new Map<number, string>();
  private syncs = new Map<number, NodeJS.Timeout>();

  constructor(
    private prisma: PrismaService,
    private presence: PresenceGateway,
    private steamSync: SteamSyncService,
  ) {}

  onModuleInit() {
    if (!steamApiKey()) return;
    this.online = this.presence.cameOnline.subscribe(
      (userId) => void this.steamSync.refresh(userId),
    );
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref();
    void this.poll();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
    this.online?.unsubscribe();
    for (const timer of this.syncs.values()) clearTimeout(timer);
    this.syncs.clear();
  }

  async poll() {
    try {
      const accounts = await this.prisma.steamAccount.findMany({
        where: { showPlaying: true },
        select: { userId: true, steamId: true },
      });

      const playing = new Map<number, string>();
      for (let start = 0; start < accounts.length; start += BATCH_SIZE) {
        const batch = accounts.slice(start, start + BATCH_SIZE);
        const games = await getPlayingGames(
          batch.map((account) => account.steamId),
        );
        for (const account of batch) {
          const game = games.get(account.steamId);
          if (game) playing.set(account.userId, game);
        }
      }

      for (const [userId, game] of this.playing) {
        if (playing.get(userId) !== game) this.syncLater(userId);
      }
      this.playing = playing;
      await this.presence.updatePlaying(playing);
    } catch (error) {
      this.logger.warn(
        `Steam playing check failed: ${(error as Error).message}`,
      );
    }
  }

  private syncLater(userId: number) {
    if (this.syncs.has(userId)) return;
    const timer = setTimeout(() => {
      this.syncs.delete(userId);
      void this.steamSync.refresh(userId, { force: true });
    }, SYNC_AFTER_PLAYING_MS);
    timer.unref();
    this.syncs.set(userId, timer);
  }
}
