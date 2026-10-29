import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { SUSPENSION_DAYS, type SuspensionDuration } from '../suspension';

export class SuspendUserDto {
  @IsIn([...Object.keys(SUSPENSION_DAYS), 'permanent'])
  duration: SuspensionDuration;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
