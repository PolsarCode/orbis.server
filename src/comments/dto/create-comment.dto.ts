import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SPOILER_MAX } from '../../common/spoiler';
import { CommentableType } from '../../../prisma/generated/client';

export class CreateCommentDto {
  @IsIn(Object.values(CommentableType))
  type: CommentableType;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  id: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  parentId?: number;

  @IsString()
  @MaxLength(10000)
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
