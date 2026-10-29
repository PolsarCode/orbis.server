import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';
import { ensureNotSuspended } from '../users/suspension';

@Injectable()
export class SuspendedAccountGuard implements CanActivate {
  private readonly jwt = new JwtService({ secret: process.env.JWT_SECRET });

  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') return true;
    const header = context.switchToHttp().getRequest().headers?.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return true;
    }
    let userId: number;
    try {
      userId = this.jwt.verify<{ sub: number }>(header.slice(7)).sub;
    } catch {
      return true;
    }

    await ensureNotSuspended(this.prisma, userId);
    return true;
  }
}
