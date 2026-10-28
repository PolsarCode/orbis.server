import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowGuest } from '../auth/allow-guest';
import { RateLimit, MINUTE } from '../common/throttle';

@Controller('users/:username/posts')
@UseGuards(JwtAuthGuard)
export class UserPostsController {
  constructor(private readonly postsService: PostsService) {}

  @Get()
  @AllowGuest()
  findForProfile(
    @Req() req,
    @Param('username') username: string,
    @Query('cursor') cursor?: string,
    @Query('exclude') exclude?: string,
  ) {
    return this.postsService.findForProfile(
      req.user.userId,
      username,
      cursor,
      exclude,
    );
  }

  @RateLimit(60, MINUTE)
  @Get('search')
  @AllowGuest()
  search(@Req() req, @Param('username') username: string, @Query('q') q = '') {
    return this.postsService.searchProfile(req.user.userId, username, q);
  }

  @Get('activities/:activityId')
  @AllowGuest()
  findActivity(
    @Req() req,
    @Param('username') username: string,
    @Param('activityId', ParseIntPipe) activityId: number,
  ) {
    return this.postsService.findActivityForProfile(
      req.user.userId,
      username,
      activityId,
    );
  }

  @Get(':postId')
  @AllowGuest()
  findOne(
    @Req() req,
    @Param('username') username: string,
    @Param('postId', ParseIntPipe) postId: number,
  ) {
    return this.postsService.findOneForProfile(
      req.user.userId,
      username,
      postId,
    );
  }

  @RateLimit(10, MINUTE)
  @Post()
  createOnWall(
    @Req() req,
    @Param('username') username: string,
    @Body() createPostDto: CreatePostDto,
  ) {
    return this.postsService.createOnWall(
      username,
      req.user.userId,
      createPostDto,
    );
  }
}
