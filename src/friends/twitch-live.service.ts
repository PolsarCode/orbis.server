import {
  BadGatewayException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  OAUTH_TIMEOUT_MS,
  oauthProviders,
} from '../auth/oauth/oauth-providers';
import { PrismaService } from '../prisma.service';
import { PresenceGateway } from './presence.gateway';

const POLL_MS = 60_000;
const BATCH_SIZE = 100;
const SCHEDULE_TTL_MS = 10 * 60_000;
const SCHEDULE_RETRY_MS = 60_000;
const SCHEDULE_TIMEOUT_MS = 3_000;
const SCHEDULE_SEGMENTS = 10;
const CLIPS_PAGE_SIZE = 24;
const CLIPS_TTL_MS = 5 * 60_000;
const CLIPS_CACHE_LIMIT = 500;

export type NextStream = {
  startsAt: string;
  endsAt: string | null;
  title: string | null;
  channel: string | null;
};

export type Clip = {
  id: string;
  title: string;
  url: string;
  thumbnailUrl: string;
  viewCount: number;
  duration: number;
  creatorName: string;
  createdAt: string;
};

export type ClipPage = { items: Clip[]; nextCursor: string | null };

type HelixClip = {
  id: string;
  title: string;
  url: string;
  thumbnail_url: string;
  view_count: number;
  duration: number;
  creator_name: string;
  created_at: string;
};

type ScheduleSegment = {
  start_time: string;
  end_time: string | null;
  title: string;
  canceled_until: string | null;
};

