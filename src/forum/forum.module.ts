import { Module } from '@nestjs/common';
import { ForumController } from './forum.controller';
import { ForumService } from './forum.service';
import { ForumCategoriesService } from './forum-categories.service';
import { CommunityMemberGuard } from '../communities/community-member.guard';
import { CommunityViewerGuard } from '../communities/community-viewer.guard';
import { PrismaService } from '../prisma.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { LikesModule } from '../likes/likes.module';

@Module({
  imports: [NotificationsModule, LikesModule],
  controllers: [ForumController],
  providers: [
    ForumService,
    ForumCategoriesService,
    CommunityMemberGuard,
    CommunityViewerGuard,
    PrismaService,
  ],
  exports: [ForumService],
})
export class ForumModule {}
