import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateUserDto } from '../../users/dto/create-user.dto';

export class SignupDto extends CreateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstileToken?: string;
}
