import { IsIn, Matches } from 'class-validator';
import { MediaType } from '../../../prisma/generated/client';
import { UpdateLibraryEntryDto } from './update-library-entry.dto';

export class AddLibraryEntryDto extends UpdateLibraryEntryDto {
  @IsIn(Object.values(MediaType))
  type: MediaType;

  @Matches(/^\d{1,12}$/, { message: 'sourceId must be a number' })
  sourceId: string;
}
