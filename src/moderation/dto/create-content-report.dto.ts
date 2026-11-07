import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsId } from '../../common/validators';
import {
  ContentReportReason,
  ContentReportTarget,
} from '../../../prisma/generated/client';

export class CreateContentReportDto {
  @IsIn(Object.values(ContentReportTarget))
  type: ContentReportTarget;

  @IsId()
  id: number;

  @IsIn(Object.values(ContentReportReason))
  reason: ContentReportReason;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  details?: string;
}
