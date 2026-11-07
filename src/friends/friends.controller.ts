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
import { UserId } from '../common/user-id';

@Controller('friends')
@UseGuards(JwtAuthGuard)
export class FriendsController {
  constructor(private readonly friendsService: FriendsService) {}

  @Get()
  findMine(@UserId() userId: number): Promise<FriendList> {
    return this.friendsService.list(userId);
  }

  @RateLimit(60, MINUTE)
  @Get('search')
  search(
    @UserId() userId: number,
    @Query() { q }: SearchPeopleDto,
  ): Promise<FriendUser[]> {
    return this.friendsService.search(userId, q);
  }

  @RateLimit(30, MINUTE)
  @Get('suggestions')
  suggestions(@UserId() userId: number): Promise<FriendSuggestion[]> {
    return this.friendsService.suggestions(userId);
  }

  @RateLimit(60, MINUTE)
  @Delete('suggestions/:userId')
  @HttpCode(204)
  dismissSuggestion(
    @UserId() userId: number,
    @Param('userId', ParseIntPipe) targetId: number,
  ): Promise<void> {
    return this.friendsService.dismissSuggestion(userId, targetId);
  }

  @RateLimit(20, HOUR, 5)
  @Post()
  @HttpCode(204)
  add(
    @UserId() userId: number,
    @Body() addFriendDto: AddFriendDto,
  ): Promise<void> {
    return this.friendsService.add(userId, addFriendDto);
  }

  @Delete(':userId')
  @HttpCode(204)
  remove(
    @UserId() userId: number,
    @Param('userId', ParseIntPipe) otherId: number,
  ): Promise<void> {
    return this.friendsService.remove(userId, otherId);
  }
}
