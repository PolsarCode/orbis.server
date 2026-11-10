import { IsBoolean } from 'class-validator';

export class UpdateFacebookPostingDto {
  @IsBoolean()
  enabled: boolean;
}
