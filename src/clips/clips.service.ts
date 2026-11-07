import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { TwitchLiveService, ClipPage } from '../friends/twitch-live.service';
import { canViewProfile } from '../posts/wall-access';
import { requireUserNamed } from '../users/user-lookup';
import { notDeleting } from '../users/suspension';

@Injectable()
export class ClipsService {
  constructor(
    private prisma: PrismaService,
    private twitch: TwitchLiveService,
  ) {}

  async forCommunity(communityId: number, cursor?: string): Promise<ClipPage> {
    const community = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: { twitchUserId: true, showTwitchClips: true },
    });
    if (!community?.twitchUserId) {
      throw new NotFoundException('This community hasn’t connected Twitch');
    }
    if (!community.showTwitchClips) {
      throw new NotFoundException('This community doesn’t show its clips');
    }
    return this.twitch.clips(community.twitchUserId, cursor);
  }

  async forUser(
    viewerId: number,
    username: string,
    cursor?: string,
  ): Promise<ClipPage> {
    const user = await requireUserNamed(
      this.prisma,
      username,
      {
        id: true,
        isPublic: true,
        oauthAccounts: {
          where: { provider: 'twitch', showClips: true },
          select: { providerAccountId: true },
        },
      },
      notDeleting,
    );
    if (!(await canViewProfile(this.prisma, viewerId, user))) {
      throw new ForbiddenException('This profile is private');
    }

    const [account] = user.oauthAccounts;
    if (!account) throw new NotFoundException('No clips to show');
    return this.twitch.clips(account.providerAccountId, cursor);
  }
}
