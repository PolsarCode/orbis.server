import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { isHeadAdminAccount } from '../users/head-admin';

@Injectable()
export class HeadAdminGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    if (!(await isHeadAdminAccount(this.prisma, request.user.userId))) {
      throw new ForbiddenException('Only the head admin can do this');
    }
    return true;
  }
}
