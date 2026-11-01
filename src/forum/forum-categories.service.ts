import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { reportedBy } from '../moderation/visibility';
import {
  CreateForumCategoryDto,
  ForumSectionDto,
  ReorderForumCategoriesDto,
  UpdateForumCategoryDto,
  UpdateForumSectionDto,
} from './dto/forum-category.dto';
import { forumCleanup, isForumManager, visibleThreads } from './forum-helpers';

export const CATEGORY_LIMIT = 30;
export const SECTION_LIMIT = 10;

const categorySelect = {
  id: true,
  sectionId: true,
  name: true,
  description: true,
  adminOnly: true,
} as const;

const sectionSelect = { id: true, name: true, adminOnly: true } as const;

export type ForumCategoryItem = {
  id: number;
  sectionId: number | null;
  name: string;
  description: string;
  adminOnly: boolean;
  threadCount: number;
  latest: { id: number; title: string; lastPostAt: Date } | null;
};

export type ForumSectionItem = { id: number; name: string; adminOnly: boolean };

function cleanName(name: string, thing: 'category' | 'section') {
  const trimmed = name.trim();
  if (!trimmed) throw new BadRequestException(`Give the ${thing} a name`);
  return trimmed;
}

function sameIds(ids: number[], existing: { id: number }[]) {
  const known = new Set(existing.map(({ id }) => id));
  return (
    ids.length === known.size &&
    new Set(ids).size === ids.length &&
    ids.every((id) => known.has(id))
  );
}

@Injectable()
export class ForumCategoriesService {
  constructor(private prisma: PrismaService) {}

  private async requireManager(userId: number, communityId: number) {
    if (!(await isForumManager(this.prisma, userId, communityId))) {
      throw new ForbiddenException('Only admins can manage the forum');
    }
  }

  private async requireCategory(communityId: number, categoryId: number) {
    const category = await this.prisma.forumCategory.findFirst({
      where: { id: categoryId, communityId },
      select: { id: true },
    });
    if (!category) throw new NotFoundException('Category not found');
  }

  private async requireSection(communityId: number, sectionId: number) {
    const section = await this.prisma.forumSection.findFirst({
      where: { id: sectionId, communityId },
      select: { id: true },
    });
    if (!section) throw new NotFoundException('Section not found');
  }

