import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowUnconfirmed } from '../auth/confirmed-email.guard';
import { MINUTE, RateLimit } from '../common/throttle';
import { SafetyService } from './safety.service';
import { CreateKeywordFilterDto } from './dto/create-keyword-filter.dto';

@Controller()
@UseGuards(JwtAuthGuard)
@AllowUnconfirmed()
export class SafetyController {
  constructor(private readonly safetyService: SafetyService) {}

  @Get('blocks')
  blocks(@Req() req) {
    return this.safetyService.blocks(req.user.userId);
  }

  @RateLimit(30, MINUTE)
  @Post('users/:username/block')
  @HttpCode(200)
  block(@Req() req, @Param('username') username: string) {
    return this.safetyService.block(req.user.userId, username);
  }

  @RateLimit(30, MINUTE)
  @Delete('users/:username/block')
  unblock(@Req() req, @Param('username') username: string) {
    return this.safetyService.unblock(req.user.userId, username);
  }

  @Get('mutes')
  mutes(@Req() req) {
    return this.safetyService.mutes(req.user.userId);
  }

  @RateLimit(30, MINUTE)
  @Post('users/:username/mute')
  @HttpCode(200)
  mute(@Req() req, @Param('username') username: string) {
    return this.safetyService.mute(req.user.userId, username);
  }

  @RateLimit(30, MINUTE)
  @Delete('users/:username/mute')
  unmute(@Req() req, @Param('username') username: string) {
    return this.safetyService.unmute(req.user.userId, username);
  }

  @Get('keyword-filters')
  filters(@Req() req) {
    return this.safetyService.filters(req.user.userId);
  }

  @RateLimit(30, MINUTE)
  @Post('keyword-filters')
  addFilter(@Req() req, @Body() { phrase, duration }: CreateKeywordFilterDto) {
    return this.safetyService.addFilter(req.user.userId, phrase, duration);
  }

  @RateLimit(30, MINUTE)
  @Delete('keyword-filters/:id')
  @HttpCode(204)
  removeFilter(@Req() req, @Param('id', ParseIntPipe) id: number) {
    return this.safetyService.removeFilter(req.user.userId, id);
  }
}
