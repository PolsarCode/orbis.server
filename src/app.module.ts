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
import { ForumModule } from './forum/forum.module';
import { CommunityMembersModule } from './community-members/community-members.module';
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
import { DiscordChartsModule } from './discord-charts/discord-charts.module';
import { TagsModule } from './tags/tags.module';
import { SafetyModule } from './safety/safety.module';
import { AccountModule } from './account/account.module';
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
    ForumModule,
    CommunityMembersModule,
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
    DiscordChartsModule,
    TagsModule,
    SafetyModule,
    AccountModule,
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
