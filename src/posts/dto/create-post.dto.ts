import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { SPOILER_MAX } from '../../common/spoiler';

export class CreatePostDto {
  @IsString()
  @MaxLength(20000)
  content: string;

  @IsOptional()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  linkUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(SPOILER_MAX)
  spoiler?: string | null;
}
