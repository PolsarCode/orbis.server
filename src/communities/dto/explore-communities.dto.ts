import { IsIn, IsOptional } from 'class-validator';

export const EXPLORE_SORTS = ['popular', 'newest'] as const;

export class ExploreCommunitiesDto {
  @IsOptional()
  @IsIn(EXPLORE_SORTS)
  sort?: (typeof EXPLORE_SORTS)[number];

  @IsOptional()
  @IsIn(['true', 'false'])
  hideJoined?: 'true' | 'false';
}
