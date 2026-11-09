import { Module } from '@nestjs/common';
import { CommunitiesModule } from '../communities/communities.module';
import { CommunityMemberGuard } from '../communities/community-member.guard';
import { LibraryModule } from '../library/library.module';
import { PrismaService } from '../prisma.service';
import { DiscordChartPostingService } from './discord-chart-posting.service';
import { DiscordChartService } from './discord-chart.service';
import { DiscordChartsController } from './discord-charts.controller';

@Module({
  imports: [CommunitiesModule, LibraryModule],
  controllers: [DiscordChartsController],
  providers: [
    DiscordChartService,
    DiscordChartPostingService,
    CommunityMemberGuard,
    PrismaService,
  ],
  exports: [DiscordChartService],
})
export class DiscordChartsModule {}
