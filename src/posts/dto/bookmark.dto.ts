import { IsBoolean, IsIn, IsInt, Max, Min } from 'class-validator';
import { BookmarkableType } from '../../../prisma/generated/client';

export class BookmarkDto {
  @IsIn(Object.values(BookmarkableType))
  type: BookmarkableType;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  id: number;

  @IsBoolean()
  bookmarked: boolean;
}
