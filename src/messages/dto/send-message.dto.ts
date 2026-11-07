import { IsOptional, IsString, MaxLength } from 'class-validator';
import { IsId } from '../../common/validators';
import { MESSAGE_MAX_LENGTH } from '../conversation';

export class SendMessageDto {
  @IsString()
  @MaxLength(MESSAGE_MAX_LENGTH)
  text: string;

  @IsOptional()
  @IsId()
  replyToId?: number;
}
