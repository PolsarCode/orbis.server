import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowUnconfirmed } from '../auth/confirmed-email.guard';
import { MINUTE, RateLimit } from '../common/throttle';
import { SafetyService } from './safety.service';
import { CreateKeywordFilterDto } from './dto/create-keyword-filter.dto';
import { UserId } from '../common/user-id';

@Controller()
@UseGuards(JwtAuthGuard)
@AllowUnconfirmed()
export class SafetyController {
  constructor(private readonly safetyService: SafetyService) {}

  @Get('blocks')
  blocks(@UserId() userId: number) {
    return this.safetyService.blocks(userId);
  }

  @RateLimit(30, MINUTE)
  @Post('users/:username/block')
  @HttpCode(200)
  block(@UserId() userId: number, @Param('username') username: string) {
    return this.safetyService.block(userId, username);
  }

  @RateLimit(30, MINUTE)
  @Delete('users/:username/block')
  unblock(@UserId() userId: number, @Param('username') username: string) {
    return this.safetyService.unblock(userId, username);
  }

  @Get('mutes')
  mutes(@UserId() userId: number) {
    return this.safetyService.mutes(userId);
  }

  @RateLimit(30, MINUTE)
  @Post('users/:username/mute')
  @HttpCode(200)
  mute(@UserId() userId: number, @Param('username') username: string) {
    return this.safetyService.mute(userId, username);
  }

  @RateLimit(30, MINUTE)
  @Delete('users/:username/mute')
  unmute(@UserId() userId: number, @Param('username') username: string) {
    return this.safetyService.unmute(userId, username);
  }

  @Get('keyword-filters')
  filters(@UserId() userId: number) {
    return this.safetyService.filters(userId);
  }

  @RateLimit(30, MINUTE)
  @Post('keyword-filters')
  addFilter(
    @UserId() userId: number,
    @Body() { phrase, duration }: CreateKeywordFilterDto,
  ) {
    return this.safetyService.addFilter(userId, phrase, duration);
  }

  @RateLimit(30, MINUTE)
  @Delete('keyword-filters/:id')
  @HttpCode(204)
  removeFilter(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.safetyService.removeFilter(userId, id);
  }
}
