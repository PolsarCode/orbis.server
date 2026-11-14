import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  CommunitiesService,
  CommunityImage,
  CommunityMember,
  CommunitySearchResult,
  CommunityWeekly,
  CommunityWithRole,
  RailItem,
} from './communities.service';
import { CreateCommunityDto } from './dto/create-community.dto';
import { UpdateRailLayoutDto } from './dto/update-rail-layout.dto';
import { SearchCommunitiesDto } from './dto/search-communities.dto';
import { ExploreCommunitiesDto } from './dto/explore-communities.dto';
import { UpdateCommunityDto } from './dto/update-community.dto';
import { UpdateLibraryUpdatesDto } from './dto/update-library-updates.dto';
import { UpdateNicknameDto } from './dto/update-nickname.dto';
import { CommunityRole } from './permissions';
import { CommunityMemberGuard } from './community-member.guard';
import { CommunityViewerGuard } from './community-viewer.guard';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowGuest } from '../auth/allow-guest';
import { Community as CommunityModel } from '../../prisma/generated/client';
import { IMAGE_MAX_BYTES } from '../storage/storage.service';
import { DAY, MINUTE, RateLimit } from '../common/throttle';
import { UserId } from '../common/user-id';
import { parseUntil } from '../common/weekly-window';

const MAX_EXPLORE_PAGE = 1000;

@Controller('communities')
@UseGuards(JwtAuthGuard)
export class CommunitiesController {
  constructor(private readonly communitiesService: CommunitiesService) {}

  @RateLimit(3, DAY)
  @Post()
  create(
    @UserId() userId: number,
    @Body() createCommunityDto: CreateCommunityDto,
  ): Promise<CommunityModel> {
    return this.communitiesService.create(userId, createCommunityDto);
  }

  @Get()
  findMine(
    @UserId() userId: number,
  ): Promise<(CommunityModel & { live: boolean; role: CommunityRole })[]> {
    return this.communitiesService.findForMember(userId);
  }

  @RateLimit(60, MINUTE)
  @Get('search')
  search(
    @UserId() userId: number,
    @Query() searchCommunitiesDto: SearchCommunitiesDto,
  ): Promise<CommunitySearchResult[]> {
    return this.communitiesService.search(userId, searchCommunitiesDto);
  }

  @RateLimit(60, MINUTE)
  @Get('explore')
  explore(
    @UserId() userId: number,
    @Query() exploreCommunitiesDto: ExploreCommunitiesDto,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
  ) {
    return this.communitiesService.explore(
      userId,
      exploreCommunitiesDto,
      Math.min(Math.max(page, 1), MAX_EXPLORE_PAGE),
    );
  }

  @RateLimit(60, MINUTE)
  @Get('explore/friends')
  friendPicks(@UserId() userId: number): Promise<CommunitySearchResult[]> {
    return this.communitiesService.friendPicks(userId);
  }

