import {
  Controller,
  Get,
  Body,
  Param,
  Patch,
  Post,
  Delete,
  Put,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Req,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  Onboarding,
  Profile,
  PublicProfile,
  UsersService,
} from './users.service';
import { UpdateOnboardingDto } from './dto/update-onboarding.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { SuspendUserDto } from './dto/suspend-user.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowUnconfirmed } from '../auth/confirmed-email.guard';
import { AllowGuest } from '../auth/allow-guest';
import { PresenceGateway } from '../friends/presence.gateway';
import { SteamSyncService } from '../library/steam-sync.service';
import { IMAGE_MAX_BYTES } from '../storage/storage.service';
import { UserId } from '../common/user-id';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly presence: PresenceGateway,
    private readonly steamSync: SteamSyncService,
  ) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  async findProfile(@UserId() userId: number): Promise<Profile> {
    const profile = await this.usersService.findProfile(userId);
    if (!profile) throw new UnauthorizedException();
    return profile;
  }

  @Patch('me/preferences')
  @UseGuards(JwtAuthGuard)
  @AllowUnconfirmed()
  async updatePreferences(
    @UserId() userId: number,
    @Body() updatePreferencesDto: UpdatePreferencesDto,
  ): Promise<Profile> {
    const profile = await this.usersService.updatePreferences(
      userId,
      updatePreferencesDto,
    );

    if (
      updatePreferencesDto.appearOffline !== undefined ||
      updatePreferencesDto.status !== undefined
    ) {
      await this.presence.broadcastPresence(userId);
    }

    return profile;
  }

  @Post('me/avatar')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: IMAGE_MAX_BYTES } }),
  )
  uploadAvatar(
    @UserId() userId: number,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<Profile> {
    if (!file) throw new BadRequestException('Choose an image to upload');
    return this.usersService.updateAvatar(userId, file.buffer);
  }

  @Delete('me/avatar')
  @UseGuards(JwtAuthGuard)
  removeAvatar(@UserId() userId: number): Promise<Profile> {
    return this.usersService.removeAvatar(userId);
  }

  @Post('me/cover')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: IMAGE_MAX_BYTES } }),
  )
  uploadCover(
    @UserId() userId: number,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<Profile> {
    if (!file) throw new BadRequestException('Choose an image to upload');
    return this.usersService.updateCover(userId, file.buffer);
  }

  @Delete('me/cover')
  @UseGuards(JwtAuthGuard)
  removeCover(@UserId() userId: number): Promise<Profile> {
    return this.usersService.removeCover(userId);
  }

  @Post('me/background')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: IMAGE_MAX_BYTES } }),
  )
  uploadBackground(
    @UserId() userId: number,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<Profile> {
    if (!file) throw new BadRequestException('Choose an image to upload');
    return this.usersService.updateBackground(userId, file.buffer);
  }

  @Delete('me/background')
  @UseGuards(JwtAuthGuard)
  removeBackground(@UserId() userId: number): Promise<Profile> {
    return this.usersService.removeBackground(userId);
  }

  @Get('me/onboarding')
  @UseGuards(JwtAuthGuard)
  onboarding(@UserId() userId: number): Promise<Onboarding> {
    return this.usersService.onboarding(userId);
  }

  @Patch('me/onboarding')
  @UseGuards(JwtAuthGuard)
  @AllowUnconfirmed()
  updateOnboarding(
    @UserId() userId: number,
    @Body() updateOnboardingDto: UpdateOnboardingDto,
  ): Promise<Onboarding> {
    return this.usersService.updateOnboarding(userId, updateOnboardingDto);
  }

  @Put(':username/admin')
  @UseGuards(JwtAuthGuard)
  addAdmin(
    @UserId() userId: number,
    @Param('username') username: string,
  ): Promise<{ isAdmin: boolean }> {
    return this.usersService.setAdmin(userId, username, true);
  }

  @Delete(':username/admin')
  @UseGuards(JwtAuthGuard)
  removeAdmin(
    @UserId() userId: number,
    @Param('username') username: string,
  ): Promise<{ isAdmin: boolean }> {
    return this.usersService.setAdmin(userId, username, false);
  }

  @Put(':username/suspension')
  @UseGuards(JwtAuthGuard)
  suspend(
    @UserId() userId: number,
    @Param('username') username: string,
    @Body() body: SuspendUserDto,
  ) {
    return this.usersService.setSuspension(
      userId,
      username,
      body.duration,
      body.reason,
    );
  }

  @Delete(':username/suspension')
  @UseGuards(JwtAuthGuard)
  liftSuspension(
    @UserId() userId: number,
    @Param('username') username: string,
  ) {
    return this.usersService.setSuspension(userId, username, null);
  }

  @Put(':username/verified')
  @UseGuards(JwtAuthGuard)
  verify(
    @UserId() userId: number,
    @Param('username') username: string,
  ): Promise<{ isVerified: boolean }> {
    return this.usersService.setVerified(userId, username, true);
  }

  @Delete(':username/verified')
  @UseGuards(JwtAuthGuard)
  unverify(
    @UserId() userId: number,
    @Param('username') username: string,
  ): Promise<{ isVerified: boolean }> {
    return this.usersService.setVerified(userId, username, false);
  }

  @Get(':username')
  @AllowGuest()
  @UseGuards(JwtAuthGuard)
  async publicProfile(
    @Req() req,
    @Param('username') username: string,
  ): Promise<PublicProfile> {
    const {
      appearOffline,
      status: setting,
      friends,
      ...profile
    } = await this.usersService.publicProfile(req.user.userId, username);
    if (!profile.restricted) void this.steamSync.refresh(profile.userId);
    const status = this.presence.statusOf(profile.userId, {
      appearOffline,
      status: setting,
    });
    return {
      ...profile,
      suspension: await this.usersService.suspensionFor(
        req.user.userId,
        profile.userId,
      ),
      twoFactorEnabled: await this.usersService.twoFactorFor(
        req.user.userId,
        profile.userId,
      ),
      online: status !== 'offline',
      status,
      friends: friends.map(({ appearOffline, status, ...friend }) => {
        const friendStatus = this.presence.statusOf(friend.userId, {
          appearOffline,
          status,
        });
        return {
          ...friend,
          online: friendStatus !== 'offline',
          status: friendStatus,
          playing: this.presence.playingOf(friend.userId, {
            appearOffline,
            status,
          }),
          twitchLogin: this.presence.twitchOf(friend.userId, {
            appearOffline,
            status,
          }),
        };
      }),
    };
  }
}
