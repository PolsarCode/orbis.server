import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { USERNAME_MESSAGE, USERNAME_PATTERN } from '../../../users/username';

export class FinishOAuthSignupDto {
  @IsString()
  @MaxLength(2048)
  token: string;

  @IsString()
  @Matches(USERNAME_PATTERN, { message: USERNAME_MESSAGE })
  username: string;

  @IsOptional()
  @IsBoolean()
  useProviderAvatar?: boolean;
}
