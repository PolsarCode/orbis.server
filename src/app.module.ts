import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfirmedEmailGuard } from './auth/confirmed-email.guard';
import { SuspendedAccountGuard } from './auth/suspended-account.guard';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppThrottlerGuard, throttlerOptions } from './common/throttle';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { CommunitiesModule } from './communities/communities.module';
import { PostsModule } from './posts/posts.module';
import { FriendsModule } from './friends/friends.module';
import { CommentsModule } from './comments/comments.module';
import { LikesModule } from './likes/likes.module';
import { StatsModule } from './stats/stats.module';
import { ReportsModule } from './reports/reports.module';
import { NotificationsModule } from './notifications/notifications.module';
import { LibraryModule } from './library/library.module';
import { SteamModule } from './steam/steam.module';
import { InvitesModule } from './invites/invites.module';
import { AdminModule } from './admin/admin.module';
import { ModerationModule } from './moderation/moderation.module';
import { MessagesModule } from './messages/messages.module';
import { LinksModule } from './links/links.module';
import { ClipsModule } from './clips/clips.module';
import { DiscordChannelModule } from './discord-channel/discord-channel.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma.service';

@Module({
  imports: [
    ThrottlerModule.forRoot(throttlerOptions),
    UsersModule,
    AuthModule,
    CommunitiesModule,
    PostsModule,
    FriendsModule,
    CommentsModule,
    LikesModule,
    StatsModule,
    ReportsModule,
    NotificationsModule,
    LibraryModule,
    SteamModule,
    InvitesModule,
    AdminModule,
    ModerationModule,
    MessagesModule,
    LinksModule,
    ClipsModule,
    DiscordChannelModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    PrismaService,
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: SuspendedAccountGuard },
    { provide: APP_GUARD, useClass: ConfirmedEmailGuard },
  ],
})
export class AppModule {}
