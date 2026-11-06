import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PostsService, RepostResult } from './posts.service';
import { RepostDto } from './dto/repost.dto';
import { shareType } from './shareable';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MINUTE, RateLimit } from '../common/throttle';

@Controller('reposts/:type/:id')
@UseGuards(JwtAuthGuard)
export class RepostsController {
  constructor(private readonly postsService: PostsService) {}

  @RateLimit(30, MINUTE)
  @Put()
  repost(
    @Req() req,
    @Param('type') type: string,
    @Param('id', ParseIntPipe) id: number,
    @Body() repostDto: RepostDto,
  ): Promise<RepostResult> {
    return this.postsService.setRepost(
      req.user.userId,
      { type: shareType(type), id },
      repostDto.communityId ?? null,
    );
  }

  @RateLimit(30, MINUTE)
  @Delete()
  undo(
    @Req() req,
    @Param('type') type: string,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<RepostResult> {
    return this.postsService.removeRepost(req.user.userId, {
      type: shareType(type),
      id,
    });
  }

  @Get('people')
  people(
    @Req() req,
    @Param('type') type: string,
    @Param('id', ParseIntPipe) id: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.postsService.findReposters(
      req.user.userId,
      { type: shareType(type), id },
      cursor,
    );
  }

  @Get('quotes')
  quotes(
    @Req() req,
    @Param('type') type: string,
    @Param('id', ParseIntPipe) id: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.postsService.findQuotes(
      req.user.userId,
      { type: shareType(type), id },
      cursor,
    );
  }
}
