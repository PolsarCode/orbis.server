import { Module } from '@nestjs/common';
import { ChartShareService } from './chart-share.service';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';
import { PublicLibraryController } from './public-library.controller';
import { SteamSyncService } from './steam-sync.service';
import { PrismaService } from '../prisma.service';
import { DiscordChannelModule } from '../discord-channel/discord-channel.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LibraryNoticesService } from './library-notices.service';

@Module({
  imports: [DiscordChannelModule, NotificationsModule],
  controllers: [LibraryController, PublicLibraryController],
  providers: [
    LibraryService,
    SteamSyncService,
    ChartShareService,
    LibraryNoticesService,
    PrismaService,
  ],
  exports: [LibraryService, SteamSyncService, ChartShareService],
})
export class LibraryModule {}
