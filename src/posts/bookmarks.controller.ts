import {
  Body,
  Controller,
  Get,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { BookmarkResult, PostsService } from './posts.service';
import { BookmarkDto } from './dto/bookmark.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MINUTE, RateLimit } from '../common/throttle';

@Controller('bookmarks')
@UseGuards(JwtAuthGuard)
export class BookmarksController {
  constructor(private readonly postsService: PostsService) {}

  @Get()
  findAll(@Req() req, @Query('cursor') cursor?: string) {
    return this.postsService.findBookmarks(req.user.userId, cursor);
  }

  @RateLimit(60, MINUTE)
  @Get('search')
  search(@Req() req, @Query('q') q = '') {
    return this.postsService.searchBookmarks(req.user.userId, q);
  }

  @Put()
  setBookmark(
    @Req() req,
    @Body() bookmarkDto: BookmarkDto,
  ): Promise<BookmarkResult> {
    return this.postsService.setBookmark(req.user.userId, bookmarkDto);
  }
}
