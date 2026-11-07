import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowGuest } from '../auth/allow-guest';
import { MediaType } from '../../prisma/generated/client';
import { RateLimit, MINUTE } from '../common/throttle';
import { UserId } from '../common/user-id';

@Controller('library/media/:type/:sourceId/posts')
@UseGuards(JwtAuthGuard)
export class MediaPostsController {
  constructor(private readonly postsService: PostsService) {}

  @AllowGuest()
  @Get()
  findForMedia(
    @UserId() userId: number,
    @Param('type', new ParseEnumPipe(MediaType)) type: MediaType,
    @Param('sourceId') sourceId: string,
    @Query('cursor') cursor?: string,
    @Query('exclude') exclude?: string,
  ) {
    return this.postsService.findForMedia(
      userId,
      type,
      sourceId,
      cursor,
      exclude,
    );
  }

  @AllowGuest()
  @Get(':postId')
  findOne(
    @UserId() userId: number,
    @Param('type', new ParseEnumPipe(MediaType)) type: MediaType,
    @Param('sourceId') sourceId: string,
    @Param('postId', ParseIntPipe) postId: number,
  ) {
    return this.postsService.findOneForMedia(userId, type, sourceId, postId);
  }

  @RateLimit(10, MINUTE)
  @Post()
  createOnMedia(
    @UserId() userId: number,
    @Param('type', new ParseEnumPipe(MediaType)) type: MediaType,
    @Param('sourceId') sourceId: string,
    @Body() createPostDto: CreatePostDto,
  ) {
    return this.postsService.createOnMedia(
      type,
      sourceId,
      userId,
      createPostDto,
    );
  }
}
