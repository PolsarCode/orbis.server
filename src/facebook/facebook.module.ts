import { Module } from '@nestjs/common';
import { HeadAdminGuard } from '../admin/head-admin.guard';
import { LibraryModule } from '../library/library.module';
import { PrismaService } from '../prisma.service';
import { FacebookChartPostingService } from './facebook-chart-posting.service';
import { FacebookChartsController } from './facebook-charts.controller';
import { FacebookReleasePostingService } from './facebook-release-posting.service';
import { FacebookReleasesController } from './facebook-releases.controller';

@Module({
  imports: [LibraryModule],
  controllers: [FacebookChartsController, FacebookReleasesController],
  providers: [
    FacebookChartPostingService,
    FacebookReleasePostingService,
    HeadAdminGuard,
    PrismaService,
  ],
})
export class FacebookModule {}
