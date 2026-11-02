import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ForumCategoriesService } from './forum-categories.service';
import { UpdateForumCategoryDto } from './dto/forum-category.dto';
import { PrismaService } from '../prisma.service';
import { isForumManager } from './forum-helpers';

jest.mock('./forum-helpers', () => ({
  ...jest.requireActual('./forum-helpers'),
  isForumManager: jest.fn(),
}));

function setup() {
  const prisma = {
    contentReport: { findMany: jest.fn(), deleteMany: jest.fn() },
    like: { deleteMany: jest.fn() },
    notification: { deleteMany: jest.fn() },
    forumCategory: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    forumThread: { findMany: jest.fn(), findFirst: jest.fn() },
    forumSection: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
  };
  const service = new ForumCategoriesService(
    prisma as unknown as PrismaService,
  );
  return { prisma, service };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isForumManager).mockResolvedValue(true);
});

describe('Forum categories', () => {
  it('lets only admins add categories', async () => {
    const { prisma, service } = setup();
    jest.mocked(isForumManager).mockResolvedValue(false);

    await expect(
      service.create(7, 3, { name: 'General' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.forumCategory.create).not.toHaveBeenCalled();
  });

  it('adds new categories at the end with a trimmed name', async () => {
    const { prisma, service } = setup();
    prisma.forumCategory.findFirst.mockResolvedValue({ position: 4 });
    prisma.forumCategory.create.mockResolvedValue({
      id: 8,
      name: 'Theories',
      description: '',
    });

    const category = await service.create(7, 3, {
      name: '  Theories ',
      description: ' Wild ideas ',
    });

    expect(prisma.forumCategory.create).toHaveBeenCalledWith({
      data: {
        communityId: 3,
        sectionId: null,
        name: 'Theories',
        description: 'Wild ideas',
        icon: null,
        color: null,
        adminOnly: false,
        position: 5,
      },
      select: {
        id: true,
        sectionId: true,
        name: true,
        description: true,
        icon: true,
        color: true,
        adminOnly: true,
      },
    });
    expect(category).toMatchObject({ threadCount: 0, latest: null });
  });

  it('needs a name and stops at 30 categories', async () => {
    const { prisma, service } = setup();

    await expect(service.create(7, 3, { name: '  ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    prisma.forumCategory.count.mockResolvedValue(30);
    await expect(
      service.create(7, 3, { name: 'One more' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.forumCategory.create).not.toHaveBeenCalled();
  });

  it('reorders only when every category is sent exactly once', async () => {
    const { prisma, service } = setup();
    prisma.forumCategory.findMany.mockResolvedValue([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);

    for (const ids of [
      [1, 2],
      [1, 2, 2],
      [1, 2, 9],
    ]) {
      await expect(service.reorder(7, 3, { ids })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();

    await service.reorder(7, 3, { ids: [3, 1, 2] });

    expect(prisma.forumCategory.update).toHaveBeenNthCalledWith(1, {
      where: { id: 3 },
      data: { position: 0 },
    });
    expect(prisma.forumCategory.update).toHaveBeenNthCalledWith(3, {
      where: { id: 2 },
      data: { position: 2 },
    });
  });

  it('deletes a category with its threads’ likes, reports and notifications', async () => {
    const { prisma, service } = setup();
    prisma.forumCategory.findFirst.mockResolvedValue({ id: 5 });
    prisma.forumThread.findMany.mockResolvedValue([
      { id: 9, posts: [{ id: 40 }, { id: 41 }] },
    ]);

    await service.remove(7, 3, 5);

    expect(prisma.forumCategory.delete).toHaveBeenCalledWith({
      where: { id: 5 },
    });
    expect(prisma.like.deleteMany).toHaveBeenCalledWith({
      where: { likeableType: 'forum_post', likeableId: { in: [40, 41] } },
    });
    expect(prisma.contentReport.deleteMany).toHaveBeenCalledWith({
      where: { targetType: 'forum_post', targetId: { in: [40, 41] } },
    });
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { link: '/communities/3/forum/threads/9' },
          { link: { startsWith: '/communities/3/forum/threads/9?' } },
        ],
      },
    });
  });
});

describe('Forum sections', () => {
  it('only puts categories in sections from the same community', async () => {
    const { prisma, service } = setup();
    prisma.forumSection.findFirst.mockResolvedValue(null);

    await expect(
      service.create(7, 3, { name: 'Episode discussion', sectionId: 4 }),
    ).rejects.toThrow('Section not found');
    expect(prisma.forumSection.findFirst).toHaveBeenCalledWith({
      where: { id: 4, communityId: 3 },
      select: { id: true },
    });
    expect(prisma.forumCategory.create).not.toHaveBeenCalled();
  });

  it('moves a category out of its section when given null', async () => {
    const { prisma, service } = setup();
    prisma.forumCategory.findFirst.mockResolvedValue({ id: 5 });

    await service.update(7, 3, 5, { sectionId: null });

    expect(prisma.forumSection.findFirst).not.toHaveBeenCalled();
    expect(prisma.forumCategory.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { sectionId: null } }),
    );
  });

  it('lets only admins add sections, up to 10', async () => {
    const { prisma, service } = setup();
    jest.mocked(isForumManager).mockResolvedValueOnce(false);

    await expect(
      service.createSection(7, 3, { name: 'Anime' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    prisma.forumSection.count.mockResolvedValue(10);
    await expect(
      service.createSection(7, 3, { name: 'Anime' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.forumSection.create).not.toHaveBeenCalled();
  });

  it('keeps a deleted section’s categories and threads', async () => {
    const { prisma, service } = setup();
    prisma.forumSection.findFirst.mockResolvedValue({ id: 4 });

    await service.removeSection(7, 3, 4);

    expect(prisma.forumSection.delete).toHaveBeenCalledWith({
      where: { id: 4 },
    });
    expect(prisma.forumCategory.delete).not.toHaveBeenCalled();
    expect(prisma.like.deleteMany).not.toHaveBeenCalled();
  });
});

describe('Admin-only posting', () => {
  it('lets admins make a category or section admin-only', async () => {
    const { prisma, service } = setup();
    prisma.forumCategory.findFirst.mockResolvedValue({ id: 5 });
    prisma.forumSection.findFirst.mockResolvedValue({ id: 4 });

    await service.update(7, 3, 5, { adminOnly: true });
    await service.updateSection(7, 3, 4, { adminOnly: true });

    expect(prisma.forumCategory.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { adminOnly: true } }),
    );
    expect(prisma.forumSection.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { adminOnly: true } }),
    );
  });

  it('saves a category’s icon and color, and goes back to the default with null', async () => {
    const { prisma, service } = setup();
    prisma.forumCategory.findFirst.mockResolvedValue({ id: 5 });

    await service.update(7, 3, 5, { icon: 'megaphone', color: '#5b8def' });
    await service.update(7, 3, 5, { icon: null, color: null });

    expect(prisma.forumCategory.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: { icon: 'megaphone', color: '#5b8def' },
      }),
    );
    expect(prisma.forumCategory.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: { icon: null, color: null } }),
    );
  });

  it('only accepts icon names like gamepad-2 and colors written as #rrggbb', async () => {
    const problems = async (body: object) =>
      (await validate(plainToInstance(UpdateForumCategoryDto, body))).map(
        ({ property }) => property,
      );

    await expect(
      problems({ icon: 'gamepad-2', color: '#5B8DEF' }),
    ).resolves.toEqual([]);
    await expect(problems({ icon: null, color: null })).resolves.toEqual([]);
    for (const icon of ['Rocket', 'rocket!', '-rocket', 'r'.repeat(51)]) {
      await expect(problems({ icon })).resolves.toEqual(['icon']);
    }
    await expect(problems({ color: 'blue' })).resolves.toEqual(['color']);
    await expect(problems({ color: '#5b8de' })).resolves.toEqual(['color']);
  });

  it('won’t let members change who can post', async () => {
    const { prisma, service } = setup();
    jest.mocked(isForumManager).mockResolvedValue(false);

    await expect(
      service.update(7, 3, 5, { adminOnly: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.forumCategory.update).not.toHaveBeenCalled();
  });
});
