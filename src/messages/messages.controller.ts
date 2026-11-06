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
  Req,
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

@Controller('messages')
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get()
  inbox(@Req() req): Promise<InboxEntry[]> {
    return this.messagesService.inbox(req.user.userId);
  }

  @RateLimit(30, MINUTE)
  @Post('direct/:userId')
  direct(
    @Req() req,
    @Param('userId', ParseIntPipe) userId: number,
  ): Promise<InboxEntry> {
    return this.messagesService.direct(req.user.userId, userId);
  }

  @RateLimit(10, MINUTE)
  @Post('groups')
  createGroup(
    @Req() req,
    @Body() { userIds, name }: CreateGroupDto,
  ): Promise<InboxEntry> {
    return this.messagesService.createGroup(req.user.userId, userIds, name);
  }

  @Get(':id')
  history(
    @Req() req,
    @Param('id', ParseIntPipe) id: number,
    @Query('before', new ParseIntPipe({ optional: true })) before?: number,
  ): Promise<ChatHistory> {
    return this.messagesService.history(req.user.userId, id, before);
  }

  @RateLimit(60, MINUTE)
  @Post(':id')
  send(
    @Req() req,
    @Param('id', ParseIntPipe) id: number,
    @Body() { text, replyToId }: SendMessageDto,
  ): Promise<ChatMessage> {
    return this.messagesService.send(req.user.userId, id, text, replyToId);
  }

  @RateLimit(60, MINUTE)
  @Patch(':id/messages/:messageId')
  edit(
    @Req() req,
    @Param('id', ParseIntPipe) id: number,
    @Param('messageId', ParseIntPipe) messageId: number,
    @Body() { text }: EditMessageDto,
  ): Promise<ChatMessage> {
    return this.messagesService.edit(req.user.userId, id, messageId, text);
  }

  @RateLimit(120, MINUTE)
  @Post(':id/messages/:messageId/reaction')
  react(
    @Req() req,
    @Param('id', ParseIntPipe) id: number,
    @Param('messageId', ParseIntPipe) messageId: number,
    @Body() { emoji }: ReactMessageDto,
  ): Promise<ChatMessage> {
    return this.messagesService.react(req.user.userId, id, messageId, emoji);
  }

  @Post(':id/read')
  @HttpCode(204)
  read(@Req() req, @Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.messagesService.read(req.user.userId, id);
  }

  @Post(':id/accept')
  @HttpCode(204)
  accept(@Req() req, @Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.messagesService.accept(req.user.userId, id);
  }

  @RateLimit(60, MINUTE)
  @Post(':id/mute')
  @HttpCode(200)
  @AllowUnconfirmed()
  mute(
    @Req() req,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ muted: boolean }> {
    return this.messagesService.setMuted(req.user.userId, id, true);
  }

  @RateLimit(60, MINUTE)
  @Delete(':id/mute')
  @AllowUnconfirmed()
  unmute(
    @Req() req,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ muted: boolean }> {
    return this.messagesService.setMuted(req.user.userId, id, false);
  }

  @Delete(':id')
  @HttpCode(204)
  decline(@Req() req, @Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.messagesService.decline(req.user.userId, id);
  }

  @RateLimit(20, MINUTE)
  @Patch(':id')
  @HttpCode(204)
  rename(
    @Req() req,
    @Param('id', ParseIntPipe) id: number,
    @Body() { name }: RenameGroupDto,
  ): Promise<void> {
    return this.messagesService.rename(req.user.userId, id, name);
  }

  @RateLimit(20, MINUTE)
  @Post(':id/members')
  @HttpCode(204)
  addMembers(
    @Req() req,
    @Param('id', ParseIntPipe) id: number,
    @Body() { userIds }: AddMembersDto,
  ): Promise<void> {
    return this.messagesService.addMembers(req.user.userId, id, userIds);
  }

  @Delete(':id/members/:userId')
  @HttpCode(204)
  removeMember(
    @Req() req,
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
  ): Promise<void> {
    return this.messagesService.removeMember(req.user.userId, id, userId);
  }
}
