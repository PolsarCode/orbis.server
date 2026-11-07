import { IsBoolean, IsIn } from 'class-validator';
import { IsId } from '../../common/validators';
import { BookmarkableType } from '../../../prisma/generated/client';

export class BookmarkDto {
  @IsIn(Object.values(BookmarkableType))
  type: BookmarkableType;

  @IsId()
  id: number;

  @IsBoolean()
  bookmarked: boolean;
}
