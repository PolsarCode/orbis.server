import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '../../prisma/generated/client';
import { PresenceGateway } from '../friends/presence.gateway';
import { author } from '../common/author';
import { normalizeUsername } from '../users/username';
import {
  expiryOf,
  FilterDuration,
  MAX_KEYWORD_FILTERS,
  normalizePhrase,
  PHRASE_MAX,
} from './keywords';

export const MAX_BLOCKS = 1000;
export const MAX_MUTES = 1000;

const personSelect = author.select;

type Person = {
  id: number;
  username: string;
  name: string | null;
  avatarUrl: string | null;
};

export type BlockedPerson = Person & { blockedAt: Date };
export type MutedPerson = Person & { mutedAt: Date };

export type KeywordFilterView = {
  id: number;
  phrase: string;
  expiresAt: Date | null;
  createdAt: Date;
};

const filterSelect = {
  id: true,
  phrase: true,
  expiresAt: true,
  createdAt: true,
} as const;

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function between(userId: number, otherId: number) {
  return {
    OR: [
      { requesterId: userId, addresseeId: otherId },
      { requesterId: otherId, addresseeId: userId },
    ],
  };
}

function sharedFrom(userId: number, ownerId: number) {
  return {
    userId,
    OR: [
      { post: { authorId: ownerId } },
      { activity: { entry: { userId: ownerId } } },
    ],
  } satisfies Prisma.RepostWhereInput;
}

@Injectable()
export class SafetyService {
  constructor(
    private prisma: PrismaService,
    private presence: PresenceGateway,
  ) {}

  private async target(userId: number, username: string, action: string) {
    const target = await this.prisma.user.findUnique({
      where: { username: normalizeUsername(username) },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.id === userId) {
      throw new BadRequestException(`You can’t ${action} yourself`);
    }
    return target;
  }

  async blocks(userId: number): Promise<{ people: BlockedPerson[] }> {
    const blocks = await this.prisma.block.findMany({
      where: { blockerId: userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, blocked: { select: personSelect } },
    });
    return {
      people: blocks.map(({ createdAt, blocked }) => ({
        ...blocked,
        blockedAt: createdAt,
      })),
    };
  }

  async block(userId: number, username: string) {
    const target = await this.target(userId, username, 'block');
    const key = { blockerId: userId, blockedId: target.id };
    const existing = await this.prisma.block.findUnique({
      where: { blockerId_blockedId: key },
      select: { blockerId: true },
    });
    if (!existing) {
      const count = await this.prisma.block.count({
        where: { blockerId: userId },
      });
      if (count >= MAX_BLOCKS) {
        throw new BadRequestException('You can block up to 1,000 people');
      }
    }

    const [, { count: unfriended }] = await this.prisma.$transaction([
      this.prisma.block.upsert({
        where: { blockerId_blockedId: key },
        create: key,
        update: {},
      }),
      this.prisma.friendship.deleteMany({ where: between(userId, target.id) }),
      this.prisma.repost.deleteMany({
        where: {
          OR: [sharedFrom(userId, target.id), sharedFrom(target.id, userId)],
        },
      }),
    ]);
    if (unfriended > 0) {
      this.presence.notify([userId, target.id], 'friends:changed');
    }
    return { blocked: true };
  }

  async unblock(userId: number, username: string) {
    const target = await this.target(userId, username, 'block');
    await this.prisma.block.deleteMany({
      where: { blockerId: userId, blockedId: target.id },
    });
    return { blocked: false };
  }

  async mutes(userId: number): Promise<{ people: MutedPerson[] }> {
    const mutes = await this.prisma.mute.findMany({
      where: { muterId: userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, muted: { select: personSelect } },
    });
    return {
      people: mutes.map(({ createdAt, muted }) => ({
        ...muted,
        mutedAt: createdAt,
      })),
    };
  }

  async mute(userId: number, username: string) {
    const target = await this.target(userId, username, 'mute');
    const key = { muterId: userId, mutedId: target.id };
    const existing = await this.prisma.mute.findUnique({
      where: { muterId_mutedId: key },
      select: { muterId: true },
    });
    if (!existing) {
      const count = await this.prisma.mute.count({
        where: { muterId: userId },
      });
      if (count >= MAX_MUTES) {
        throw new BadRequestException('You can mute up to 1,000 people');
      }
      await this.prisma.mute.create({ data: key });
    }
    return { muted: true };
  }

  async unmute(userId: number, username: string) {
    const target = await this.target(userId, username, 'mute');
    await this.prisma.mute.deleteMany({
      where: { muterId: userId, mutedId: target.id },
    });
    return { muted: false };
  }

  private async dropExpired(userId: number) {
    await this.prisma.keywordFilter.deleteMany({
      where: { userId, expiresAt: { lte: new Date() } },
    });
  }

  async filters(userId: number): Promise<{ filters: KeywordFilterView[] }> {
    await this.dropExpired(userId);
    const filters = await this.prisma.keywordFilter.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: filterSelect,
    });
    return { filters };
  }

  async addFilter(
    userId: number,
    raw: string,
    duration: FilterDuration,
  ): Promise<KeywordFilterView> {
    const phrase = normalizePhrase(raw);
    if (!phrase) throw new BadRequestException('Enter a word or phrase');
    if (phrase.length > PHRASE_MAX) {
      throw new BadRequestException(
        `Keep it to ${PHRASE_MAX} characters or fewer`,
      );
    }

    await this.dropExpired(userId);
    const [count, existing] = await Promise.all([
      this.prisma.keywordFilter.count({ where: { userId } }),
      this.prisma.keywordFilter.findUnique({
        where: { userId_phrase: { userId, phrase } },
        select: { id: true },
      }),
    ]);
    if (existing) throw new ConflictException('You already filter that');
    if (count >= MAX_KEYWORD_FILTERS) {
      throw new BadRequestException(
        `You can have up to ${MAX_KEYWORD_FILTERS} keyword filters`,
      );
    }

    try {
      return await this.prisma.keywordFilter.create({
        data: { userId, phrase, expiresAt: expiryOf(duration) },
        select: filterSelect,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('You already filter that');
      }
      throw error;
    }
  }

  async removeFilter(userId: number, id: number) {
    const { count } = await this.prisma.keywordFilter.deleteMany({
      where: { id, userId },
    });
    if (count === 0) throw new NotFoundException('Filter not found');
  }
}
