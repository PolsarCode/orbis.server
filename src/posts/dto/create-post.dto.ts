import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsId, IsLinkUrl, IsSpoiler } from '../../common/validators';
import type { ShareType } from '../shareable';

export class ShareTargetDto {
  @IsIn(['post', 'activity'])
  type: ShareType;

  @IsId()
  id: number;
}

export class CreatePostDto {
  @IsString()
  @MaxLength(20000)
  content: string;

  @IsOptional()
  @IsLinkUrl()
  linkUrl?: string;

  @IsOptional()
  @IsSpoiler()
  spoiler?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => ShareTargetDto)
  quote?: ShareTargetDto;
}
