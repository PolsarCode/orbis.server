import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { EmailConfirmationService } from './email-confirmation.service';
import { JwtStrategy } from './jwt.strategy';
import { OAuthController } from './oauth/oauth.controller';
import { OAuthService } from './oauth/oauth.service';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma.service';
import { StorageModule } from '../storage/storage.module';
import { PresenceModule } from '../friends/presence.module';
import { CommunitiesModule } from '../communities/communities.module';
import { DiscordChannelModule } from '../discord-channel/discord-channel.module';
import { TwoFactorController } from './two-factor/two-factor.controller';
import { TwoFactorService } from './two-factor/two-factor.service';

@Module({
  imports: [
    PassportModule,
    StorageModule,
    PresenceModule,
    CommunitiesModule,
    DiscordChannelModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '7d' },
    }),
  ],
  providers: [
    AuthService,
    EmailConfirmationService,
    OAuthService,
    TwoFactorService,
    JwtStrategy,
    UsersService,
    PrismaService,
  ],
  controllers: [AuthController, OAuthController, TwoFactorController],
})
export class AuthModule {}
