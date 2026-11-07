import { IsIn } from 'class-validator';
import { IsId } from '../../common/validators';
import {
  ContentReportResolution,
  ContentReportTarget,
} from '../../../prisma/generated/client';

export class ResolveContentReportDto {
  @IsIn(Object.values(ContentReportTarget))
  type: ContentReportTarget;

  @IsId()
  id: number;

  @IsIn(Object.values(ContentReportResolution))
  resolution: ContentReportResolution;
}
