import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CommunityMemberGuard } from '../communities/community-member.guard';
import { RateLimit, MINUTE } from '../common/throttle';
import { CommunityMembersService } from './community-members.service';
import { BanMemberDto } from './dto/ban-member.dto';

@Controller('communities/:communityId')
@UseGuards(JwtAuthGuard)
export class CommunityMembersController {
  constructor(private readonly members: CommunityMembersService) {}

  @RateLimit(30, MINUTE)
  @Delete('members/:userId')
  @HttpCode(204)
  @UseGuards(CommunityMemberGuard)
  remove(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.members.remove(req.user.userId, communityId, userId);
  }

  @Get('bans')
  @UseGuards(CommunityMemberGuard)
  bans(@Req() req, @Param('communityId', ParseIntPipe) communityId: number) {
    return this.members.bans(req.user.userId, communityId);
  }

  @RateLimit(30, MINUTE)
  @Put('bans/:userId')
  @HttpCode(204)
  @UseGuards(CommunityMemberGuard)
  ban(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() { reason }: BanMemberDto,
  ) {
    return this.members.ban(req.user.userId, communityId, userId, reason);
  }

  @RateLimit(30, MINUTE)
  @Delete('bans/:userId')
  @HttpCode(204)
  @UseGuards(CommunityMemberGuard)
  unban(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.members.unban(req.user.userId, communityId, userId);
  }
}
