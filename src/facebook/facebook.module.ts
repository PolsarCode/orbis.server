import { Module } from '@nestjs/common';
import { HeadAdminGuard } from '../admin/head-admin.guard';
import { LibraryModule } from '../library/library.module';
import { PrismaService } from '../prisma.service';
import { FacebookChartPostingService } from './facebook-chart-posting.service';
import { FacebookChartsController } from './facebook-charts.controller';
import { FacebookMilestonePostingService } from './facebook-milestone-posting.service';
import { FacebookMilestonesController } from './facebook-milestones.controller';
import { FacebookReleasePostingService } from './facebook-release-posting.service';
import { FacebookReleasesController } from './facebook-releases.controller';

@Module({
  imports: [LibraryModule],
  controllers: [
    FacebookChartsController,
    FacebookMilestonesController,
    FacebookReleasesController,
  ],
  providers: [
    FacebookChartPostingService,
    FacebookMilestonePostingService,
    FacebookReleasePostingService,
    HeadAdminGuard,
    PrismaService,
  ],
})
export class FacebookModule {}
