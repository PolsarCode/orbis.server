import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { HeadAdminGuard } from '../admin/head-admin.guard';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MINUTE, RateLimit } from '../common/throttle';
import { UpdateFacebookPostingDto } from './dto/update-facebook-posting.dto';
import {
  FacebookReleasePostingService,
  FacebookReleasesStatus,
  ReleasePost,
} from './facebook-release-posting.service';

@Controller('admin/facebook-releases')
@UseGuards(JwtAuthGuard, HeadAdminGuard)
export class FacebookReleasesController {
  constructor(private readonly posting: FacebookReleasePostingService) {}

  @Get()
  status(): Promise<FacebookReleasesStatus> {
    return this.posting.status();
  }

  @RateLimit(30, MINUTE)
  @Patch()
  update(
    @Body() { enabled }: UpdateFacebookPostingDto,
  ): Promise<FacebookReleasesStatus> {
    return this.posting.setEnabled(enabled);
  }

  @RateLimit(3, MINUTE)
  @Post('send')
  send(): Promise<ReleasePost> {
    return this.posting.sendNow();
  }
}
