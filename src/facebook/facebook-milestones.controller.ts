import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { HeadAdminGuard } from '../admin/head-admin.guard';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MINUTE, RateLimit } from '../common/throttle';
import { UpdateFacebookPostingDto } from './dto/update-facebook-posting.dto';
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
  update(
    @Body() { enabled }: UpdateFacebookPostingDto,
  ): Promise<FacebookMilestonesStatus> {
    return this.posting.setEnabled(enabled);
  }

  @RateLimit(3, MINUTE)
  @Post('send')
  send(): Promise<MilestonePost> {
    return this.posting.sendNow();
  }
}
