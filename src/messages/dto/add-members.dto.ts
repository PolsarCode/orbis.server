import { ArrayMaxSize, ArrayMinSize, IsArray } from 'class-validator';
import { IsId } from '../../common/validators';
import { GROUP_MAX_MEMBERS } from '../conversation';

export class AddMembersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(GROUP_MAX_MEMBERS - 1)
  @IsId({ each: true })
  userIds: number[];
}
