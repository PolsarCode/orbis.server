import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CommunityMemberGuard } from '../communities/community-member.guard';
import { RateLimit, MINUTE } from '../common/throttle';
import { CommunityMembersService } from './community-members.service';
import { BanMemberDto } from './dto/ban-member.dto';
import { UserId } from '../common/user-id';

@Controller('communities/:communityId')
@UseGuards(JwtAuthGuard)
export class CommunityMembersController {
  constructor(private readonly members: CommunityMembersService) {}

  @RateLimit(30, MINUTE)
  @Delete('members/:userId')
  @HttpCode(204)
  @UseGuards(CommunityMemberGuard)
  remove(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('userId', ParseIntPipe) targetId: number,
  ) {
    return this.members.remove(userId, communityId, targetId);
  }

  @Get('bans')
  @UseGuards(CommunityMemberGuard)
  bans(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
  ) {
    return this.members.bans(userId, communityId);
  }

  @RateLimit(30, MINUTE)
  @Put('bans/:userId')
  @HttpCode(204)
  @UseGuards(CommunityMemberGuard)
  ban(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('userId', ParseIntPipe) targetId: number,
    @Body() { reason }: BanMemberDto,
  ) {
    return this.members.ban(userId, communityId, targetId, reason);
  }

  @RateLimit(30, MINUTE)
  @Delete('bans/:userId')
  @HttpCode(204)
  @UseGuards(CommunityMemberGuard)
  unban(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('userId', ParseIntPipe) targetId: number,
  ) {
    return this.members.unban(userId, communityId, targetId);
  }
}
