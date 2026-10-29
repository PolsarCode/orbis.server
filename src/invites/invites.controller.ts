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
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  CommunityInvite,
  InvitePreview,
  InvitesService,
} from './invites.service';
import { CreateInviteDto } from './dto/create-invite.dto';
import { SetInviteEnabledDto } from './dto/set-invite-enabled.dto';
import { CommunityMemberGuard } from '../communities/community-member.guard';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { Community as CommunityModel } from '../../prisma/generated/client';
import { RateLimit, HOUR } from '../common/throttle';

@Controller()
export class InvitesController {
  constructor(private readonly invitesService: InvitesService) {}

  @RateLimit(20, HOUR, 5)
  @Post('communities/:communityId/invites')
  @UseGuards(JwtAuthGuard, CommunityMemberGuard)
  create(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Body() createInviteDto: CreateInviteDto,
  ): Promise<CommunityInvite> {
    return this.invitesService.create(
      req.user.userId,
      communityId,
      createInviteDto,
    );
  }

  @Get('communities/:communityId/invites')
  @UseGuards(JwtAuthGuard, CommunityMemberGuard)
  findForCommunity(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<CommunityInvite[]> {
    return this.invitesService.findForCommunity(req.user.userId, communityId);
  }

  @Delete('communities/:communityId/invites/:code')
  @UseGuards(JwtAuthGuard, CommunityMemberGuard)
  @HttpCode(204)
  revoke(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('code') code: string,
  ): Promise<void> {
    return this.invitesService.revoke(req.user.userId, communityId, code);
  }

  @RateLimit(200, HOUR)
  @Post('communities/:communityId/invites/permanent')
  @UseGuards(JwtAuthGuard, CommunityMemberGuard)
  createPermanent(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<CommunityInvite> {
    return this.invitesService.createPermanent(req.user.userId, communityId);
  }

  @RateLimit(30, HOUR)
  @Get('communities/:communityId/invites/permanent/card')
  @UseGuards(JwtAuthGuard, CommunityMemberGuard)
  async card(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<StreamableFile> {
    const pdf = await this.invitesService.card(req.user.userId, communityId);
    return new StreamableFile(pdf, { type: 'application/pdf' });
  }

  @RateLimit(60, HOUR)
  @Patch('communities/:communityId/invites/:code')
  @UseGuards(JwtAuthGuard, CommunityMemberGuard)
  setEnabled(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('code') code: string,
    @Body() { enabled }: SetInviteEnabledDto,
  ): Promise<CommunityInvite> {
    return this.invitesService.setEnabled(
      req.user.userId,
      communityId,
      code,
      enabled,
    );
  }

  @Get('invites/:code')
  preview(@Param('code') code: string): Promise<InvitePreview> {
    return this.invitesService.preview(code);
  }

  @Post('invites/:code')
  @UseGuards(JwtAuthGuard)
  accept(@Req() req, @Param('code') code: string): Promise<CommunityModel> {
    return this.invitesService.accept(req.user.userId, code);
  }
}
