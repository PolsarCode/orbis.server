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
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AllowGuest } from '../auth/allow-guest';
import { CommunityMemberGuard } from '../communities/community-member.guard';
import { CommunityViewerGuard } from '../communities/community-viewer.guard';
import { RateLimit, MINUTE } from '../common/throttle';
import { ForumService } from './forum.service';
import { ForumCategoriesService } from './forum-categories.service';
import {
  CreateForumCategoryDto,
  ForumSectionDto,
  ReorderForumCategoriesDto,
  UpdateForumSectionDto,
  UpdateForumCategoryDto,
} from './dto/forum-category.dto';
import {
  CreateForumPostDto,
  CreateForumThreadDto,
  UpdateForumPostDto,
  UpdateForumThreadDto,
} from './dto/forum-thread.dto';

const optionalInt = new ParseIntPipe({ optional: true });

@Controller('communities/:communityId/forum')
@UseGuards(JwtAuthGuard)
export class ForumController {
  constructor(
    private readonly forum: ForumService,
    private readonly categories: ForumCategoriesService,
  ) {}

  @Get()
  @AllowGuest()
  @UseGuards(CommunityViewerGuard)
  index(@Req() req, @Param('communityId', ParseIntPipe) communityId: number) {
    return this.categories.list(req.user.userId, communityId);
  }

  @RateLimit(30, MINUTE)
  @Post('sections')
  @UseGuards(CommunityMemberGuard)
  createSection(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Body() body: ForumSectionDto,
  ) {
    return this.categories.createSection(req.user.userId, communityId, body);
  }

  @RateLimit(30, MINUTE)
  @Put('sections/order')
  @HttpCode(204)
  @UseGuards(CommunityMemberGuard)
  reorderSections(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Body() body: ReorderForumCategoriesDto,
  ) {
    return this.categories.reorderSections(req.user.userId, communityId, body);
  }

  @RateLimit(30, MINUTE)
  @Patch('sections/:sectionId')
  @UseGuards(CommunityMemberGuard)
  updateSection(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('sectionId', ParseIntPipe) sectionId: number,
    @Body() body: UpdateForumSectionDto,
  ) {
    return this.categories.updateSection(
      req.user.userId,
      communityId,
      sectionId,
      body,
    );
  }

  @RateLimit(30, MINUTE)
  @Delete('sections/:sectionId')
  @HttpCode(204)
  @UseGuards(CommunityMemberGuard)
  removeSection(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('sectionId', ParseIntPipe) sectionId: number,
  ) {
    return this.categories.removeSection(
      req.user.userId,
      communityId,
      sectionId,
    );
  }

  @RateLimit(30, MINUTE)
  @Post('categories')
  @UseGuards(CommunityMemberGuard)
  createCategory(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Body() body: CreateForumCategoryDto,
  ) {
    return this.categories.create(req.user.userId, communityId, body);
  }

  @RateLimit(30, MINUTE)
  @Put('categories/order')
  @HttpCode(204)
  @UseGuards(CommunityMemberGuard)
  reorderCategories(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Body() body: ReorderForumCategoriesDto,
  ) {
    return this.categories.reorder(req.user.userId, communityId, body);
  }

  @RateLimit(30, MINUTE)
  @Patch('categories/:categoryId')
  @UseGuards(CommunityMemberGuard)
  updateCategory(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
    @Body() body: UpdateForumCategoryDto,
  ) {
    return this.categories.update(
      req.user.userId,
      communityId,
      categoryId,
      body,
    );
  }

  @RateLimit(30, MINUTE)
  @Delete('categories/:categoryId')
  @HttpCode(204)
  @UseGuards(CommunityMemberGuard)
  removeCategory(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
  ) {
    return this.categories.remove(req.user.userId, communityId, categoryId);
  }

  @Get('categories/:categoryId/threads')
  @AllowGuest()
  @UseGuards(CommunityViewerGuard)
  listThreads(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
    @Query('page', optionalInt) page?: number,
  ) {
    return this.forum.threads(req.user.userId, communityId, categoryId, page);
  }

