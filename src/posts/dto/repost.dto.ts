import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class RepostDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  communityId: number | null;
}
