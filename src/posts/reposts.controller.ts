import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PostsService, RepostResult } from './posts.service';
import { RepostDto } from './dto/repost.dto';
import { shareType } from './shareable';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MINUTE, RateLimit } from '../common/throttle';
import { UserId } from '../common/user-id';

@Controller('reposts/:type/:id')
@UseGuards(JwtAuthGuard)
export class RepostsController {
  constructor(private readonly postsService: PostsService) {}

  @RateLimit(30, MINUTE)
  @Put()
  repost(
    @UserId() userId: number,
    @Param('type') type: string,
    @Param('id', ParseIntPipe) id: number,
    @Body() repostDto: RepostDto,
  ): Promise<RepostResult> {
    return this.postsService.setRepost(
      userId,
      { type: shareType(type), id },
      repostDto.communityId ?? null,
    );
  }

  @RateLimit(30, MINUTE)
  @Delete()
  undo(
    @UserId() userId: number,
    @Param('type') type: string,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<RepostResult> {
    return this.postsService.removeRepost(userId, {
      type: shareType(type),
      id,
    });
  }

  @Get('people')
  people(
    @UserId() userId: number,
    @Param('type') type: string,
    @Param('id', ParseIntPipe) id: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.postsService.findReposters(
      userId,
      { type: shareType(type), id },
      cursor,
    );
  }

  @Get('quotes')
  quotes(
    @UserId() userId: number,
    @Param('type') type: string,
    @Param('id', ParseIntPipe) id: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.postsService.findQuotes(
      userId,
      { type: shareType(type), id },
      cursor,
    );
  }
}
