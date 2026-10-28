import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MediaType } from '../../prisma/generated/client';
import { RateLimit, MINUTE } from '../common/throttle';

@Controller('library/media/:type/:sourceId/posts')
@UseGuards(JwtAuthGuard)
export class MediaPostsController {
  constructor(private readonly postsService: PostsService) {}

  @Get()
  findForMedia(
    @Req() req,
    @Param('type', new ParseEnumPipe(MediaType)) type: MediaType,
    @Param('sourceId') sourceId: string,
    @Query('cursor') cursor?: string,
    @Query('exclude') exclude?: string,
  ) {
    return this.postsService.findForMedia(
      req.user.userId,
      type,
      sourceId,
      cursor,
      exclude,
    );
  }

  @Get(':postId')
  findOne(
    @Req() req,
    @Param('type', new ParseEnumPipe(MediaType)) type: MediaType,
    @Param('sourceId') sourceId: string,
    @Param('postId', ParseIntPipe) postId: number,
  ) {
    return this.postsService.findOneForMedia(
      req.user.userId,
      type,
      sourceId,
      postId,
    );
  }

  @RateLimit(10, MINUTE)
  @Post()
  createOnMedia(
    @Req() req,
    @Param('type', new ParseEnumPipe(MediaType)) type: MediaType,
    @Param('sourceId') sourceId: string,
    @Body() createPostDto: CreatePostDto,
  ) {
    return this.postsService.createOnMedia(
      type,
      sourceId,
      req.user.userId,
      createPostDto,
    );
  }
}
