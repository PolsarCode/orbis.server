import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { HeadAdminGuard } from '../admin/head-admin.guard';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MINUTE, RateLimit } from '../common/throttle';
import { UpdateFacebookPostsDto } from './dto/update-facebook-posts.dto';
import { isFacebookPostKind } from './facebook-post-kinds';
import {
  FacebookPostsService,
  FacebookPostsStatus,
} from './facebook-posts.service';

@Controller('admin/facebook-posts')
@UseGuards(JwtAuthGuard, HeadAdminGuard)
export class FacebookPostsController {
  constructor(private readonly posts: FacebookPostsService) {}

  @Get()
  status(): Promise<FacebookPostsStatus> {
    return this.posts.status();
  }

  @RateLimit(30, MINUTE)
  @Patch()
  update(
    @Body() { kind, enabled }: UpdateFacebookPostsDto,
  ): Promise<FacebookPostsStatus> {
    return this.posts.setEnabled(kind, enabled);
  }

  @RateLimit(3, MINUTE)
  @Post(':kind/send')
  send(@Param('kind') kind: string): Promise<{ postIds: string[] }> {
    if (!isFacebookPostKind(kind)) {
      throw new NotFoundException('There’s no such Facebook post');
    }
    return this.posts.sendNow(kind);
  }
}
