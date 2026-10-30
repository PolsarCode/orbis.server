import { IsString, MaxLength } from 'class-validator';

export class TwoFactorCodeDto {
  @IsString()
  @MaxLength(32)
  code: string;
}

export class TwoFactorLoginDto extends TwoFactorCodeDto {
  @IsString()
  @MaxLength(2048)
  ticket: string;
}