@Injectable()
export class TwitchLiveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TwitchLiveService.name);
  private timer?: NodeJS.Timeout;
  private appToken: { value: string; expiresAt: number } | null = null;
  private schedules = new Map<
    string,
    { value: NextStream | null; expiresAt: number }
  >();
  private clipPages = new Map<string, { value: ClipPage; expiresAt: number }>();

  constructor(
    private prisma: PrismaService,
    private presence: PresenceGateway,
  ) {}

  onModuleInit() {
    if (!this.credentials()) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref();
    void this.poll();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async poll() {
    try {
      const [accounts, communities] = await Promise.all([
        this.prisma.oAuthAccount.findMany({
          where: { provider: 'twitch', showLive: true },
          select: { userId: true, providerAccountId: true, username: true },
        }),
        this.prisma.community.findMany({
          where: { twitchUserId: { not: null }, showTwitchLive: true },
          select: { id: true, twitchUserId: true },
        }),
      ]);

      const channels = [
        ...new Set([
          ...accounts.map((account) => account.providerAccountId),
          ...communities.map((community) => community.twitchUserId!),
        ]),
      ];
      const liveIds = new Set<string>();
      for (let start = 0; start < channels.length; start += BATCH_SIZE) {
        for (const id of await this.liveStreams(
          channels.slice(start, start + BATCH_SIZE),
        )) {
          liveIds.add(id);
        }
      }

      await this.presence.updateLive(
        new Map(
          accounts
            .filter((account) => liveIds.has(account.providerAccountId))
            .map((account) => [account.userId, account.username]),
        ),
      );
      await this.presence.updateLiveCommunities(
        new Set(
          communities
            .filter((community) => liveIds.has(community.twitchUserId!))
            .map((community) => community.id),
        ),
      );
    } catch (error) {
      this.logger.warn(`Twitch live check failed: ${(error as Error).message}`);
    }
  }

  async nextStream(broadcasterId: string): Promise<NextStream | null> {
    const cached = this.schedules.get(broadcasterId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const credentials = this.credentials();
    if (!credentials) return null;

    try {
      const value = await this.schedule(broadcasterId, credentials);
      this.schedules.set(broadcasterId, {
        value,
        expiresAt: Math.min(
          Date.now() + SCHEDULE_TTL_MS,
          value ? Date.parse(value.startsAt) : Infinity,
        ),
      });
      return value;
    } catch (error) {
      this.logger.warn(
        `Twitch schedule check failed: ${(error as Error).message}`,
      );
      const value = cached?.value ?? null;
      this.schedules.set(broadcasterId, {
        value,
        expiresAt: Date.now() + SCHEDULE_RETRY_MS,
      });
      return value;
    }
  }

  async clips(broadcasterId: string, cursor?: string): Promise<ClipPage> {
    const key = `${broadcasterId}:${cursor ?? ''}`;
    const cached = this.clipPages.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const credentials = this.credentials();
    if (!credentials) return { items: [], nextCursor: null };

    const params = new URLSearchParams({
      broadcaster_id: broadcasterId,
      first: String(CLIPS_PAGE_SIZE),
    });
    if (cursor) params.set('after', cursor);

    let response: Response;
    try {
      response = await fetch(`https://api.twitch.tv/helix/clips?${params}`, {
        headers: {
          Authorization: `Bearer ${await this.token(credentials)}`,
          'Client-Id': credentials.clientId,
        },
        signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn(`Twitch clips failed: ${(error as Error).message}`);
      throw new BadGatewayException(
        'Couldn’t load clips from Twitch. Please try again.',
      );
    }
    if (response.status === 401) this.appToken = null;
    if (!response.ok) {
      this.logger.warn(`Twitch clips failed with ${response.status}`);
      throw new BadGatewayException(
        'Couldn’t load clips from Twitch. Please try again.',
      );
    }

    const { data, pagination } = (await response.json()) as {
      data: HelixClip[];
      pagination?: { cursor?: string };
    };
    const value: ClipPage = {
      items: data.map((clip) => ({
        id: clip.id,
        title: clip.title,
        url: clip.url,
        thumbnailUrl: clip.thumbnail_url,
        viewCount: clip.view_count,
        duration: clip.duration,
        creatorName: clip.creator_name,
        createdAt: clip.created_at,
      })),
      nextCursor:
        data.length === CLIPS_PAGE_SIZE ? (pagination?.cursor ?? null) : null,
    };

    if (this.clipPages.size >= CLIPS_CACHE_LIMIT) {
      for (const [entry, page] of this.clipPages) {
        if (page.expiresAt <= Date.now()) this.clipPages.delete(entry);
      }
      if (this.clipPages.size >= CLIPS_CACHE_LIMIT) this.clipPages.clear();
    }
    this.clipPages.set(key, { value, expiresAt: Date.now() + CLIPS_TTL_MS });
    return value;
  }

  private async schedule(
    broadcasterId: string,
    credentials: { clientId: string; clientSecret: string },
  ): Promise<NextStream | null> {
    const params = new URLSearchParams({
      broadcaster_id: broadcasterId,
      first: String(SCHEDULE_SEGMENTS),
    });
    const response = await fetch(
      `https://api.twitch.tv/helix/schedule?${params}`,
      {
        headers: {
          Authorization: `Bearer ${await this.token(credentials)}`,
          'Client-Id': credentials.clientId,
        },
        signal: AbortSignal.timeout(SCHEDULE_TIMEOUT_MS),
      },
    );
    if (response.status === 404) return null;
    if (response.status === 401) this.appToken = null;
    if (!response.ok) {
      throw new Error(`Schedule request failed with ${response.status}`);
    }

    const { data } = (await response.json()) as {
      data: {
        broadcaster_name?: string;
        segments: ScheduleSegment[] | null;
        vacation: { start_time: string; end_time: string } | null;
      };
    };
    const onVacation = (start: number) =>
      data.vacation !== null &&
      start >= Date.parse(data.vacation.start_time) &&
      start < Date.parse(data.vacation.end_time);
    const next = (data.segments ?? []).find(
      (segment) =>
        !segment.canceled_until && !onVacation(Date.parse(segment.start_time)),
    );

    return next
      ? {
          startsAt: next.start_time,
          endsAt: next.end_time ?? null,
          title: next.title || null,
          channel: data.broadcaster_name || null,
        }
      : null;
  }

  private credentials() {
    const clientId = oauthProviders.twitch.clientId();
    const clientSecret = oauthProviders.twitch.clientSecret();
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }

  private async liveStreams(ids: string[]) {
    const credentials = this.credentials();
    if (!credentials || ids.length === 0) return [];

    const params = new URLSearchParams({ first: String(BATCH_SIZE) });
    ids.forEach((id) => params.append('user_id', id));
    const response = await fetch(
      `https://api.twitch.tv/helix/streams?${params}`,
      {
        headers: {
          Authorization: `Bearer ${await this.token(credentials)}`,
          'Client-Id': credentials.clientId,
        },
        signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      },
    );
    if (response.status === 401) this.appToken = null;
    if (!response.ok)
      throw new Error(`Streams request failed with ${response.status}`);

    const { data } = (await response.json()) as {
      data: { user_id: string; type: string }[];
    };
    return data
      .filter((stream) => stream.type === 'live')
      .map((stream) => stream.user_id);
  }

  private async token({
    clientId,
    clientSecret,
  }: {
    clientId: string;
    clientSecret: string;
  }) {
    if (this.appToken && this.appToken.expiresAt > Date.now()) {
      return this.appToken.value;
    }

    const response = await fetch(oauthProviders.twitch.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(`Token request failed with ${response.status}`);

    const { access_token: value, expires_in: expiresIn } =
      (await response.json()) as { access_token: string; expires_in: number };
    this.appToken = {
      value,
      expiresAt: Date.now() + Math.max(expiresIn - 300, 60) * 1000,
    };
    return value;
  }
}
