import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PresenceModule } from '../friends/presence.module';
import { MessagesController } from './messages.controller';
import { MessagesGateway } from './messages.gateway';
import { MessagesService } from './messages.service';

@Module({
  imports: [PresenceModule],
  controllers: [MessagesController],
  providers: [MessagesService, MessagesGateway, PrismaService],
  exports: [MessagesService],
})
export class MessagesModule {}
