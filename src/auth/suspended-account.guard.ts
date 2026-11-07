import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { bearerSubject } from '../common/bearer-token';
import { ensureNotSuspended } from '../users/suspension';

@Injectable()
export class SuspendedAccountGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') return true;
    const userId = bearerSubject(
      context.switchToHttp().getRequest().headers?.authorization,
    );
    if (userId === null) return true;

    await ensureNotSuspended(this.prisma, userId);
    return true;
  }
}
