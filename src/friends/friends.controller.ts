import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  FriendList,
  FriendSuggestion,
  FriendUser,
  FriendsService,
} from './friends.service';
import { AddFriendDto } from './dto/add-friend.dto';
import { SearchPeopleDto } from './dto/search-people.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { HOUR, MINUTE, RateLimit } from '../common/throttle';

@Controller('friends')
@UseGuards(JwtAuthGuard)
export class FriendsController {
  constructor(private readonly friendsService: FriendsService) {}

  @Get()
  findMine(@Req() req): Promise<FriendList> {
    return this.friendsService.list(req.user.userId);
  }

  @RateLimit(60, MINUTE)
  @Get('search')
  search(@Req() req, @Query() { q }: SearchPeopleDto): Promise<FriendUser[]> {
    return this.friendsService.search(req.user.userId, q);
  }

  @RateLimit(30, MINUTE)
  @Get('suggestions')
  suggestions(@Req() req): Promise<FriendSuggestion[]> {
    return this.friendsService.suggestions(req.user.userId);
  }

  @RateLimit(20, HOUR, 5)
  @Post()
  @HttpCode(204)
  add(@Req() req, @Body() addFriendDto: AddFriendDto): Promise<void> {
    return this.friendsService.add(req.user.userId, addFriendDto);
  }

  @Delete(':userId')
  @HttpCode(204)
  remove(
    @Req() req,
    @Param('userId', ParseIntPipe) userId: number,
  ): Promise<void> {
    return this.friendsService.remove(req.user.userId, userId);
  }
}
