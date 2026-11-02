import { Module } from '@nestjs/common';
import { CommunitiesModule } from '../communities/communities.module';
import { CommunityMemberGuard } from '../communities/community-member.guard';
import { PostsModule } from '../posts/posts.module';
import { CommentsModule } from '../comments/comments.module';
import { ForumModule } from '../forum/forum.module';
import { PresenceModule } from '../friends/presence.module';
import { PrismaService } from '../prisma.service';
import { CommunityMembersController } from './community-members.controller';
import { CommunityMembersService } from './community-members.service';

@Module({
  imports: [
    CommunitiesModule,
    PostsModule,
    CommentsModule,
    ForumModule,
    PresenceModule,
  ],
  controllers: [CommunityMembersController],
  providers: [CommunityMembersService, CommunityMemberGuard, PrismaService],
})
export class CommunityMembersModule {}
