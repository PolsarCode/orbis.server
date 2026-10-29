import { IsOptional, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MaxLength(320)
  identifier: string;

  @IsString()
  @MaxLength(200)
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstileToken?: string;
}
