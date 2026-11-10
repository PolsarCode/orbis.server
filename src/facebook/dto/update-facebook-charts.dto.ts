import { IsBoolean } from 'class-validator';

export class UpdateFacebookChartsDto {
  @IsBoolean()
  enabled: boolean;
}
