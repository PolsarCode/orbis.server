import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CommunityLinksDto } from './update-community.dto';

export class CreateCommunityDto {
  @IsString()
  @MaxLength(100)
  @Matches(/\S/, { message: 'name must not be blank' })
  name: string;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CommunityLinksDto)
  links?: CommunityLinksDto;
}
