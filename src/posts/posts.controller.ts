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
  UseGuards,
} from '@nestjs/common';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowGuest } from '../auth/allow-guest';
import { CommunityMemberGuard } from '../communities/community-member.guard';
import { CommunityViewerGuard } from '../communities/community-viewer.guard';
import { RateLimit, MINUTE } from '../common/throttle';
import { UserId } from '../common/user-id';
import { EditHistory } from '../common/edit-history';

@Controller('communities/:communityId/posts')
@UseGuards(JwtAuthGuard)
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Get()
  @AllowGuest()
  @UseGuards(CommunityViewerGuard)
  findAll(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Query('cursor') cursor?: string,
    @Query('exclude') exclude?: string,
  ) {
    return this.postsService.findForCommunity(
      userId,
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
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Query('q') q = '',
  ) {
    return this.postsService.searchCommunity(userId, communityId, q);
  }

  @Get('activities/:activityId')
  @AllowGuest()
  @UseGuards(CommunityViewerGuard)
  findActivity(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('activityId', ParseIntPipe) activityId: number,
  ) {
    return this.postsService.findActivityInCommunity(
      userId,
      communityId,
      activityId,
    );
  }

  @Get(':postId')
  @AllowGuest()
  @UseGuards(CommunityViewerGuard)
  findOne(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('postId', ParseIntPipe) postId: number,
  ) {
    return this.postsService.findOneInCommunity(userId, communityId, postId);
  }

  @RateLimit(10, MINUTE)
  @Post()
  @UseGuards(CommunityMemberGuard)
  create(
    @UserId() userId: number,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Body() createPostDto: CreatePostDto,
  ) {
    return this.postsService.create(communityId, userId, createPostDto);
  }
}

@Controller('posts')
@UseGuards(JwtAuthGuard)
export class PostController {
  constructor(private readonly postsService: PostsService) {}

  @Get(':postId/edits')
  @AllowGuest()
  edits(
    @UserId() userId: number,
    @Param('postId', ParseIntPipe) postId: number,
  ): Promise<EditHistory> {
    return this.postsService.findEdits(userId, postId);
  }

  @RateLimit(30, MINUTE)
  @Patch(':postId')
  update(
    @UserId() userId: number,
    @Param('postId', ParseIntPipe) postId: number,
    @Body() updatePostDto: CreatePostDto,
  ) {
    return this.postsService.update(userId, postId, updatePostDto);
  }

  @RateLimit(30, MINUTE)
  @Put(':postId/pin')
  @HttpCode(204)
  pin(
    @UserId() userId: number,
    @Param('postId', ParseIntPipe) postId: number,
  ): Promise<void> {
    return this.postsService.setPinned(userId, postId, true);
  }

  @RateLimit(30, MINUTE)
  @Delete(':postId/pin')
  @HttpCode(204)
  unpin(
    @UserId() userId: number,
    @Param('postId', ParseIntPipe) postId: number,
  ): Promise<void> {
    return this.postsService.setPinned(userId, postId, false);
  }

  @RateLimit(30, MINUTE)
  @Delete(':postId')
  @HttpCode(204)
  remove(
    @UserId() userId: number,
    @Param('postId', ParseIntPipe) postId: number,
  ): Promise<void> {
    return this.postsService.remove(userId, postId);
  }
}
