import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { USERNAME_MESSAGE, USERNAME_PATTERN } from '../../users/username';

export class AddFriendDto {
  @ValidateIf((dto: AddFriendDto) => dto.username === undefined)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  userId?: number;

  @ValidateIf((dto: AddFriendDto) => dto.userId === undefined)
  @IsString()
  @Matches(USERNAME_PATTERN, { message: USERNAME_MESSAGE })
  username?: string;

  @IsOptional()
  @IsBoolean()
  fromSuggestion?: boolean;
}
