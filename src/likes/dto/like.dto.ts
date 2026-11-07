import { IsBoolean, IsIn } from 'class-validator';
import { IsId } from '../../common/validators';
import { LikeableType } from '../../../prisma/generated/client';

export class LikeDto {
  @IsIn(Object.values(LikeableType))
  type: LikeableType;

  @IsId()
  id: number;

  @IsBoolean()
  liked: boolean;
}
