import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

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

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(1_000_000_000)
  goal?: number;
}
