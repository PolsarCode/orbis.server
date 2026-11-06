import {
  ContentViewer,
  hiddenFor,
  ViewerContext,
  viewerContext,
  visibleTo,
} from './visibility';
import { PrismaService } from '../prisma.service';
import { compilePhrases } from '../safety/keywords';

describe('What a viewer has hidden', () => {
  const prisma = {
    contentReport: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ targetType: 'post', targetId: 30 }]),
    },
    block: {
      findMany: jest.fn().mockResolvedValue([
        { blockerId: 1, blockedId: 5 },
        { blockerId: 6, blockedId: 1 },
      ]),
    },
    mute: { findMany: jest.fn().mockResolvedValue([{ mutedId: 7 }]) },
    keywordFilter: {
      findMany: jest.fn().mockResolvedValue([{ phrase: 'frieren' }]),
    },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ isAdmin: true, email: 'admin@anime.test' }),
    },
    membership: {
      findMany: jest.fn().mockResolvedValue([
        { communityId: 3, community: { ownerId: 1 }, roles: [] },
        {
          communityId: 4,
          community: { ownerId: 9 },
          roles: [{ role: { permissions: BigInt(1) } }],
        },
        {
          communityId: 8,
          community: { ownerId: 9 },
          roles: [{ role: { permissions: BigInt(0) } }],
        },
      ]),
    },
  };

  it('loads reports, blocks both ways, mutes, unexpired filters and what the viewer moderates once', async () => {
    const viewer = await viewerContext(prisma as unknown as PrismaService, 1);

    expect(viewer).toEqual({
      id: 1,
      reported: { post: [30], comment: [], forum_post: [] },
      siteAdmin: true,
      manages: [3, 4],
      blocked: new Set([5, 6]),
      muted: new Set([7]),
      phrases: [{ phrase: 'frieren', pattern: expect.any(RegExp) }],
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { isAdmin: true, email: true },
    });
    expect(prisma.membership.findMany).toHaveBeenCalledWith({
      where: {
        userId: 1,
        OR: [{ community: { ownerId: 1 } }, { roles: { some: {} } }],
      },
      select: expect.any(Object),
    });
    expect(prisma.block.findMany).toHaveBeenCalledWith({
      where: { OR: [{ blockerId: 1 }, { blockedId: 1 }] },
      select: { blockerId: true, blockedId: true },
    });
    expect(prisma.mute.findMany).toHaveBeenCalledWith({
      where: { muterId: 1 },
      select: { mutedId: true },
    });
    expect(prisma.keywordFilter.findMany).toHaveBeenCalledWith({
      where: {
        userId: 1,
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
      select: { phrase: true },
    });
  });
});

describe('Why an item is collapsed', () => {
  const viewer: ViewerContext = {
    id: 1,
    reported: { post: [], comment: [], forum_post: [] },
    siteAdmin: false,
    manages: [],
    blocked: new Set(),
    muted: new Set([7]),
    phrases: compilePhrases(['frieren']),
  };

  it('never collapses the viewer’s own content', () => {
    expect(hiddenFor(viewer, 1, '<p>Frieren tonight</p>', [])).toBeNull();
  });

  it('collapses a muted person’s content before checking filters', () => {
    expect(hiddenFor(viewer, 7, '<p>Frieren tonight</p>', [])).toEqual({
      kind: 'muted',
    });
  });

  it('skips mutes where they don’t apply, but still filters', () => {
    expect(
      hiddenFor(viewer, 7, '<p>Frieren tonight</p>', [], { muted: false }),
    ).toEqual({ kind: 'filtered', phrase: 'frieren' });
    expect(
      hiddenFor(viewer, 7, '<p>Dungeon Meshi</p>', [], { muted: false }),
    ).toBeNull();
  });

  it('collapses content that mentions a filtered phrase in its text or spoiler note', () => {
    expect(hiddenFor(viewer, 3, '<p>Frieren tonight</p>', [])).toEqual({
      kind: 'filtered',
      phrase: 'frieren',
    });
    expect(
      hiddenFor(viewer, 3, '<p>Episode 12 thoughts</p>', ['Frieren finale']),
    ).toEqual({ kind: 'filtered', phrase: 'frieren' });
    expect(hiddenFor(viewer, 3, '<p>Dungeon Meshi</p>', [null])).toBeNull();
  });
});

describe('Whose content a viewer sees across a block', () => {
  const member: ContentViewer = {
    id: 1,
    reported: { post: [30], comment: [], forum_post: [] },
    siteAdmin: false,
    manages: [],
  };
  const blockClause = (viewer: ContentViewer) =>
    visibleTo(viewer, 'post').AND[2];
  const ownBlocks = { blocksReceived: { none: { blockerId: 1 } } };

  it('hides people blocked either way, but never the viewer’s own content', () => {
    expect(blockClause(member)).toEqual({
      OR: [
        {
          author: {
            blocksMade: { none: { blockedId: 1 } },
            blocksReceived: { none: { blockerId: 1 } },
          },
        },
        { authorId: 1 },
      ],
    });
    expect(visibleTo(member, 'post').AND).toContainEqual({
      id: { notIn: [30] },
    });
  });

  it('shows site admins content from people who blocked them, but keeps their own blocks', () => {
    expect(blockClause({ ...member, siteAdmin: true })).toEqual({
      OR: [{ author: ownBlocks }, { authorId: 1 }],
    });
  });

  it('shows community managers content from people who blocked them inside the communities they manage', () => {
    expect(blockClause({ ...member, manages: [3, 4] })).toEqual({
      OR: [
        {
          author: {
            blocksMade: { none: { blockedId: 1 } },
            blocksReceived: { none: { blockerId: 1 } },
          },
        },
        { authorId: 1 },
        { communityId: { in: [3, 4] }, author: ownBlocks },
      ],
    });
  });
});
