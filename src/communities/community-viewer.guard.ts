import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { communityIdOf } from './community-member.guard';
import { requireViewAccess } from './require-membership';

@Injectable()
export class CommunityViewerGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const communityId = communityIdOf(request);
    await requireViewAccess(this.prisma, request.user.userId, communityId);
    return true;
  }
}
