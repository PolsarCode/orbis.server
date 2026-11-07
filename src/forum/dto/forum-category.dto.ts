import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { IsId } from '../../common/validators';

export const CATEGORY_NAME_MAX = 60;
export const CATEGORY_DESCRIPTION_MAX = 300;
export const CATEGORY_ICON_MAX = 50;
export const CATEGORY_ICON_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

class ForumCategoryFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(CATEGORY_DESCRIPTION_MAX)
  description?: string;

  @IsOptional()
  @IsId()
  sectionId?: number | null;

  @IsOptional()
  @IsBoolean()
  adminOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  postToFeed?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(CATEGORY_ICON_MAX)
  @Matches(CATEGORY_ICON_NAME)
  icon?: string | null;

  @IsOptional()
  @Matches(/^#[0-9a-f]{6}$/i)
  color?: string | null;
}

export class CreateForumCategoryDto extends ForumCategoryFieldsDto {
  @IsString()
  @MaxLength(CATEGORY_NAME_MAX)
  name: string;
}

export class UpdateForumCategoryDto extends ForumCategoryFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(CATEGORY_NAME_MAX)
  name?: string;
}

export class ForumSectionDto {
  @IsString()
  @MaxLength(CATEGORY_NAME_MAX)
  name: string;

  @IsOptional()
  @IsBoolean()
  adminOnly?: boolean;
}

export class UpdateForumSectionDto {
  @IsOptional()
  @IsString()
  @MaxLength(CATEGORY_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsBoolean()
  adminOnly?: boolean;
}

export class ReorderForumCategoriesDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsId({ each: true })
  ids: number[];
}
