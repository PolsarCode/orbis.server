import { Module } from '@nestjs/common';
import { PublicCommunitiesController } from './public-communities.controller';
import { CommunitiesController } from './communities.controller';
import { CommunitiesService } from './communities.service';
import { CommunityMemberGuard } from './community-member.guard';
import { CommunityViewerGuard } from './community-viewer.guard';
import { PrismaService } from '../prisma.service';
import { StorageModule } from '../storage/storage.module';
import { FriendsModule } from '../friends/friends.module';

@Module({
  imports: [StorageModule, FriendsModule],
  controllers: [CommunitiesController, PublicCommunitiesController],
  providers: [
    CommunitiesService,
    CommunityMemberGuard,
    CommunityViewerGuard,
    PrismaService,
  ],
  exports: [CommunitiesService],
})
export class CommunitiesModule {}
