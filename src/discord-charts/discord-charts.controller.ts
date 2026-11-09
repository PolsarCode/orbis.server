import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CommunityMemberGuard } from '../communities/community-member.guard';
import { MINUTE, RateLimit } from '../common/throttle';
import { UserId } from '../common/user-id';
import { DiscordChartPostingService } from './discord-chart-posting.service';
import { DiscordChartService } from './discord-chart.service';
import { SendDiscordChartsDto } from './dto/send-discord-charts.dto';
import { UpdateDiscordChartsDto } from './dto/update-discord-charts.dto';

@Controller('communities/:communityId/discord-charts')
@UseGuards(JwtAuthGuard, CommunityMemberGuard)
export class DiscordChartsController {
  constructor(
    private readonly discordCharts: DiscordChartService,
    private readonly posting: DiscordChartPostingService,
  ) {}

  @Get()
  async find(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
  ) {
    return {
      channel: await this.discordCharts.find(userId, communityId),
    };
  }

  @RateLimit(30, MINUTE)
  @Patch()
  async update(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Body() settings: UpdateDiscordChartsDto,
  ) {
    return {
      channel: await this.discordCharts.update(userId, communityId, settings),
    };
  }

  @RateLimit(3, MINUTE)
  @Post('send')
  @HttpCode(204)
  send(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Body() { message }: SendDiscordChartsDto,
  ): Promise<void> {
    return this.posting.sendNow(userId, communityId, message);
  }

  @Delete()
  @HttpCode(204)
  disconnect(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<void> {
    return this.discordCharts.disconnect(userId, communityId);
  }
}
