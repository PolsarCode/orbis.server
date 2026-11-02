import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const CATEGORY_NAME_MAX = 60;
export const CATEGORY_DESCRIPTION_MAX = 300;
export const CATEGORY_ICON_MAX = 50;
export const CATEGORY_ICON_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class CreateForumCategoryDto {
  @IsString()
  @MaxLength(CATEGORY_NAME_MAX)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(CATEGORY_DESCRIPTION_MAX)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
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

export class UpdateForumCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(CATEGORY_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CATEGORY_DESCRIPTION_MAX)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
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
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(2147483647, { each: true })
  ids: number[];
}
