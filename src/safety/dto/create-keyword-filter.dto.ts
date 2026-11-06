import { IsIn, IsString, MaxLength } from 'class-validator';
import { FILTER_DURATIONS, FilterDuration } from '../keywords';

export class CreateKeywordFilterDto {
  @IsString()
  @MaxLength(200)
  phrase: string;

  @IsIn(FILTER_DURATIONS)
  duration: FilterDuration;
}
