import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { bearerClaims } from '../common/bearer-token';
import { ensureActiveSession } from '../users/suspension';

@Injectable()
export class SuspendedAccountGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') return true;
    const claims = bearerClaims(
      context.switchToHttp().getRequest().headers?.authorization,
    );
    if (claims === null) return true;

    await ensureActiveSession(this.prisma, claims.sub, claims.iat);
    return true;
  }
}
