import { IsOptional, IsString, MaxLength } from 'class-validator';
import { IsId, IsLinkUrl, IsSpoiler } from '../../common/validators';

export const THREAD_TITLE_MAX = 120;
export const FORUM_POST_MAX = 20000;

export class UpdateForumPostDto {
  @IsString()
  @MaxLength(FORUM_POST_MAX)
  content: string;

  @IsOptional()
  @IsLinkUrl()
  linkUrl?: string;

  @IsOptional()
  @IsSpoiler()
  spoiler?: string | null;
}

export class CreateForumThreadDto extends UpdateForumPostDto {
  @IsString()
  @MaxLength(THREAD_TITLE_MAX)
  title: string;
}

export class UpdateForumThreadDto {
  @IsOptional()
  @IsString()
  @MaxLength(THREAD_TITLE_MAX)
  title?: string;

  @IsOptional()
  @IsId()
  categoryId?: number;
}

export class CreateForumPostDto {
  @IsString()
  @MaxLength(FORUM_POST_MAX)
  content: string;

  @IsOptional()
  @IsId()
  quoteId?: number;

  @IsOptional()
  @IsLinkUrl()
  linkUrl?: string;

  @IsOptional()
  @IsSpoiler()
  spoiler?: string | null;
}
