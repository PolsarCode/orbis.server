import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
} from 'class-validator';
import {
  NotificationType,
  Theme,
  UserStatus,
} from '../../../prisma/generated/client';
import { MUTABLE_NOTIFICATIONS } from '../../notifications/notifications.service';

export class UpdatePreferencesDto {
  @IsOptional()
  @IsIn(Object.values(Theme))
  theme?: Theme;

  @IsOptional()
  @IsBoolean()
  appearOffline?: boolean;

  @IsOptional()
  @IsIn(Object.values(UserStatus))
  status?: UserStatus;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsBoolean()
  showNsfw?: boolean;

  @IsOptional()
  @IsBoolean()
  showChangelog?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MUTABLE_NOTIFICATIONS.length)
  @IsIn(MUTABLE_NOTIFICATIONS, { each: true })
  mutedNotifications?: NotificationType[];
}
