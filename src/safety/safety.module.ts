import { Module } from '@nestjs/common';
import { SafetyController } from './safety.controller';
import { SafetyService } from './safety.service';
import { PresenceModule } from '../friends/presence.module';
import { PrismaService } from '../prisma.service';

@Module({
  imports: [PresenceModule],
  controllers: [SafetyController],
  providers: [SafetyService, PrismaService],
})
export class SafetyModule {}
