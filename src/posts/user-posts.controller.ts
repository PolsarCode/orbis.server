import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowGuest } from '../auth/allow-guest';
import { RateLimit, MINUTE } from '../common/throttle';
import { UserId } from '../common/user-id';

@Controller('users/:username/posts')
@UseGuards(JwtAuthGuard)
export class UserPostsController {
  constructor(private readonly postsService: PostsService) {}

  @Get()
  @AllowGuest()
  findForProfile(
    @UserId() userId: number,
    @Param('username') username: string,
    @Query('cursor') cursor?: string,
    @Query('exclude') exclude?: string,
  ) {
    return this.postsService.findForProfile(userId, username, cursor, exclude);
  }

  @RateLimit(60, MINUTE)
  @Get('search')
  @AllowGuest()
  search(
    @UserId() userId: number,
    @Param('username') username: string,
    @Query('q') q = '',
  ) {
    return this.postsService.searchProfile(userId, username, q);
  }

  @Get('activities/:activityId')
  @AllowGuest()
  findActivity(
    @UserId() userId: number,
    @Param('username') username: string,
    @Param('activityId', ParseIntPipe) activityId: number,
  ) {
    return this.postsService.findActivityForProfile(
      userId,
      username,
      activityId,
    );
  }

  @Get(':postId')
  @AllowGuest()
  findOne(
    @UserId() userId: number,
    @Param('username') username: string,
    @Param('postId', ParseIntPipe) postId: number,
  ) {
    return this.postsService.findOneForProfile(userId, username, postId);
  }

  @RateLimit(10, MINUTE)
  @Post()
  createOnWall(
    @UserId() userId: number,
    @Param('username') username: string,
    @Body() createPostDto: CreatePostDto,
  ) {
    return this.postsService.createOnWall(username, userId, createPostDto);
  }
}