  @RateLimit(10, MINUTE)
  @Post('categories/:categoryId/threads')
  @UseGuards(CommunityMemberGuard)
  createThread(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
    @Body() body: CreateForumThreadDto,
  ) {
    return this.forum.createThread(
      req.user.userId,
      communityId,
      categoryId,
      body,
    );
  }

  @RateLimit(60, MINUTE)
  @Get('search')
  @AllowGuest()
  @UseGuards(CommunityViewerGuard)
  search(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Query('q') q = '',
  ) {
    return this.forum.search(req.user.userId, communityId, q);
  }

  @Get('threads/:threadId')
  @AllowGuest()
  @UseGuards(CommunityViewerGuard)
  thread(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('threadId', ParseIntPipe) threadId: number,
    @Query('page', optionalInt) page?: number,
    @Query('post', optionalInt) post?: number,
  ) {
    return this.forum.thread(
      req.user.userId,
      communityId,
      threadId,
      page,
      post,
    );
  }

  @RateLimit(30, MINUTE)
  @Patch('threads/:threadId')
  @UseGuards(CommunityMemberGuard)
  updateThread(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('threadId', ParseIntPipe) threadId: number,
    @Body() body: UpdateForumThreadDto,
  ) {
    return this.forum.updateThread(
      req.user.userId,
      communityId,
      threadId,
      body,
    );
  }

  @RateLimit(30, MINUTE)
  @Put('threads/:threadId/pin')
  @HttpCode(204)
  @UseGuards(CommunityMemberGuard)
  pin(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('threadId', ParseIntPipe) threadId: number,
  ) {
    return this.forum.setFlag(
      req.user.userId,
      communityId,
      threadId,
      'pinnedAt',
      true,
    );
  }

  @RateLimit(30, MINUTE)
  @Delete('threads/:threadId/pin')
  @HttpCode(204)
  @UseGuards(CommunityMemberGuard)
  unpin(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('threadId', ParseIntPipe) threadId: number,
  ) {
    return this.forum.setFlag(
      req.user.userId,
      communityId,
      threadId,
      'pinnedAt',
      false,
    );
  }

  @RateLimit(30, MINUTE)
  @Put('threads/:threadId/lock')
  @HttpCode(204)
  @UseGuards(CommunityMemberGuard)
  lock(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('threadId', ParseIntPipe) threadId: number,
  ) {
    return this.forum.setFlag(
      req.user.userId,
      communityId,
      threadId,
      'lockedAt',
      true,
    );
  }

  @RateLimit(30, MINUTE)
  @Delete('threads/:threadId/lock')
  @HttpCode(204)
  @UseGuards(CommunityMemberGuard)
  unlock(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('threadId', ParseIntPipe) threadId: number,
  ) {
    return this.forum.setFlag(
      req.user.userId,
      communityId,
      threadId,
      'lockedAt',
      false,
    );
  }

  @RateLimit(30, MINUTE)
  @Delete('threads/:threadId')
  @HttpCode(204)
  @UseGuards(CommunityMemberGuard)
  removeThread(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('threadId', ParseIntPipe) threadId: number,
  ) {
    return this.forum.removeThread(req.user.userId, communityId, threadId);
  }

  @RateLimit(20, MINUTE)
  @Post('threads/:threadId/posts')
  @UseGuards(CommunityMemberGuard)
  reply(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('threadId', ParseIntPipe) threadId: number,
    @Body() body: CreateForumPostDto,
  ) {
    return this.forum.reply(req.user.userId, communityId, threadId, body);
  }

  @RateLimit(30, MINUTE)
  @Patch('posts/:postId')
  @UseGuards(CommunityMemberGuard)
  updatePost(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('postId', ParseIntPipe) postId: number,
    @Body() body: UpdateForumPostDto,
  ) {
    return this.forum.updatePost(req.user.userId, communityId, postId, body);
  }

  @RateLimit(30, MINUTE)
  @Delete('posts/:postId')
  @HttpCode(204)
  @UseGuards(CommunityMemberGuard)
  removePost(
    @Req() req,
    @Param('communityId', ParseIntPipe) communityId: number,
    @Param('postId', ParseIntPipe) postId: number,
  ) {
    return this.forum.removePost(req.user.userId, communityId, postId);
  }
}
