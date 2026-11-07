import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CommunityMemberGuard } from '../communities/community-member.guard';
import { MINUTE, RateLimit } from '../common/throttle';
import { DiscordChannelService } from './discord-channel.service';
import { UpdateDiscordChannelDto } from './dto/update-discord-channel.dto';
import { UserId } from '../common/user-id';

@Controller('communities/:communityId/discord-channel')
@UseGuards(JwtAuthGuard, CommunityMemberGuard)
export class DiscordChannelController {
  constructor(private readonly discordChannel: DiscordChannelService) {}

  @Get()
  async find(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
  ) {
    return {
      channel: await this.discordChannel.find(userId, communityId),
    };
  }

  @RateLimit(30, MINUTE)
  @Patch()
  async update(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Body() settings: UpdateDiscordChannelDto,
  ) {
    return {
      channel: await this.discordChannel.update(userId, communityId, settings),
    };
  }

  @Delete()
  @HttpCode(204)
  disconnect(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<void> {
    return this.discordChannel.disconnect(userId, communityId);
  }
}
