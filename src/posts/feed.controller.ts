import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PostsService } from './posts.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MINUTE, RateLimit } from '../common/throttle';
import { UserId } from '../common/user-id';

@Controller('feed')
@UseGuards(JwtAuthGuard)
export class FeedController {
  constructor(private readonly postsService: PostsService) {}

  @Get()
  findMine(
    @UserId() userId: number,
    @Query('cursor') cursor?: string,
    @Query('exclude') exclude?: string,
  ) {
    return this.postsService.findForMember(userId, cursor, exclude);
  }

  @RateLimit(60, MINUTE)
  @Get('search')
  search(@UserId() userId: number, @Query('q') q = '') {
    return this.postsService.searchFeed(userId, q);
  }
}
