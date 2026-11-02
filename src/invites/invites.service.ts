import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { CommunitiesService } from '../communities/communities.service';
import { CreateInviteDto } from './dto/create-invite.dto';
import { buildInviteCard } from './invite-card';
import { webUrl } from '../common/web-url';
import {
  Community as CommunityModel,
  Prisma,
} from '../../prisma/generated/client';
import { requireNotBanned } from '../communities/bans';

const CODE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 8;
const PERMANENT_CODE_LENGTH = 100;

const creatorSelect = {
  select: { id: true, username: true, name: true, avatarUrl: true },
} as const;

const inviteSelect = {
  code: true,
  maxUses: true,
  uses: true,
  expiresAt: true,
  permanent: true,
  disabledAt: true,
  createdAt: true,
  creator: creatorSelect,
} as const;

export type CommunityInvite = Prisma.InviteGetPayload<{
  select: typeof inviteSelect;
}>;

export type InvitePreview = {
  code: string;
  expiresAt: Date | null;
  creator: CommunityInvite['creator'];
  community: {
    id: number;
    name: string;
    iconUrl: string | null;
    coverUrl: string | null;
    backgroundUrl: string | null;
    isPublic: boolean;
    isVerified: boolean;
    memberCount: number;
  };
};

const INVALID_INVITE = 'This invite is invalid or has expired';

function generateCode(length = CODE_LENGTH) {
  return Array.from(
    { length },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
  ).join('');
}

function isUniqueViolation(e: unknown) {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
  );
}

@Injectable()
export class InvitesService {
  constructor(
    private prisma: PrismaService,
    private communities: CommunitiesService,
  ) {}

  async create(
    userId: number,
    communityId: number,
    { maxAge, maxUses }: CreateInviteDto,
  ): Promise<CommunityInvite> {
    const expiresAt = maxAge ? new Date(Date.now() + maxAge * 1000) : null;

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.invite.create({
          data: {
            code: generateCode(),
            communityId,
            creatorId: userId,
            maxUses: maxUses ?? null,
            expiresAt,
          },
          select: inviteSelect,
        });
      } catch (e) {
        if (!isUniqueViolation(e) || attempt === 4) throw e;
      }
    }
  }

  async createPermanent(
    userId: number,
    communityId: number,
  ): Promise<CommunityInvite> {
    const existing = await this.prisma.invite.findFirst({
      where: { communityId, creatorId: userId, permanent: true },
      select: inviteSelect,
    });
    if (existing) return existing;

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.invite.create({
          data: {
            code: generateCode(PERMANENT_CODE_LENGTH),
            communityId,
            creatorId: userId,
            permanent: true,
          },
          select: inviteSelect,
        });
      } catch (e) {
        if (!isUniqueViolation(e) || attempt === 4) throw e;
      }
    }
  }

  async card(userId: number, communityId: number): Promise<Uint8Array> {
    const invite = await this.createPermanent(userId, communityId);
    if (invite.disabledAt) {
      throw new BadRequestException(
        'Turn the QR back on before printing the card',
      );
    }

    const community = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: {
        name: true,
        iconUrl: true,
        coverUrl: true,
        backgroundUrl: true,
      },
    });
    if (!community) throw new NotFoundException('Community not found');

    return buildInviteCard({
      ...community,
      qrUrl: `${webUrl()}/qr/${invite.code}`,
    });
  }

  async setEnabled(
    userId: number,
    communityId: number,
    code: string,
    enabled: boolean,
  ): Promise<CommunityInvite> {
    const invite = await this.prisma.invite.findFirst({
      where: { code, communityId, permanent: true },
      select: { id: true, creatorId: true },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    if (invite.creatorId !== userId) {
      await this.requireAdmin(userId, communityId);
    }

    return this.prisma.invite.update({
      where: { id: invite.id },
      data: { disabledAt: enabled ? null : new Date() },
      select: inviteSelect,
    });
  }

  async findForCommunity(
    userId: number,
    communityId: number,
  ): Promise<CommunityInvite[]> {
    const role = await this.communities.roleOf(userId, communityId);
    const isAdmin = role === 'owner' || role === 'admin';
    return this.prisma.invite.findMany({
      where: {
        communityId,
        ...(isAdmin ? {} : { creatorId: userId }),
        OR: [{ permanent: true }, this.usable()],
      },
      orderBy: { createdAt: 'desc' },
      select: inviteSelect,
    });
  }

  async revoke(userId: number, communityId: number, code: string) {
    const invite = await this.prisma.invite.findFirst({
      where: { code, communityId },
      select: { id: true, creatorId: true, permanent: true },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    if (invite.permanent) {
      throw new BadRequestException(
        'A permanent invite can’t be deleted. Disable it instead.',
      );
    }
    if (invite.creatorId !== userId) {
      await this.requireAdmin(userId, communityId);
    }

    await this.prisma.invite.delete({ where: { id: invite.id } });
  }

  async preview(code: string): Promise<InvitePreview> {
    const invite = await this.prisma.invite.findFirst({
      where: { code, ...this.usable() },
      select: {
        code: true,
        expiresAt: true,
        creator: creatorSelect,
        community: {
          select: {
            id: true,
            name: true,
            iconUrl: true,
            coverUrl: true,
            backgroundUrl: true,
            isPublic: true,
            isVerified: true,
            _count: { select: { memberships: true } },
          },
        },
      },
    });
    if (!invite) throw new NotFoundException(INVALID_INVITE);

    const { _count, ...community } = invite.community;
    return {
      ...invite,
      community: { ...community, memberCount: _count.memberships },
    };
  }

  async accept(userId: number, code: string): Promise<CommunityModel> {
    const invite = await this.prisma.invite.findFirst({
      where: { code, ...this.usable() },
      select: { id: true, community: true },
    });
    if (!invite) throw new NotFoundException(INVALID_INVITE);

    const { community } = invite;
    if (await this.communities.roleOf(userId, community.id)) return community;
    await requireNotBanned(this.prisma, userId, community.id);
    await this.communities.requireRoomToJoin(userId);

    const position = await this.communities.nextRailPosition(userId);
    try {
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.invite.updateMany({
          where: { id: invite.id, ...this.usable() },
          data: { uses: { increment: 1 } },
        });
        if (count === 0) throw new NotFoundException(INVALID_INVITE);

        await tx.membership.create({
          data: { userId, communityId: community.id, position },
        });
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }

    return community;
  }

  private usable(): Prisma.InviteWhereInput {
    return {
      AND: [
        { disabledAt: null },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        {
          OR: [
            { maxUses: null },
            { uses: { lt: this.prisma.invite.fields.maxUses } },
          ],
        },
      ],
    };
  }

  private async requireAdmin(userId: number, communityId: number) {
    const role = await this.communities.roleOf(userId, communityId);
    if (role !== 'owner' && role !== 'admin') {
      throw new ForbiddenException('Only admins can manage invites');
    }
  }
}
