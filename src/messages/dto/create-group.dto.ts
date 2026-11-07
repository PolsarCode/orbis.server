import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsId } from '../../common/validators';
import { GROUP_MAX_MEMBERS, GROUP_NAME_MAX_LENGTH } from '../conversation';

export class CreateGroupDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(GROUP_MAX_MEMBERS - 1)
  @IsId({ each: true })
  userIds: number[];

  @IsOptional()
  @IsString()
  @MaxLength(GROUP_NAME_MAX_LENGTH)
  name?: string;
}
