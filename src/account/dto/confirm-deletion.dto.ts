import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ConfirmDeletionDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  code?: string;
}
