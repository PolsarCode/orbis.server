import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../jwt.guard';
import { AllowUnconfirmed } from '../confirmed-email.guard';
import { MINUTE, RateLimit } from '../../common/throttle';
import { TwoFactorCodeDto, TwoFactorLoginDto } from './two-factor.dto';
import { TwoFactorService } from './two-factor.service';

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
  setup(@Req() req) {
    return this.twoFactor.setup(req.user.userId);
  }

  @RateLimit(10, MINUTE)
  @Post('users/me/two-factor/enable')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  enable(@Req() req, @Body() { code }: TwoFactorCodeDto) {
    return this.twoFactor.enable(req.user.userId, code);
  }

  @RateLimit(10, MINUTE)
  @Post('users/me/two-factor/disable')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  disable(@Req() req, @Body() { code }: TwoFactorCodeDto): Promise<void> {
    return this.twoFactor.disable(req.user.userId, code);
  }

  @RateLimit(30, MINUTE)
  @Delete('users/:username/two-factor')
  @UseGuards(JwtAuthGuard)
  reset(@Req() req, @Param('username') username: string) {
    return this.twoFactor.reset(req.user.userId, username);
  }
}
