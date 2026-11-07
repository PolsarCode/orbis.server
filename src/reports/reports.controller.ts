import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';
import { SetWebhookDto } from './dto/set-webhook.dto';
import { AssignReportDto } from './dto/assign-report.dto';
import { CreateReportCommentDto } from './dto/create-report-comment.dto';
import { ReportsService } from './reports.service';
import { HOUR, MINUTE, RateLimit } from '../common/throttle';
import { UserId } from '../common/user-id';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @RateLimit(5, HOUR)
  @Post()
  create(@UserId() userId: number, @Body() createReportDto: CreateReportDto) {
    return this.reportsService.create(userId, createReportDto);
  }

  @Get('mine')
  mine(@UserId() userId: number) {
    return this.reportsService.mine(userId);
  }

  @Get()
  findAll(@UserId() userId: number, @Query('hidden') hidden?: string) {
    return this.reportsService.findAll(userId, hidden === 'true');
  }

  @Get('webhook')
  webhook(@UserId() userId: number) {
    return this.reportsService.webhook(userId);
  }

  @Put('webhook')
  setWebhook(@UserId() userId: number, @Body() { url }: SetWebhookDto) {
    return this.reportsService.setWebhook(userId, url);
  }

  @Delete('webhook')
  removeWebhook(@UserId() userId: number) {
    return this.reportsService.removeWebhook(userId);
  }

  @Get('admins')
  admins(@UserId() userId: number) {
    return this.reportsService.admins(userId);
  }

  @RateLimit(60, MINUTE)
  @Get('search')
  search(@UserId() userId: number, @Query('q') q = '') {
    return this.reportsService.search(userId, q);
  }

  @Get(':id')
  findOne(@UserId() userId: number, @Param('id', ParseIntPipe) id: number) {
    return this.reportsService.findOne(userId, id);
  }

  @Put(':id/assignee')
  assign(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() { assigneeId }: AssignReportDto,
  ) {
    return this.reportsService.assign(userId, id, assigneeId ?? null);
  }

  @Get(':id/comments')
  comments(@UserId() userId: number, @Param('id', ParseIntPipe) id: number) {
    return this.reportsService.comments(userId, id);
  }

  @RateLimit(20, MINUTE)
  @Post(':id/comments')
  addComment(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() { content }: CreateReportCommentDto,
  ) {
    return this.reportsService.addComment(userId, id, content);
  }

  @Put(':id/hidden')
  hide(@UserId() userId: number, @Param('id', ParseIntPipe) id: number) {
    return this.reportsService.hide(userId, id);
  }

  @Delete(':id/hidden')
  restore(@UserId() userId: number, @Param('id', ParseIntPipe) id: number) {
    return this.reportsService.restore(userId, id);
  }

  @Patch(':id')
  update(
    @UserId() userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() updateReportDto: UpdateReportDto,
  ) {
    return this.reportsService.update(userId, id, updateReportDto);
  }
}
