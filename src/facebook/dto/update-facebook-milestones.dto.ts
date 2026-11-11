import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateFacebookMilestonesDto {
  @IsOptional()
  @IsBoolean()
  members?: boolean;

  @IsOptional()
  @IsBoolean()
  communities?: boolean;

  @IsOptional()
  @IsBoolean()
  followers?: boolean;
}
