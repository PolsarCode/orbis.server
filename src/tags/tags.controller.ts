import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TagsService } from './tags.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MINUTE, RateLimit } from '../common/throttle';

@Controller('tags')
@UseGuards(JwtAuthGuard)
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Get('trending')
  trending(@Req() req) {
    return this.tagsService.trending(req.user.userId);
  }

  @Get('following')
  following(@Req() req) {
    return this.tagsService.following(req.user.userId);
  }

  @RateLimit(60, MINUTE)
  @Get('search')
  search(@Req() req, @Query('q') q = '') {
    return this.tagsService.search(req.user.userId, q);
  }

  @Get(':name/items')
  findOne(
    @Req() req,
    @Param('name') name: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.tagsService.findOne(req.user.userId, name, cursor);
  }

  @RateLimit(30, MINUTE)
  @Post(':name/follow')
  follow(@Req() req, @Param('name') name: string) {
    return this.tagsService.follow(req.user.userId, name);
  }

  @RateLimit(30, MINUTE)
  @Delete(':name/follow')
  unfollow(@Req() req, @Param('name') name: string) {
    return this.tagsService.unfollow(req.user.userId, name);
  }
}
