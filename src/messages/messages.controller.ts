import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowUnconfirmed } from '../auth/confirmed-email.guard';
import { MINUTE, RateLimit } from '../common/throttle';
import { AddMembersDto } from './dto/add-members.dto';
import { CreateGroupDto } from './dto/create-group.dto';
import { EditMessageDto } from './dto/edit-message.dto';
import { ReactMessageDto } from './dto/react-message.dto';
import { RenameGroupDto } from './dto/rename-group.dto';
import { SendMessageDto } from './dto/send-message.dto';
import {
  ChatHistory,
  ChatMessage,
  InboxEntry,
  MessagesService,
} from './messages.service';
import { UserId } from '../common/user-id';

@Controller('messages')
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get()
  inbox(@UserId() userId: number): Promise<InboxEntry[]> {
    return this.messagesService.inbox(userId);
  }

  @RateLimit(30, MINUTE)
  @Post('direct/:userId')
  direct(
    @UserId() userId: number,
    @Param('userId', ParseIntPipe) otherId: number,
  ): Promise<InboxEntry> {
    return this.messagesService.direct(userId, otherId);
  }

  @RateLimit(10, MINUTE)
  @Post('groups')
  createGroup(
    @UserId() userId: number,
    @Body() { userIds, name }: CreateGroupDto,
  ): Promise<InboxEntry> {
    return this.messagesService.createGroup(userId, userIds, name);
  }

  @Get(':id')
  history(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Query('before', new ParseIntPipe({ optional: true })) before?: number,
  ): Promise<ChatHistory> {
    return this.messagesService.history(userId, id, before);
  }

  @RateLimit(60, MINUTE)
  @Post(':id')
  send(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() { text, replyToId }: SendMessageDto,
  ): Promise<ChatMessage> {
    return this.messagesService.send(userId, id, text, replyToId);
  }

  @RateLimit(60, MINUTE)
  @Patch(':id/messages/:messageId')
  edit(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Param('messageId', ParseIntPipe) messageId: number,
    @Body() { text }: EditMessageDto,
  ): Promise<ChatMessage> {
    return this.messagesService.edit(userId, id, messageId, text);
  }

  @RateLimit(120, MINUTE)
  @Post(':id/messages/:messageId/reaction')
  react(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Param('messageId', ParseIntPipe) messageId: number,
    @Body() { emoji }: ReactMessageDto,
  ): Promise<ChatMessage> {
    return this.messagesService.react(userId, id, messageId, emoji);
  }

  @Post(':id/read')
  @HttpCode(204)
  read(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.messagesService.read(userId, id);
  }

  @Post(':id/accept')
  @HttpCode(204)
  accept(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.messagesService.accept(userId, id);
  }

  @RateLimit(60, MINUTE)
  @Post(':id/mute')
  @HttpCode(200)
  @AllowUnconfirmed()
  mute(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ muted: boolean }> {
    return this.messagesService.setMuted(userId, id, true);
  }

  @RateLimit(60, MINUTE)
  @Delete(':id/mute')
  @AllowUnconfirmed()
  unmute(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ muted: boolean }> {
    return this.messagesService.setMuted(userId, id, false);
  }

  @Delete(':id')
  @HttpCode(204)
  decline(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.messagesService.decline(userId, id);
  }

  @RateLimit(20, MINUTE)
  @Patch(':id')
  @HttpCode(204)
  rename(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() { name }: RenameGroupDto,
  ): Promise<void> {
    return this.messagesService.rename(userId, id, name);
  }

  @RateLimit(20, MINUTE)
  @Post(':id/members')
  @HttpCode(204)
  addMembers(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() { userIds }: AddMembersDto,
  ): Promise<void> {
    return this.messagesService.addMembers(userId, id, userIds);
  }

  @Delete(':id/members/:userId')
  @HttpCode(204)
  removeMember(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) targetId: number,
  ): Promise<void> {
    return this.messagesService.removeMember(userId, id, targetId);
  }
}
