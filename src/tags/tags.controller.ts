import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TagsService } from './tags.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowGuest } from '../auth/allow-guest';
import { MINUTE, RateLimit } from '../common/throttle';
import { UserId } from '../common/user-id';
import { parseUntil } from '../common/weekly-window';

@Controller('tags')
@UseGuards(JwtAuthGuard)
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Get('trending')
  trending(@UserId() userId: number) {
    return this.tagsService.trending(userId);
  }

  @AllowGuest()
  @RateLimit(60, MINUTE)
  @Get('weekly')
  weekly(@Query('until') until?: string) {
    return this.tagsService.weekly(parseUntil(until));
  }

  @Get('following')
  following(@UserId() userId: number) {
    return this.tagsService.following(userId);
  }

  @RateLimit(60, MINUTE)
  @Get('search')
  search(@UserId() userId: number, @Query('q') q = '') {
    return this.tagsService.search(userId, q);
  }

  @Get(':name/items')
  findOne(
    @UserId() userId: number,
    @Param('name') name: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.tagsService.findOne(userId, name, cursor);
  }

  @RateLimit(30, MINUTE)
  @Post(':name/follow')
  follow(@UserId() userId: number, @Param('name') name: string) {
    return this.tagsService.follow(userId, name);
  }

  @RateLimit(30, MINUTE)
  @Delete(':name/follow')
  unfollow(@UserId() userId: number, @Param('name') name: string) {
    return this.tagsService.unfollow(userId, name);
  }
}
