import { Module } from '@nestjs/common';
import { FeedController } from './feed.controller';
import { PostController, PostsController } from './posts.controller';
import { UserPostsController } from './user-posts.controller';
import { MediaPostsController } from './media-posts.controller';
import { PostsService } from './posts.service';
import { CommunityMemberGuard } from '../communities/community-member.guard';
import { CommunityViewerGuard } from '../communities/community-viewer.guard';
import { PrismaService } from '../prisma.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { LikesModule } from '../likes/likes.module';
import { DiscordChannelModule } from '../discord-channel/discord-channel.module';

@Module({
  imports: [NotificationsModule, LikesModule, DiscordChannelModule],
  controllers: [
    PostsController,
    PostController,
    FeedController,
    UserPostsController,
    MediaPostsController,
  ],
  providers: [
    PostsService,
    CommunityMemberGuard,
    CommunityViewerGuard,
    PrismaService,
  ],
})
export class PostsModule {}