  async list(
    viewerId: number,
    communityId: number,
  ): Promise<{
    sections: ForumSectionItem[];
    categories: ForumCategoryItem[];
  }> {
    const reported = await reportedBy(this.prisma, viewerId);
    const visible = visibleThreads(viewerId, reported.forum_post);
    const [sections, categories] = await Promise.all([
      this.prisma.forumSection.findMany({
        where: { communityId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: sectionSelect,
      }),
      this.prisma.forumCategory.findMany({
        where: { communityId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: {
          ...categorySelect,
          _count: { select: { threads: { where: visible } } },
        },
      }),
    ]);
    const latest = await Promise.all(
      categories.map(({ id }) =>
        this.prisma.forumThread.findFirst({
          where: { categoryId: id, ...visible },
          orderBy: [{ lastPostAt: 'desc' }, { id: 'desc' }],
          select: { id: true, title: true, lastPostAt: true },
        }),
      ),
    );

    return {
      sections,
      categories: categories.map(({ _count, ...category }, index) => ({
        ...category,
        threadCount: _count.threads,
        latest: latest[index],
      })),
    };
  }

  async create(
    userId: number,
    communityId: number,
    { name, description, sectionId, adminOnly }: CreateForumCategoryDto,
  ): Promise<ForumCategoryItem> {
    await this.requireManager(userId, communityId);
    if (sectionId) await this.requireSection(communityId, sectionId);
    const [count, last] = await Promise.all([
      this.prisma.forumCategory.count({ where: { communityId } }),
      this.prisma.forumCategory.findFirst({
        where: { communityId },
        orderBy: { position: 'desc' },
        select: { position: true },
      }),
    ]);
    if (count >= CATEGORY_LIMIT) {
      throw new ConflictException(
        `A forum can have up to ${CATEGORY_LIMIT} categories`,
      );
    }

    const category = await this.prisma.forumCategory.create({
      data: {
        communityId,
        sectionId: sectionId ?? null,
        name: cleanName(name, 'category'),
        description: description?.trim() ?? '',
        adminOnly: adminOnly ?? false,
        position: (last?.position ?? -1) + 1,
      },
      select: categorySelect,
    });
    return { ...category, threadCount: 0, latest: null };
  }

  async update(
    userId: number,
    communityId: number,
    categoryId: number,
    { name, description, sectionId, adminOnly }: UpdateForumCategoryDto,
  ) {
    await this.requireManager(userId, communityId);
    await this.requireCategory(communityId, categoryId);
    if (sectionId) await this.requireSection(communityId, sectionId);
    return this.prisma.forumCategory.update({
      where: { id: categoryId },
      data: {
        ...(name !== undefined && { name: cleanName(name, 'category') }),
        ...(description !== undefined && { description: description.trim() }),
        ...(sectionId !== undefined && { sectionId }),
        ...(adminOnly !== undefined && { adminOnly }),
      },
      select: categorySelect,
    });
  }

  async reorder(
    userId: number,
    communityId: number,
    { ids }: ReorderForumCategoriesDto,
  ) {
    await this.requireManager(userId, communityId);
    const existing = await this.prisma.forumCategory.findMany({
      where: { communityId },
      select: { id: true },
    });
    if (!sameIds(ids, existing)) {
      throw new BadRequestException('Send every category exactly once');
    }

    await this.prisma.$transaction(
      ids.map((id, position) =>
        this.prisma.forumCategory.update({
          where: { id },
          data: { position },
        }),
      ),
    );
  }

  async remove(userId: number, communityId: number, categoryId: number) {
    await this.requireManager(userId, communityId);
    await this.requireCategory(communityId, categoryId);
    const threads = await this.prisma.forumThread.findMany({
      where: { categoryId },
      select: { id: true, posts: { select: { id: true } } },
    });

    await this.prisma.$transaction([
      ...forumCleanup(
        this.prisma,
        communityId,
        threads.map(({ id }) => id),
        threads.flatMap(({ posts }) => posts.map(({ id }) => id)),
      ),
      this.prisma.forumCategory.delete({ where: { id: categoryId } }),
    ]);
  }

  async createSection(
    userId: number,
    communityId: number,
    { name, adminOnly }: ForumSectionDto,
  ): Promise<ForumSectionItem> {
    await this.requireManager(userId, communityId);
    const [count, last] = await Promise.all([
      this.prisma.forumSection.count({ where: { communityId } }),
      this.prisma.forumSection.findFirst({
        where: { communityId },
        orderBy: { position: 'desc' },
        select: { position: true },
      }),
    ]);
    if (count >= SECTION_LIMIT) {
      throw new ConflictException(
        `A forum can have up to ${SECTION_LIMIT} sections`,
      );
    }

    return this.prisma.forumSection.create({
      data: {
        communityId,
        name: cleanName(name, 'section'),
        adminOnly: adminOnly ?? false,
        position: (last?.position ?? -1) + 1,
      },
      select: sectionSelect,
    });
  }

  async updateSection(
    userId: number,
    communityId: number,
    sectionId: number,
    { name, adminOnly }: UpdateForumSectionDto,
  ): Promise<ForumSectionItem> {
    await this.requireManager(userId, communityId);
    await this.requireSection(communityId, sectionId);
    return this.prisma.forumSection.update({
      where: { id: sectionId },
      data: {
        ...(name !== undefined && { name: cleanName(name, 'section') }),
        ...(adminOnly !== undefined && { adminOnly }),
      },
      select: sectionSelect,
    });
  }

  async reorderSections(
    userId: number,
    communityId: number,
    { ids }: ReorderForumCategoriesDto,
  ) {
    await this.requireManager(userId, communityId);
    const existing = await this.prisma.forumSection.findMany({
      where: { communityId },
      select: { id: true },
    });
    if (!sameIds(ids, existing)) {
      throw new BadRequestException('Send every section exactly once');
    }

    await this.prisma.$transaction(
      ids.map((id, position) =>
        this.prisma.forumSection.update({
          where: { id },
          data: { position },
        }),
      ),
    );
  }

  async removeSection(userId: number, communityId: number, sectionId: number) {
    await this.requireManager(userId, communityId);
    await this.requireSection(communityId, sectionId);
    await this.prisma.forumSection.delete({ where: { id: sectionId } });
  }
}
