import { IsOptional } from 'class-validator';
import { IsId } from '../../common/validators';

export class AssignReportDto {
  @IsOptional()
  @IsId()
  assigneeId: number | null;
}
