import { Module } from '@nestjs/common';
import { ChartShareService } from './chart-share.service';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';
import { PublicLibraryController } from './public-library.controller';
import { SteamSyncService } from './steam-sync.service';
import { PrismaService } from '../prisma.service';
import { DiscordChannelModule } from '../discord-channel/discord-channel.module';

@Module({
  imports: [DiscordChannelModule],
  controllers: [LibraryController, PublicLibraryController],
  providers: [
    LibraryService,
    SteamSyncService,
    ChartShareService,
    PrismaService,
  ],
  exports: [LibraryService, SteamSyncService, ChartShareService],
})
export class LibraryModule {}
