import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { HeadAdminGuard } from '../admin/head-admin.guard';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MINUTE, RateLimit } from '../common/throttle';
import { UpdateFacebookChartsDto } from './dto/update-facebook-charts.dto';
import {
  FacebookChartPostingService,
  FacebookChartsStatus,
} from './facebook-chart-posting.service';

@Controller('admin/facebook-charts')
@UseGuards(JwtAuthGuard, HeadAdminGuard)
export class FacebookChartsController {
  constructor(private readonly posting: FacebookChartPostingService) {}

  @Get()
  status(): Promise<FacebookChartsStatus> {
    return this.posting.status();
  }

  @RateLimit(30, MINUTE)
  @Patch()
  update(
    @Body() { enabled }: UpdateFacebookChartsDto,
  ): Promise<FacebookChartsStatus> {
    return this.posting.setEnabled(enabled);
  }

  @RateLimit(3, MINUTE)
  @Post('send')
  send() {
    return this.posting.sendNow();
  }
}
