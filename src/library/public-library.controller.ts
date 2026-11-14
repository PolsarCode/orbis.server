import { Controller, Get, Header } from '@nestjs/common';
import { LibraryService } from './library.service';

@Controller('public')
export class PublicLibraryController {
  constructor(private readonly libraryService: LibraryService) {}

  @Get('library-updates')
  @Header('Cache-Control', 'no-store')
  latest() {
    return this.libraryService.publicUpdates();
  }

  @Get('library-titles')
  @Header('Cache-Control', 'public, max-age=3600')
  titles() {
    return this.libraryService.publicTitles();
  }
}
