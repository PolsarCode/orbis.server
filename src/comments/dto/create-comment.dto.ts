import { IsIn, IsOptional } from 'class-validator';
import { IsId } from '../../common/validators';
import { CommentableType } from '../../../prisma/generated/client';
import { UpdateCommentDto } from './update-comment.dto';

export class CreateCommentDto extends UpdateCommentDto {
  @IsIn(Object.values(CommentableType))
  type: CommentableType;

  @IsId()
  id: number;

  @IsOptional()
  @IsId()
  parentId?: number;
}
