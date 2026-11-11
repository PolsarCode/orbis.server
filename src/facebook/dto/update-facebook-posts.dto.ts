import { IsBoolean, IsIn } from 'class-validator';
import { FACEBOOK_POST_KINDS, FacebookPostKind } from '../facebook-post-kinds';

export class UpdateFacebookPostsDto {
  @IsIn(FACEBOOK_POST_KINDS)
  kind: FacebookPostKind;

  @IsBoolean()
  enabled: boolean;
}
