import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowUnconfirmed } from '../auth/confirmed-email.guard';
import { HOUR, RateLimit } from '../common/throttle';
import { UserId } from '../common/user-id';
import { AccountExportService } from './account-export.service';
import {
  AccountDeletionService,
  DeletionPreview,
} from './account-deletion.service';
import { ConfirmDeletionDto } from './dto/confirm-deletion.dto';

@Controller('users/me')
@UseGuards(JwtAuthGuard)
@AllowUnconfirmed()
export class AccountController {
  constructor(
    private readonly exports: AccountExportService,
    private readonly deletion: AccountDeletionService,
  ) {}

  @RateLimit(5, HOUR)
  @Get('export')
  async export(
    @UserId() userId: number,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.exports.export(userId);
    const date = data.exportedAt.slice(0, 10);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="orbis-${data.profile.username}-${date}.json"`,
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    return data;
  }

  @Get('deletion')
  deletionPreview(@UserId() userId: number): Promise<DeletionPreview> {
    return this.deletion.preview(userId);
  }

  @RateLimit(10, HOUR)
  @Post('deletion/code')
  @HttpCode(200)
  deletionCode(@UserId() userId: number) {
    return this.deletion.issueCode(userId);
  }

  @Post('deletion')
  @HttpCode(200)
  scheduleDeletion(
    @UserId() userId: number,
    @Body() { code }: ConfirmDeletionDto,
  ) {
    return this.deletion.schedule(userId, code);
  }
}
