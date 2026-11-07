import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';
import { sendEmail, sendInBackground } from '../common/email';
import { webUrl } from '../common/web-url';
import { confirmationEmail } from './confirmation-email';

const LINK_INVALID =
  'This link has expired or isn’t valid anymore. Send yourself a new one from Orbis';

type ConfirmClaims = { uid: number; email: string };

function confirmSecret() {
  return `${process.env.JWT_SECRET}:email-confirm`;
}

@Injectable()
export class EmailConfirmationService {
  private readonly logger = new Logger(EmailConfirmationService.name);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  private email(user: { id: number; email: string }) {
    const claims: ConfirmClaims = { uid: user.id, email: user.email };
    const token = this.jwt.sign(claims, {
      secret: confirmSecret(),
      expiresIn: '24h',
    });
    const link = `${webUrl()}/confirm-email?token=${encodeURIComponent(token)}`;
    return { to: user.email, ...confirmationEmail(link) };
  }

  async send(user: { id: number; email: string }) {
    await sendEmail(this.email(user));
  }

  sendInBackground(user: { id: number; email: string }) {
    sendInBackground(this.email(user));
  }

  async confirm(token: string) {
    let claims: ConfirmClaims;
    try {
      claims = this.jwt.verify<ConfirmClaims>(token, {
        secret: confirmSecret(),
      });
    } catch {
      throw new BadRequestException(LINK_INVALID);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: claims.uid },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!user || user.email.toLowerCase() !== claims.email.toLowerCase()) {
      throw new BadRequestException(LINK_INVALID);
    }
    if (!user.emailVerifiedAt) {
      await this.prisma.user.update({
        where: { id: claims.uid },
        data: { emailVerifiedAt: new Date() },
      });
    }
    return { confirmed: true };
  }

  async resend(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.emailVerifiedAt) return { confirmed: true };

    try {
      await this.send(user);
    } catch (error) {
      this.logger.error(
        `Couldn’t send a confirmation email: ${(error as Error).message}`,
      );
      throw new BadGatewayException(
        'Couldn’t send the email. Please try again in a few minutes',
      );
    }
    return { confirmed: false };
  }
}
