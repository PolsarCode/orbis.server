import { Module } from '@nestjs/common';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';
import { PublicLibraryController } from './public-library.controller';
import { SteamSyncService } from './steam-sync.service';
import { PrismaService } from '../prisma.service';
import { DiscordChannelModule } from '../discord-channel/discord-channel.module';

@Module({
  imports: [DiscordChannelModule],
  controllers: [LibraryController, PublicLibraryController],
  providers: [LibraryService, SteamSyncService, PrismaService],
  exports: [SteamSyncService],
})
export class LibraryModule {}
