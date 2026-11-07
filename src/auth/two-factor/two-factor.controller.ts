import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../jwt.guard';
import { AllowUnconfirmed } from '../confirmed-email.guard';
import { MINUTE, RateLimit } from '../../common/throttle';
import { TwoFactorCodeDto, TwoFactorLoginDto } from './two-factor.dto';
import { TwoFactorService } from './two-factor.service';
import { UserId } from '../../common/user-id';

@Controller()
export class TwoFactorController {
  constructor(private readonly twoFactor: TwoFactorService) {}

  @AllowUnconfirmed()
  @RateLimit(10, MINUTE)
  @Post('auth/login/two-factor')
  @HttpCode(200)
  login(@Body() { ticket, code }: TwoFactorLoginDto) {
    return this.twoFactor.completeLogin(ticket, code);
  }

  @RateLimit(10, MINUTE)
  @Post('users/me/two-factor/setup')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  setup(@UserId() userId: number) {
    return this.twoFactor.setup(userId);
  }

  @RateLimit(10, MINUTE)
  @Post('users/me/two-factor/enable')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  enable(@UserId() userId: number, @Body() { code }: TwoFactorCodeDto) {
    return this.twoFactor.enable(userId, code);
  }

  @RateLimit(10, MINUTE)
  @Post('users/me/two-factor/disable')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  disable(
    @UserId() userId: number,
    @Body() { code }: TwoFactorCodeDto,
  ): Promise<void> {
    return this.twoFactor.disable(userId, code);
  }

  @RateLimit(30, MINUTE)
  @Delete('users/:username/two-factor')
  @UseGuards(JwtAuthGuard)
  reset(@UserId() userId: number, @Param('username') username: string) {
    return this.twoFactor.reset(userId, username);
  }
}
