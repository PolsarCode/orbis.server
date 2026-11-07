import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MINUTE, RateLimit } from '../common/throttle';
import { ConnectSteamDto } from './dto/connect-steam.dto';
import { UpdateSteamDto } from './dto/update-steam.dto';
import { SteamService, SteamStatus } from './steam.service';
import { UserId } from '../common/user-id';

@Controller('steam')
@UseGuards(JwtAuthGuard)
export class SteamController {
  constructor(private readonly steam: SteamService) {}

  @Get()
  status(@UserId() userId: number): Promise<SteamStatus> {
    return this.steam.status(userId);
  }

  @RateLimit(30, MINUTE)
  @Get('connect-url')
  connectUrl(@UserId() userId: number, @Query('nonce') nonce = '') {
    return { url: this.steam.connectUrl(userId, nonce) };
  }

  @RateLimit(10, MINUTE)
  @Post('connect')
  connect(
    @UserId() userId: number,
    @Body() body: ConnectSteamDto,
  ): Promise<SteamStatus> {
    return this.steam.connect(userId, body);
  }

  @RateLimit(5, MINUTE)
  @Post('import')
  importPlayed(
    @UserId() userId: number,
  ): Promise<{ imported: number; status: SteamStatus }> {
    return this.steam.importPlayed(userId);
  }

  @RateLimit(30, MINUTE)
  @Patch()
  update(
    @UserId() userId: number,
    @Body() { trackGames, showPlaying }: UpdateSteamDto,
  ): Promise<SteamStatus> {
    return this.steam.updateSettings(userId, {
      trackGames,
      showPlaying,
    });
  }

  @Delete()
  @HttpCode(204)
  disconnect(@UserId() userId: number): Promise<void> {
    return this.steam.disconnect(userId);
  }
}
