import { applyDecorators, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  Throttle,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { PrismaService } from '../prisma.service';
import { accountTimeLeft } from './new-account';
import { clientIp } from './client-ip';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function rateLimitMessage(secondsLeft: number) {
  const minutes = Math.max(1, Math.ceil(secondsLeft / 60));
  const hours = Math.round(minutes / 60);
  const wait =
    minutes === 1
      ? 'a minute'
      : minutes < 60
        ? `${minutes} minutes`
        : hours === 1
          ? 'about an hour'
          : `about ${hours} hours`;
  return `You’re doing that too often. Try again in ${wait}`;
}

export const throttlerOptions: ThrottlerModuleOptions = {
  throttlers: [{ ttl: MINUTE, limit: 300 }],
  errorMessage: (_context, { timeToBlockExpire }) =>
    rateLimitMessage(timeToBlockExpire),
};

const NEW_ACCOUNT_LIMIT = 'newAccountLimit';

export const RateLimit = (
  limit: number,
  ttl: number,
  newAccountLimit?: number,
) =>
  applyDecorators(
    Throttle({ default: { limit, ttl } }),
    SetMetadata(NEW_ACCOUNT_LIMIT, newAccountLimit),
  );

const jwt = new JwtService();

function userOf(authorization: unknown) {
  if (typeof authorization !== 'string') return null;
  if (!authorization.startsWith('Bearer ')) return null;
  try {
    const { sub } = jwt.verify<{ sub: number }>(authorization.slice(7), {
      secret: process.env.JWT_SECRET,
    });
    return typeof sub === 'number' ? sub : null;
  } catch {
    return null;
  }
}

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private prisma: PrismaService,
  ) {
    super(options, storage, reflector);
  }

  protected async handleRequest(request: ThrottlerRequest): Promise<boolean> {
    const { context, limit } = request;
    const newAccountLimit = this.reflector.getAllAndOverride<
      number | undefined
    >(NEW_ACCOUNT_LIMIT, [context.getHandler(), context.getClass()]);
    if (newAccountLimit === undefined || newAccountLimit >= limit) {
      return super.handleRequest(request);
    }

    const user = userOf(
      context.switchToHttp().getRequest().headers?.authorization,
    );
    const isNew =
      user !== null && (await accountTimeLeft(this.prisma, user)) > 0;
    return super.handleRequest(
      isNew ? { ...request, limit: newAccountLimit } : request,
    );
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const user = userOf(req.headers?.authorization);
    if (user !== null) return `user:${user}`;

    return `ip:${clientIp(req)}`;
  }
}
