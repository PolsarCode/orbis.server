import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { HeadAdminGuard } from '../admin/head-admin.guard';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MINUTE, RateLimit } from '../common/throttle';
import { UpdateFacebookMilestonesDto } from './dto/update-facebook-milestones.dto';
import {
  FacebookMilestonePostingService,
  FacebookMilestonesStatus,
  MilestonePost,
} from './facebook-milestone-posting.service';

@Controller('admin/facebook-milestones')
@UseGuards(JwtAuthGuard, HeadAdminGuard)
export class FacebookMilestonesController {
  constructor(private readonly posting: FacebookMilestonePostingService) {}

  @Get()
  status(): Promise<FacebookMilestonesStatus> {
    return this.posting.status();
  }

  @RateLimit(30, MINUTE)
  @Patch()
  async update(
    @Body() { goal, ...switches }: UpdateFacebookMilestonesDto,
  ): Promise<FacebookMilestonesStatus> {
    if (goal !== undefined) await this.posting.setGoal(goal);
    return this.posting.setSwitches(switches);
  }

  @RateLimit(3, MINUTE)
  @Post('send')
  send(): Promise<MilestonePost> {
    return this.posting.sendNow();
  }
}
