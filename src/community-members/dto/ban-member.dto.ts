import { IsOptional, IsString, MaxLength } from 'class-validator';

export class BanMemberDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
