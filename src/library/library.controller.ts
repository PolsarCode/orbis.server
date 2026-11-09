import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowGuest } from '../auth/allow-guest';
import { AddLibraryEntryDto } from './dto/add-library-entry.dto';
import { UpdateLibraryEntryDto } from './dto/update-library-entry.dto';
import { LibraryService } from './library.service';
import { SteamSyncService } from './steam-sync.service';
import { MediaType } from '../../prisma/generated/client';
import { RateLimit, MINUTE } from '../common/throttle';
import { UserId } from '../common/user-id';

@Controller('library')
@UseGuards(JwtAuthGuard)
export class LibraryController {
  constructor(
    private readonly libraryService: LibraryService,
    private readonly steamSync: SteamSyncService,
  ) {}

  @RateLimit(60, MINUTE)
  @Get('search')
  search(@UserId() userId: number, @Query('q') q?: string) {
    return this.libraryService.search(userId, q);
  }

  @AllowGuest()
  @RateLimit(60, MINUTE)
  @Get('spotlight')
  spotlight() {
    return this.libraryService.spotlight();
  }

  @AllowGuest()
  @RateLimit(60, MINUTE)
  @Get('spotlights')
  spotlights() {
    return this.libraryService.spotlights();
  }

  @AllowGuest()
  @RateLimit(60, MINUTE)
  @Get('lists/:type/:list')
  mediaList(
    @UserId() userId: number,
    @Param('type', new ParseEnumPipe(MediaType)) type: MediaType,
    @Param('list') list: string,
  ) {
    return this.libraryService.mediaList(userId, type, list);
  }

  @AllowGuest()
  @RateLimit(60, MINUTE)
  @Get('charts/:type')
  chart(
    @UserId() userId: number,
    @Param('type', new ParseEnumPipe(MediaType)) type: MediaType,
    @Query('week') week?: string,
  ) {
    return this.libraryService.chart(userId, type, week);
  }

  @AllowGuest()
  @RateLimit(60, MINUTE)
  @Get('charts/:type/discussion')
  chartDiscussion(
    @UserId() userId: number,
    @Param('type', new ParseEnumPipe(MediaType)) type: MediaType,
    @Query('week') week?: string,
  ) {
    return this.libraryService.chartDiscussion(userId, type, week);
  }

  @AllowGuest()
  @Get('media/:type/:sourceId')
  media(
    @UserId() userId: number,
    @Param('type', new ParseEnumPipe(MediaType)) type: MediaType,
    @Param('sourceId') sourceId: string,
  ) {
    return this.libraryService.media(userId, type, sourceId);
  }

  @Get()
  async list(@UserId() userId: number) {
    await this.steamSync.refresh(userId, { waitMs: 2_000 });
    return this.libraryService.list(userId);
  }

  @Post()
  add(
    @UserId() userId: number,
    @Body() addLibraryEntryDto: AddLibraryEntryDto,
  ) {
    return this.libraryService.add(userId, addLibraryEntryDto);
  }

  @Patch(':id')
  update(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() updateLibraryEntryDto: UpdateLibraryEntryDto,
  ) {
    return this.libraryService.update(userId, id, updateLibraryEntryDto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.libraryService.remove(userId, id);
  }
}