  @Post(':communityId/join')
  join(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<CommunityModel> {
    return this.communitiesService.join(userId, communityId);
  }

  @Post(':communityId/leave')
  @HttpCode(204)
  leave(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<void> {
    return this.communitiesService.leave(userId, communityId);
  }

  @Get('layout')
  railLayout(@UserId() userId: number): Promise<RailItem[]> {
    return this.communitiesService.railLayout(userId);
  }

  @Get('discord-setup')
  unfinishedDiscord(@UserId() userId: number) {
    return this.communitiesService.unfinishedDiscord(userId);
  }

  @Put('layout')
  updateRailLayout(
    @UserId() userId: number,
    @Body() updateRailLayoutDto: UpdateRailLayoutDto,
  ): Promise<RailItem[]> {
    return this.communitiesService.updateRailLayout(
      userId,
      updateRailLayoutDto,
    );
  }

  @Get(':communityId/members')
  @AllowGuest()
  @UseGuards(CommunityViewerGuard)
  findMembers(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<CommunityMember[]> {
    return this.communitiesService.findMembers(userId, communityId);
  }

  @Get(':communityId/weekly')
  @AllowGuest()
  @RateLimit(60, MINUTE)
  weekly(
    @Param('communityId', ParseIntPipe) communityId: number,
    @Query('until') until?: string,
  ): Promise<CommunityWeekly> {
    return this.communitiesService.weekly(communityId, parseUntil(until));
  }

  @Put(':communityId/admins/:userId')
  @UseGuards(CommunityMemberGuard)
  addAdmin(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('userId', ParseIntPipe) targetId: number,
  ): Promise<CommunityMember[]> {
    return this.communitiesService.setAdmin(
      userId,
      communityId,
      targetId,
      true,
    );
  }

  @Delete(':communityId/admins/:userId')
  @UseGuards(CommunityMemberGuard)
  removeAdmin(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('userId', ParseIntPipe) targetId: number,
  ): Promise<CommunityMember[]> {
    return this.communitiesService.setAdmin(
      userId,
      communityId,
      targetId,
      false,
    );
  }

  @Put(':communityId/verified')
  verify(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<{ isVerified: boolean }> {
    return this.communitiesService.setVerified(userId, communityId, true);
  }

  @Delete(':communityId/verified')
  unverify(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<{ isVerified: boolean }> {
    return this.communitiesService.setVerified(userId, communityId, false);
  }

  @RateLimit(20, MINUTE)
  @Patch(':communityId/nickname')
  @UseGuards(CommunityMemberGuard)
  setNickname(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Body() { nickname }: UpdateNicknameDto,
  ): Promise<{ nickname: string | null }> {
    return this.communitiesService.setNickname(
      userId,
      communityId,
      nickname ?? null,
    );
  }

  @RateLimit(20, MINUTE)
  @Patch(':communityId/library-updates')
  @UseGuards(CommunityMemberGuard)
  setShowLibraryUpdates(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Body() { show }: UpdateLibraryUpdatesDto,
  ): Promise<{ showLibraryUpdates: boolean }> {
    return this.communitiesService.setShowLibraryUpdates(
      userId,
      communityId,
      show,
    );
  }

  @Get(':communityId')
  @AllowGuest()
  findOne(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<CommunityWithRole | null> {
    return this.communitiesService.findOne(userId, communityId);
  }

  @Patch(':communityId')
  @UseGuards(CommunityMemberGuard)
  update(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Body() updateCommunityDto: UpdateCommunityDto,
  ): Promise<CommunityWithRole> {
    return this.communitiesService.update(
      userId,
      communityId,
      updateCommunityDto,
    );
  }

  @Post(':communityId/:image(icon|cover|background)')
  @UseGuards(CommunityMemberGuard)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: IMAGE_MAX_BYTES } }),
  )
  uploadImage(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('image') image: CommunityImage,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<CommunityWithRole> {
    if (!file) throw new BadRequestException('Choose an image to upload');
    return this.communitiesService.updateImage(
      userId,
      communityId,
      image,
      file.buffer,
    );
  }

  @Delete(':communityId/:image(icon|cover|background)')
  @UseGuards(CommunityMemberGuard)
  removeImage(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('image') image: CommunityImage,
  ): Promise<CommunityWithRole> {
    return this.communitiesService.removeImage(userId, communityId, image);
  }

  @Delete(':communityId/twitch')
  @UseGuards(CommunityMemberGuard)
  @HttpCode(204)
  disconnectTwitch(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<void> {
    return this.communitiesService.disconnectTwitch(userId, communityId);
  }

  @Delete(':communityId/discord')
  @UseGuards(CommunityMemberGuard)
  @HttpCode(204)
  disconnectDiscord(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<void> {
    return this.communitiesService.disconnectDiscord(userId, communityId);
  }

  @Delete(':communityId')
  @UseGuards(CommunityMemberGuard)
  @HttpCode(204)
  remove(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<void> {
    return this.communitiesService.remove(userId, communityId);
  }
}
