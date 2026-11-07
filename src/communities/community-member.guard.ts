import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export const MAX_INT = 2147483647;

export function communityIdOf(request: {
  params: Record<string, string>;
}): number {
  const communityId = Number(request.params.communityId);
  if (
    !Number.isInteger(communityId) ||
    communityId < 1 ||
    communityId > MAX_INT
  ) {
    throw new BadRequestException('Invalid community id');
  }
  return communityId;
}

@Injectable()
export class CommunityMemberGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const communityId = communityIdOf(request);

    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_communityId: { userId: request.user.userId, communityId },
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this community');
    }

    request.membership = membership;
    return true;
  }
}
