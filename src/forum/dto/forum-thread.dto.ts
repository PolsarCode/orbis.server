import {
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SPOILER_MAX } from '../../common/spoiler';

export const THREAD_TITLE_MAX = 120;
export const FORUM_POST_MAX = 20000;

export class CreateForumThreadDto {
  @IsString()
  @MaxLength(THREAD_TITLE_MAX)
  title: string;

  @IsString()
  @MaxLength(FORUM_POST_MAX)
  content: string;

  @IsOptional()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  linkUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(SPOILER_MAX)
  spoiler?: string | null;
}

export class UpdateForumThreadDto {
  @IsOptional()
  @IsString()
  @MaxLength(THREAD_TITLE_MAX)
  title?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  categoryId?: number;
}

export class CreateForumPostDto {
  @IsString()
  @MaxLength(FORUM_POST_MAX)
  content: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  quoteId?: number;

  @IsOptional()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  linkUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(SPOILER_MAX)
  spoiler?: string | null;
}

export class UpdateForumPostDto {
  @IsString()
  @MaxLength(FORUM_POST_MAX)
  content: string;

  @IsOptional()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  linkUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(SPOILER_MAX)
  spoiler?: string | null;
}
