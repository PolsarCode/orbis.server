import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { isSiteAdmin } from '../users/head-admin';

@Injectable()
export class SiteAdminGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    if (!(await isSiteAdmin(this.prisma, request.user.userId))) {
      throw new ForbiddenException('Only site admins can do this');
    }
    return true;
  }
}
