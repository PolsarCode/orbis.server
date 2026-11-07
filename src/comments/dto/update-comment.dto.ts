import { IsOptional, IsString, MaxLength } from 'class-validator';
import { IsLinkUrl, IsSpoiler } from '../../common/validators';

export class UpdateCommentDto {
  @IsString()
  @MaxLength(10000)
  content: string;

  @IsOptional()
  @IsLinkUrl()
  linkUrl?: string;

  @IsOptional()
  @IsSpoiler()
  spoiler?: string | null;
}
