import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';
import { IsId } from '../../common/validators';
import { USERNAME_MESSAGE, USERNAME_PATTERN } from '../../users/username';

export class AddFriendDto {
  @ValidateIf((dto: AddFriendDto) => dto.username === undefined)
  @IsId()
  userId?: number;

  @ValidateIf((dto: AddFriendDto) => dto.userId === undefined)
  @IsString()
  @Matches(USERNAME_PATTERN, { message: USERNAME_MESSAGE })
  username?: string;

  @IsOptional()
  @IsBoolean()
  fromSuggestion?: boolean;
}
