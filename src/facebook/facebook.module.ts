import { Module } from '@nestjs/common';
import { HeadAdminGuard } from '../admin/head-admin.guard';
import { CommunitiesModule } from '../communities/communities.module';
import { LibraryModule } from '../library/library.module';
import { PrismaService } from '../prisma.service';
import { StatsModule } from '../stats/stats.module';
import { TagsModule } from '../tags/tags.module';
import { FacebookChartPostingService } from './facebook-chart-posting.service';
import { FacebookChartsController } from './facebook-charts.controller';
import { FacebookMilestonePostingService } from './facebook-milestone-posting.service';
import { FacebookMilestonesController } from './facebook-milestones.controller';
import { FacebookPostsController } from './facebook-posts.controller';
import { FacebookPostsService } from './facebook-posts.service';
import { FacebookReleasePostingService } from './facebook-release-posting.service';
import { FacebookReleasesController } from './facebook-releases.controller';

@Module({
  imports: [LibraryModule, StatsModule, TagsModule, CommunitiesModule],
  controllers: [
    FacebookChartsController,
    FacebookMilestonesController,
    FacebookPostsController,
    FacebookReleasesController,
  ],
  providers: [
    FacebookChartPostingService,
    FacebookMilestonePostingService,
    FacebookPostsService,
    FacebookReleasePostingService,
    HeadAdminGuard,
    PrismaService,
  ],
})
export class FacebookModule {}
