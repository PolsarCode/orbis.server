import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
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
  CommunityWithRole,
  RailItem,
} from './communities.service';
import { CreateCommunityDto } from './dto/create-community.dto';
import { UpdateRailLayoutDto } from './dto/update-rail-layout.dto';
import { SearchCommunitiesDto } from './dto/search-communities.dto';
import { UpdateCommunityDto } from './dto/update-community.dto';
import { CommunityMemberGuard } from './community-member.guard';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { Community as CommunityModel } from '../../prisma/generated/client';
import { IMAGE_MAX_BYTES } from '../storage/storage.service';
import { DAY, MINUTE, RateLimit } from '../common/throttle';

@Controller('communities')
@UseGuards(JwtAuthGuard)
export class CommunitiesController {
  constructor(private readonly communitiesService: CommunitiesService) {}

  @RateLimit(3, DAY)
  @Post()
  create(
    @Req() req,
    @Body() createCommunityDto: CreateCommunityDto,
  ): Promise<CommunityModel> {
    return this.communitiesService.create(req.user.userId, createCommunityDto);
  }

  @Get()
  findMine(@Req() req): Promise<CommunityModel[]> {
    return this.communitiesService.findForMember(req.user.userId);
  }

  @RateLimit(60, MINUTE)
  @Get('search')
  search(
    @Req() req,
    @Query() searchCommunitiesDto: SearchCommunitiesDto,
  ): Promise<CommunitySearchResult[]> {
    return this.communitiesService.search(
      req.user.userId,
      searchCommunitiesDto,
    );
  }

  @Post(':communityId/join')
  join(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<CommunityModel> {
    return this.communitiesService.join(req.user.userId, communityId);
  }

  @Get('layout')
  railLayout(@Req() req): Promise<RailItem[]> {
    return this.communitiesService.railLayout(req.user.userId);
  }

  @Put('layout')
  updateRailLayout(
    @Req() req,
    @Body() updateRailLayoutDto: UpdateRailLayoutDto,
  ): Promise<RailItem[]> {
    return this.communitiesService.updateRailLayout(
      req.user.userId,
      updateRailLayoutDto,
    );
  }

  @Get(':communityId/members')
  @UseGuards(CommunityMemberGuard)
  findMembers(
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<CommunityMember[]> {
    return this.communitiesService.findMembers(communityId);
  }

  @Put(':communityId/admins/:userId')
  @UseGuards(CommunityMemberGuard)
  addAdmin(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('userId', ParseIntPipe) userId: number,
  ): Promise<CommunityMember[]> {
    return this.communitiesService.setAdmin(
      req.user.userId,
      communityId,
      userId,
      true,
    );
  }

  @Delete(':communityId/admins/:userId')
  @UseGuards(CommunityMemberGuard)
  removeAdmin(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('userId', ParseIntPipe) userId: number,
  ): Promise<CommunityMember[]> {
    return this.communitiesService.setAdmin(
      req.user.userId,
      communityId,
      userId,
      false,
    );
  }

  @Get(':communityId')
  findOne(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<CommunityWithRole | null> {
    return this.communitiesService.findOne(req.user.userId, communityId);
  }

  @Patch(':communityId')
  @UseGuards(CommunityMemberGuard)
  update(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Body() updateCommunityDto: UpdateCommunityDto,
  ): Promise<CommunityWithRole> {
    return this.communitiesService.update(
      req.user.userId,
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
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('image') image: CommunityImage,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<CommunityWithRole> {
    if (!file) throw new BadRequestException('Choose an image to upload');
    return this.communitiesService.updateImage(
      req.user.userId,
      communityId,
      image,
      file.buffer,
    );
  }

  @Delete(':communityId/:image(icon|cover|background)')
  @UseGuards(CommunityMemberGuard)
  removeImage(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('image') image: CommunityImage,
  ): Promise<CommunityWithRole> {
    return this.communitiesService.removeImage(
      req.user.userId,
      communityId,
      image,
    );
  }

  @Delete(':communityId')
  @UseGuards(CommunityMemberGuard)
  @HttpCode(204)
  remove(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
  ): Promise<void> {
    return this.communitiesService.remove(req.user.userId, communityId);
  }
}
