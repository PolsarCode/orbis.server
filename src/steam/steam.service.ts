import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isUniqueViolation } from '../common/prisma-errors';
import { webUrl } from '../common/web-url';
import { PresenceGateway } from '../friends/presence.gateway';
import { SteamSyncService } from '../library/steam-sync.service';
import { PrismaService } from '../prisma.service';
import { ConnectSteamDto } from './dto/connect-steam.dto';
import {
  getPersonaName,
  openIdUrl,
  steamApiKey,
  verifyOpenId,
} from './steam-api';

export type SteamStatus = {
  enabled: boolean;
  account: {
    steamId: string;
    personaName: string;
    trackGames: boolean;
    showPlaying: boolean;
    gamesPrivate: boolean;
    connectedAt: Date;
    games: number;
    matched: number;
    importable: number;
  } | null;
};

type StateClaims = { nonce: string; uid: number };

const EXPIRED = 'That Steam link expired. Please try again';
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const CONNECT_WAIT_MS = 5_000;

function stateSecret() {
  return `${process.env.JWT_SECRET}:steam-state`;
}

function callbackUrl() {
  return `${webUrl()}/auth/steam/callback`;
}

@Injectable()
export class SteamService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private steamSync: SteamSyncService,
    private presence: PresenceGateway,
  ) {}

  async status(userId: number): Promise<SteamStatus> {
    const enabled = Boolean(steamApiKey());
    const account = await this.prisma.steamAccount.findUnique({
      where: { userId },
      select: {
        steamId: true,
        personaName: true,
        trackGames: true,
        showPlaying: true,
        gamesPrivate: true,
        createdAt: true,
      },
    });
    if (!account) return { enabled, account: null };

    const [games, matched, played, entries] = await Promise.all([
      this.prisma.steamGame.count({ where: { userId } }),
      this.prisma.steamGame.count({ where: { userId, igdbId: { not: null } } }),
      this.prisma.steamGame.findMany({
        where: { userId, minutes: { gt: 0 }, igdbId: { not: null } },
        select: { igdbId: true },
      }),
      this.prisma.libraryEntry.findMany({
        where: { userId, mediaType: 'game' },
        select: { sourceId: true },
      }),
    ]);
    const owned = new Set(entries.map((entry) => entry.sourceId));
    const importable = new Set(
      played.map((game) => game.igdbId!).filter((igdbId) => !owned.has(igdbId)),
    ).size;
    const { createdAt, ...rest } = account;
    return {
      enabled,
      account: { ...rest, connectedAt: createdAt, games, matched, importable },
    };
  }

  connectUrl(userId: number, nonce: string) {
    if (!steamApiKey()) {
      throw new ServiceUnavailableException('Steam isn’t set up yet');
    }
    if (!NONCE_PATTERN.test(nonce)) throw new BadRequestException(EXPIRED);

    const claims: StateClaims = { nonce, uid: userId };
    const state = this.jwt.sign(claims, {
      secret: stateSecret(),
      expiresIn: '10m',
    });
    return openIdUrl(
      `${callbackUrl()}?${new URLSearchParams({ state })}`,
      webUrl(),
    );
  }

  async connect(userId: number, { state, nonce, params }: ConnectSteamDto) {
    let claims: StateClaims;
    try {
      claims = this.jwt.verify<StateClaims>(state, { secret: stateSecret() });
    } catch {
      throw new BadRequestException(EXPIRED);
    }
    if (claims.nonce !== nonce) throw new BadRequestException(EXPIRED);
    if (claims.uid !== userId) {
      throw new ForbiddenException(
        'Log in to the account you’re connecting, then try again',
      );
    }

    let steamId: string | null;
    try {
      steamId = await verifyOpenId(params, callbackUrl());
    } catch {
      throw new BadGatewayException('Couldn’t reach Steam. Please try again');
    }
    if (!steamId) {
      throw new BadRequestException(
        'Steam couldn’t confirm your account. Please try again',
      );
    }

    const personaName = await getPersonaName(steamId).catch(() => steamId);
    const existing = await this.prisma.steamAccount.findUnique({
      where: { userId },
      select: { steamId: true },
    });
    if (existing && existing.steamId !== steamId) await this.clear(userId);

    try {
      await this.prisma.steamAccount.upsert({
        where: { userId },
        create: { userId, steamId, personaName },
        update: { personaName },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'That Steam account is already connected to another Orbis account',
        );
      }
      throw error;
    }

    await this.steamSync.refresh(userId, {
      waitMs: CONNECT_WAIT_MS,
      force: true,
    });
    return this.status(userId);
  }

  async updateSettings(
    userId: number,
    changes: { trackGames?: boolean; showPlaying?: boolean },
  ) {
    const { count } = await this.prisma.steamAccount.updateMany({
      where: { userId },
      data: changes,
    });
    if (count === 0) throw new NotFoundException('Steam isn’t connected');
    if (changes.showPlaying === false) await this.presence.stopPlaying(userId);
    return this.status(userId);
  }

  async importPlayed(userId: number) {
    const account = await this.prisma.steamAccount.findUnique({
      where: { userId },
      select: { userId: true },
    });
    if (!account) throw new NotFoundException('Steam isn’t connected');
    const imported = await this.steamSync.importPlayed(userId);
    return { imported, status: await this.status(userId) };
  }

  async disconnect(userId: number) {
    const account = await this.prisma.steamAccount.findUnique({
      where: { userId },
      select: { userId: true },
    });
    if (!account) throw new NotFoundException('Steam isn’t connected');
    await this.clear(userId);
    await this.presence.stopPlaying(userId);
  }

  private clear(userId: number) {
    return this.prisma.$transaction([
      this.prisma.$executeRaw`
        UPDATE "LibraryEntry" SET "steamAppId" = NULL
        WHERE "userId" = ${userId} AND "steamAppId" IS NOT NULL`,
      this.prisma.steamGame.deleteMany({ where: { userId } }),
      this.prisma.steamAccount.deleteMany({ where: { userId } }),
    ]);
  }
}
