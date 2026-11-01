import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const CATEGORY_NAME_MAX = 60;
export const CATEGORY_DESCRIPTION_MAX = 300;

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
