import { Module } from '@nestjs/common';
import {
  CommunityThreadsController,
  ThreadsController,
} from './threads.controller';
import { ThreadsService } from './threads.service';
import { CommunityMemberGuard } from '../communities/community-member.guard';
import { CommunityViewerGuard } from '../communities/community-viewer.guard';
import { PrismaService } from '../prisma.service';
import { VotesModule } from '../votes/votes.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DiscordChannelModule } from '../discord-channel/discord-channel.module';

@Module({
  imports: [VotesModule, NotificationsModule, DiscordChannelModule],
  controllers: [CommunityThreadsController, ThreadsController],
  providers: [
    ThreadsService,
    CommunityMemberGuard,
    CommunityViewerGuard,
    PrismaService,
  ],
  exports: [ThreadsService],
})
export class ThreadsModule {}
