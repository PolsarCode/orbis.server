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
import { CommentView, CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowGuest } from '../auth/allow-guest';
import { RateLimit, MINUTE } from '../common/throttle';
import { UserId } from '../common/user-id';

@Controller('comments')
@UseGuards(JwtAuthGuard)
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Get()
  @AllowGuest()
  findAll(
    @UserId() userId: number,
    @Query('type') type: string,
    @Query('id', ParseIntPipe) id: number,
  ): Promise<CommentView[]> {
    return this.commentsService.list(userId, type, id);
  }

  @RateLimit(20, MINUTE)
  @Post()
  create(
    @UserId() userId: number,
    @Body() createCommentDto: CreateCommentDto,
  ): Promise<CommentView> {
    return this.commentsService.create(userId, createCommentDto);
  }

  @RateLimit(30, MINUTE)
  @Patch(':commentId')
  update(
    @UserId() userId: number,
    @Param('commentId', ParseIntPipe) commentId: number,
    @Body() updateCommentDto: UpdateCommentDto,
  ): Promise<CommentView> {
    return this.commentsService.update(userId, commentId, updateCommentDto);
  }

  @RateLimit(30, MINUTE)
  @Delete(':commentId')
  @HttpCode(204)
  remove(
    @UserId() userId: number,
    @Param('commentId', ParseIntPipe) commentId: number,
  ): Promise<void> {
    return this.commentsService.remove(userId, commentId);
  }
}
