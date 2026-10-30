import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as QRCode from 'qrcode';
import { PrismaService } from '../../prisma.service';
import { AuthService } from '../auth.service';
import { isHeadAdmin } from '../../users/head-admin';
import { normalizeUsername } from '../../users/username';
import { generateRecoveryCodes, hashRecoveryCode } from './recovery-codes';
import { openSecret, sealSecret } from './secret-box';
import { TWO_FACTOR_PURPOSE, ticketSecret } from './ticket';
import { generateSecret, matchingStep, otpauthUri } from './totp';

const WRONG_CODE = 'That code didn’t work. Check it and try again';

@Injectable()
export class TwoFactorService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private auth: AuthService,
  ) {}

  async setup(userId: number) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { username: true, password: true, twoFactorEnabledAt: true },
    });
    if (!user.password) {
      throw new BadRequestException(
        'Two-factor sign-in protects logging in with a password, and your account logs in with Discord or Twitch',
      );
    }
    if (user.twoFactorEnabledAt) {
      throw new ConflictException('Two-factor sign-in is already on');
    }

    const secret = generateSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: sealSecret(secret) },
    });
    const uri = otpauthUri({ issuer: 'Orbis', label: user.username, secret });
    return {
      secret,
      qrCode: await QRCode.toDataURL(uri, { margin: 1, width: 240 }),
    };
  }

  async enable(userId: number, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { twoFactorSecret: true, twoFactorEnabledAt: true },
    });
    if (user.twoFactorEnabledAt) {
      throw new ConflictException('Two-factor sign-in is already on');
    }
    if (!user.twoFactorSecret) {
      throw new BadRequestException(
        'Start setting up two-factor sign-in first',
      );
    }

    const step = matchingStep(openSecret(user.twoFactorSecret), clean(code));
    if (step === null) throw new BadRequestException(WRONG_CODE);

    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabledAt: new Date(),
        twoFactorCodes: recoveryCodes.map(hashRecoveryCode),
        twoFactorLastStep: step,
      },
    });
    return { recoveryCodes };
  }

  async disable(userId: number, code: string) {
    if (!(await this.useCode(userId, code))) {
      throw new BadRequestException(WRONG_CODE);
    }
    await this.clear(userId);
  }

  async completeLogin(ticket: string, code: string) {
    let userId: number;
    try {
      const payload = this.jwt.verify<{ sub: number; purpose?: string }>(
        ticket,
        { secret: ticketSecret() },
      );
      if (payload.purpose !== TWO_FACTOR_PURPOSE) throw new Error();
      userId = payload.sub;
    } catch {
      throw new UnauthorizedException('Your sign-in timed out. Log in again');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!user || !(await this.useCode(user.id, code))) {
      throw new UnauthorizedException(WRONG_CODE);
    }
    return this.auth.generateToken(user.id, user.email);
  }

  async reset(adminId: number, username: string) {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { id: true, isAdmin: true, email: true },
    });
    const headAdmin = Boolean(admin && isHeadAdmin(admin.email));
    if (!admin || !(admin.isAdmin || headAdmin)) {
      throw new ForbiddenException(
        'Only site admins can remove two-factor sign-in',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { username: normalizeUsername(username) },
      select: { id: true, email: true, isAdmin: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.id === admin.id) {
      throw new BadRequestException(
        'Turn off your own two-factor sign-in in Settings',
      );
    }
    if (isHeadAdmin(user.email)) {
      throw new BadRequestException(
        'The head admin’s two-factor sign-in can’t be removed',
      );
    }
    if (user.isAdmin && !headAdmin) {
      throw new ForbiddenException(
        'Only the head admin can remove another admin’s two-factor sign-in',
      );
    }

    await this.clear(user.id);
    return { twoFactorEnabled: false };
  }

  private async useCode(userId: number, code: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        twoFactorSecret: true,
        twoFactorEnabledAt: true,
        twoFactorCodes: true,
        twoFactorLastStep: true,
      },
    });
    if (!user?.twoFactorEnabledAt || !user.twoFactorSecret) return false;

    const entered = clean(code);
    const step = matchingStep(openSecret(user.twoFactorSecret), entered, {
      after: user.twoFactorLastStep,
    });
    if (step !== null) {
      const { count } = await this.prisma.user.updateMany({
        where: {
          id: userId,
          OR: [
            { twoFactorLastStep: null },
            { twoFactorLastStep: { lt: step } },
          ],
        },
        data: { twoFactorLastStep: step },
      });
      return count === 1;
    }

    const hash = hashRecoveryCode(entered);
    if (!user.twoFactorCodes.includes(hash)) return false;
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId, twoFactorCodes: { has: hash } },
      data: {
        twoFactorCodes: user.twoFactorCodes.filter((stored) => stored !== hash),
      },
    });
    return count === 1;
  }

  private async clear(userId: number) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorSecret: null,
        twoFactorEnabledAt: null,
        twoFactorCodes: [],
        twoFactorLastStep: null,
      },
    });
  }
}

function clean(code: string) {
  return code.replace(/\s+/g, '');
}
