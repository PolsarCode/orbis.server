import { IsOptional } from 'class-validator';
import { IsId } from '../../common/validators';

export class RepostDto {
  @IsOptional()
  @IsId()
  communityId: number | null;
}
