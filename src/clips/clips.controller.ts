import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowGuest } from '../auth/allow-guest';
import { CommunityViewerGuard } from '../communities/community-viewer.guard';
import { ClipPage } from '../friends/twitch-live.service';
import { ClipsService } from './clips.service';
import { ClipsQueryDto } from './dto/clips-query.dto';
import { UserId } from '../common/user-id';

@Controller()
@UseGuards(JwtAuthGuard)
export class ClipsController {
  constructor(private readonly clipsService: ClipsService) {}

  @Get('communities/:communityId/clips')
  @AllowGuest()
  @UseGuards(CommunityViewerGuard)
  communityClips(
    @Param('communityId', ParseIntPipe) communityId: number,
    @Query() { cursor }: ClipsQueryDto,
  ): Promise<ClipPage> {
    return this.clipsService.forCommunity(communityId, cursor);
  }

  @Get('users/:username/clips')
  @AllowGuest()
  userClips(
    @UserId() userId: number,
    @Param('username') username: string,
    @Query() { cursor }: ClipsQueryDto,
  ): Promise<ClipPage> {
    return this.clipsService.forUser(userId, username, cursor);
  }
}
