import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { BookmarkResult, PostsService } from './posts.service';
import { BookmarkDto } from './dto/bookmark.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MINUTE, RateLimit } from '../common/throttle';
import { UserId } from '../common/user-id';

@Controller('bookmarks')
@UseGuards(JwtAuthGuard)
export class BookmarksController {
  constructor(private readonly postsService: PostsService) {}

  @Get()
  findAll(@UserId() userId: number, @Query('cursor') cursor?: string) {
    return this.postsService.findBookmarks(userId, cursor);
  }

  @RateLimit(60, MINUTE)
  @Get('search')
  search(@UserId() userId: number, @Query('q') q = '') {
    return this.postsService.searchBookmarks(userId, q);
  }

  @Put()
  setBookmark(
    @UserId() userId: number,
    @Body() bookmarkDto: BookmarkDto,
  ): Promise<BookmarkResult> {
    return this.postsService.setBookmark(userId, bookmarkDto);
  }
}
