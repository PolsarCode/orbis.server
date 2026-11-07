import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowUnconfirmed } from '../auth/confirmed-email.guard';
import { NotificationsService } from './notifications.service';
import { UserId } from '../common/user-id';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
@AllowUnconfirmed()
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  list(
    @UserId() userId: number,
    @Query('cursor', new ParseIntPipe({ optional: true })) cursor?: number,
    @Query('q') q?: string,
    @Query('filter') filter?: string,
    @Query('unread') unread?: string,
  ) {
    return this.notificationsService.list(userId, {
      cursor,
      q,
      filter,
      unread: unread === 'true',
    });
  }

  @Get('unread')
  unreadCount(@UserId() userId: number) {
    return this.notificationsService.unreadCount(userId);
  }

  @Post('read')
  @HttpCode(204)
  markAllRead(@UserId() userId: number): Promise<void> {
    return this.notificationsService.markAllRead(userId);
  }

  @Post(':id/read')
  @HttpCode(204)
  markRead(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.notificationsService.markRead(userId, id);
  }
}
