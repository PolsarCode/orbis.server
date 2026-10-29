import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { EmailConfirmationService } from './email-confirmation.service';
import { JwtAuthGuard } from './jwt.guard';
import { AllowUnconfirmed } from './confirmed-email.guard';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { ConfirmEmailDto } from './dto/confirm-email.dto';
import { HOUR, MINUTE, RateLimit } from '../common/throttle';
import { clientIp } from '../common/client-ip';
import { verifyTurnstile } from './turnstile';

@Controller('auth')
@AllowUnconfirmed()
export class AuthController {
  constructor(
    private authService: AuthService,
    private emailConfirmation: EmailConfirmationService,
  ) {}

  @RateLimit(3, HOUR)
  @Post('signup')
  async signup(@Body() body: SignupDto, @Req() req) {
    const { turnstileToken, ...details } = body;
    await verifyTurnstile(turnstileToken, clientIp(req));
    return this.authService.signup(details);
  }

  @RateLimit(10, MINUTE)
  @Post('login')
  async login(@Body() body: LoginDto, @Req() req) {
    await verifyTurnstile(body.turnstileToken, clientIp(req));
    return this.authService.login(body.identifier, body.password);
  }

  @RateLimit(10, MINUTE)
  @Post('confirm-email')
  confirmEmail(@Body() { token }: ConfirmEmailDto) {
    return this.emailConfirmation.confirm(token);
  }

  @RateLimit(3, HOUR)
  @Post('confirm-email/resend')
  @UseGuards(JwtAuthGuard)
  resendConfirmation(@Req() req) {
    return this.emailConfirmation.resend(req.user.userId);
  }
}
