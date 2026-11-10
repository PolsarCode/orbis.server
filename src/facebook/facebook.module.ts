import { Module } from '@nestjs/common';
import { HeadAdminGuard } from '../admin/head-admin.guard';
import { LibraryModule } from '../library/library.module';
import { PrismaService } from '../prisma.service';
import { FacebookChartPostingService } from './facebook-chart-posting.service';
import { FacebookChartsController } from './facebook-charts.controller';

@Module({
  imports: [LibraryModule],
  controllers: [FacebookChartsController],
  providers: [FacebookChartPostingService, HeadAdminGuard, PrismaService],
})
export class FacebookModule {}
