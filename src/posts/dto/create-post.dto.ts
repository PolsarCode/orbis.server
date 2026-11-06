import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SPOILER_MAX } from '../../common/spoiler';
import type { ShareType } from '../shareable';

export class ShareTargetDto {
  @IsIn(['post', 'activity'])
  type: ShareType;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  id: number;
}

export class CreatePostDto {
  @IsString()
  @MaxLength(20000)
  content: string;

  @IsOptional()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  linkUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(SPOILER_MAX)
  spoiler?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => ShareTargetDto)
  quote?: ShareTargetDto;
}
