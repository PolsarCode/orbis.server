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
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowGuest } from '../auth/allow-guest';
import { CommunityMemberGuard } from '../communities/community-member.guard';
import { CommunityViewerGuard } from '../communities/community-viewer.guard';
import { RateLimit, MINUTE } from '../common/throttle';

@Controller('communities/:communityId/posts')
@UseGuards(JwtAuthGuard)
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Get()
  @AllowGuest()
  @UseGuards(CommunityViewerGuard)
  findAll(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Query('cursor') cursor?: string,
    @Query('exclude') exclude?: string,
  ) {
    return this.postsService.findForCommunity(
      req.user.userId,
      communityId,
      cursor,
      exclude,
    );
  }

  @RateLimit(60, MINUTE)
  @Get('search')
  @AllowGuest()
  @UseGuards(CommunityViewerGuard)
  search(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Query('q') q = '',
  ) {
    return this.postsService.searchCommunity(req.user.userId, communityId, q);
  }

  @Get('activities/:activityId')
  @AllowGuest()
  @UseGuards(CommunityViewerGuard)
  findActivity(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('activityId', ParseIntPipe) activityId: number,
  ) {
    return this.postsService.findActivityInCommunity(
      req.user.userId,
      communityId,
      activityId,
    );
  }

  @Get(':postId')
  @AllowGuest()
  @UseGuards(CommunityViewerGuard)
  findOne(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('postId', ParseIntPipe) postId: number,
  ) {
    return this.postsService.findOneInCommunity(
      req.user.userId,
      communityId,
      postId,
    );
  }

  @RateLimit(10, MINUTE)
  @Post()
  @UseGuards(CommunityMemberGuard)
  create(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Body() createPostDto: CreatePostDto,
  ) {
    return this.postsService.create(
      communityId,
      req.user.userId,
      createPostDto,
    );
  }
}

@Controller('posts')
@UseGuards(JwtAuthGuard)
export class PostController {
  constructor(private readonly postsService: PostsService) {}

  @RateLimit(30, MINUTE)
  @Patch(':postId')
  update(
    @Req() req,
    @Param('postId', ParseIntPipe) postId: number,
    @Body() updatePostDto: CreatePostDto,
  ) {
    return this.postsService.update(req.user.userId, postId, updatePostDto);
  }

  @RateLimit(30, MINUTE)
  @Put(':postId/pin')
  @HttpCode(204)
  pin(
    @Req() req,
    @Param('postId', ParseIntPipe) postId: number,
  ): Promise<void> {
    return this.postsService.setPinned(req.user.userId, postId, true);
  }

  @RateLimit(30, MINUTE)
  @Delete(':postId/pin')
  @HttpCode(204)
  unpin(
    @Req() req,
    @Param('postId', ParseIntPipe) postId: number,
  ): Promise<void> {
    return this.postsService.setPinned(req.user.userId, postId, false);
  }

  @RateLimit(30, MINUTE)
  @Delete(':postId')
  @HttpCode(204)
  remove(
    @Req() req,
    @Param('postId', ParseIntPipe) postId: number,
  ): Promise<void> {
    return this.postsService.remove(req.user.userId, postId);
  }
}
