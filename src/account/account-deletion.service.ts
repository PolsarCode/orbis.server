import { BadRequestException, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { DAY } from '../common/throttle';
import { communitySuccessor } from '../communities/successor';
import { sendInBackground } from '../common/email';
import { DELETION_CODE_SECONDS, DELETION_GRACE_DAYS } from './account-deletion';
import { deletionScheduledEmail } from './deletion-emails';

export type DeletionPreview = {
  ownedCommunities: {
    id: number;
    name: string;
    successor: { username: string; name: string | null } | null;
  }[];
};

const noCode = { deletionCode: null, deletionCodeExpiresAt: null };

@Injectable()
export class AccountDeletionService {
  constructor(
    private prisma: PrismaService,
    private presence: PresenceGateway,
  ) {}

  async preview(userId: number): Promise<DeletionPreview> {
    const communities = await this.prisma.community.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    });
    return {
      ownedCommunities: await Promise.all(
        communities.map(async ({ id, name }) => {
          const successor = await communitySuccessor(this.prisma, id, userId);
          return {
            id,
            name,
            successor: successor && {
              username: successor.username,
              name: successor.name,
            },
          };
        }),
      ),
    };
  }

  async issueCode(userId: number) {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        deletionCode: code,
        deletionCodeExpiresAt: new Date(
          Date.now() + DELETION_CODE_SECONDS * 1000,
        ),
      },
    });
    return { code, expiresIn: DELETION_CODE_SECONDS };
  }

  async schedule(userId: number, code = '') {
    const entered = code.trim();
    if (!/^\d{6}$/.test(entered)) {
      throw new BadRequestException('Enter the 6-digit code');
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        email: true,
        emailVerifiedAt: true,
        deletionCode: true,
        deletionCodeExpiresAt: true,
      },
    });
    if (!user.deletionCode || !user.deletionCodeExpiresAt) {
      throw new BadRequestException('Start the deletion again');
    }
    const now = new Date();
    if (user.deletionCodeExpiresAt <= now) {
      await this.prisma.user.update({ where: { id: userId }, data: noCode });
      throw new BadRequestException('The code expired. Start over');
    }
    if (entered !== user.deletionCode) {
      throw new BadRequestException('That code isn’t correct');
    }

    const deleteAt = new Date(now.getTime() + DELETION_GRACE_DAYS * DAY);
    await this.prisma.user.update({
      where: { id: userId },
      data: { ...noCode, deleteAt, sessionsRevokedAt: now },
    });
    this.presence.disconnectUser(userId);
    if (user.emailVerifiedAt) {
      sendInBackground({ to: user.email, ...deletionScheduledEmail(deleteAt) });
    }
    return { deleteAt: deleteAt.toISOString() };
  }
}
