import { IsLinkUrl } from '../../common/validators';

export class PreviewLinkDto {
  @IsLinkUrl()
  url: string;
}
