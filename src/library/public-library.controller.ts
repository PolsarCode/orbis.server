import { Controller, Get, Header } from '@nestjs/common';
import { LibraryService } from './library.service';

@Controller('public/library-updates')
export class PublicLibraryController {
  constructor(private readonly libraryService: LibraryService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  latest() {
    return this.libraryService.publicUpdates();
  }
}
