import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { StorageModule } from '../storage/storage.module';
import { PresenceModule } from '../friends/presence.module';
import { CommunitiesModule } from '../communities/communities.module';
import { MessagesModule } from '../messages/messages.module';
import { ForumModule } from '../forum/forum.module';
import { PostsModule } from '../posts/posts.module';
import { LibraryModule } from '../library/library.module';
import { CommentsModule } from '../comments/comments.module';
import { LikesModule } from '../likes/likes.module';
import { AccountController } from './account.controller';
import { AccountDeletionService } from './account-deletion.service';
import { AccountExportService } from './account-export.service';
import { AccountSweepService } from './account-sweep.service';

@Module({
  imports: [
    StorageModule,
    PresenceModule,
    CommunitiesModule,
    MessagesModule,
    ForumModule,
    PostsModule,
    LibraryModule,
    CommentsModule,
    LikesModule,
  ],
  controllers: [AccountController],
  providers: [
    AccountDeletionService,
    AccountExportService,
    AccountSweepService,
    PrismaService,
  ],
})
export class AccountModule {}
