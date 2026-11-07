import { AccountExportService } from './account-export.service';
import { AccountController } from './account.controller';
import { AccountDeletionService } from './account-deletion.service';
import { PrismaService } from '../prisma.service';
import { ADMINISTRATOR } from '../communities/permissions';

const date = new Date('2026-11-07T12:00:00Z');
const edits = { editedAt: null, editVersions: [] };

describe('Downloading your data', () => {
  const prisma = {
    user: { findUniqueOrThrow: jest.fn() },
    post: { findMany: jest.fn() },
    comment: { findMany: jest.fn() },
    forumThread: { findMany: jest.fn() },
    forumPost: { findMany: jest.fn() },
    message: { findMany: jest.fn() },
    libraryEntry: { findMany: jest.fn() },
    friendship: { findMany: jest.fn() },
    membership: { findMany: jest.fn() },
    conversation: { findMany: jest.fn() },
  };
  const service = new AccountExportService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: date, doNotFake: ['nextTick', 'setImmediate'] });
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      username: 'naruto',
      email: 'naruto@anime.test',
      name: 'Naruto',
      avatarUrl: null,
      coverUrl: null,
      backgroundUrl: null,
      emailVerifiedAt: date,
      twoFactorEnabledAt: date,
      createdAt: date,
      theme: 'dark',
      appearOffline: false,
      status: 'online',
      isPublic: true,
      showNsfw: false,
      showChangelog: true,
      oauthAccounts: [
        {
          provider: 'discord',
          username: 'naruto#1',
          showLive: true,
          showClips: true,
          createdAt: date,
        },
      ],
      steamAccount: null,
      keywordFilters: [],
    });
    prisma.post.findMany.mockResolvedValue([
      {
        id: 1,
        content: '<p>Believe it</p>',
        linkUrl: null,
        spoiler: null,
        createdAt: date,
        editedAt: date,
        editVersions: [
          { content: '<p>Belive it</p>', linkUrl: null, spoiler: null },
        ],
        community: null,
        wallUser: null,
      },
    ]);
    prisma.comment.findMany.mockResolvedValue([
      { id: 2, content: 'Ramen?', createdAt: date, ...edits },
    ]);
    prisma.forumThread.findMany.mockResolvedValue([]);
    prisma.forumPost.findMany.mockResolvedValue([]);
    prisma.message.findMany.mockResolvedValue([
      {
        id: 3,
        conversationId: 9,
        text: 'See you at Ichiraku',
        replyToId: null,
        editedAt: null,
        createdAt: date,
      },
      {
        id: 4,
        conversationId: 10,
        text: 'Team 7 forever',
        replyToId: null,
        editedAt: null,
        createdAt: date,
      },
      {
        id: 5,
        conversationId: 11,
        text: 'I’m out',
        replyToId: null,
        editedAt: null,
        createdAt: date,
      },
    ]);
    prisma.conversation.findMany.mockResolvedValue([
      {
        id: 9,
        isGroup: false,
        name: null,
        userA: { id: 7, username: 'naruto' },
        userB: { id: 8, username: 'sasuke' },
        members: [
          { userId: 7, user: { username: 'naruto' } },
          { userId: 8, user: { username: 'sasuke' } },
        ],
      },
      {
        id: 10,
        isGroup: true,
        name: 'Team 7',
        userA: null,
        userB: null,
        members: [
          { userId: 7, user: { username: 'naruto' } },
          { userId: 10, user: { username: 'sakura' } },
        ],
      },
      {
        id: 11,
        isGroup: true,
        name: 'Renamed after they left',
        userA: null,
        userB: null,
        members: [{ userId: 12, user: { username: 'joined_later' } }],
      },
    ]);
    prisma.libraryEntry.findMany.mockResolvedValue([]);
    prisma.friendship.findMany.mockResolvedValue([
      {
        requesterId: 7,
        status: 'accepted',
        createdAt: date,
        requester: { username: 'naruto', name: 'Naruto' },
        addressee: { username: 'sasuke', name: 'Sasuke' },
      },
      {
        requesterId: 10,
        status: 'pending',
        createdAt: date,
        requester: { username: 'sakura', name: null },
        addressee: { username: 'naruto', name: 'Naruto' },
      },
    ]);
    prisma.membership.findMany.mockResolvedValue([
      {
        nickname: 'Hokage',
        joinedAt: date,
        community: { id: 4, name: 'Hidden Leaf', ownerId: 7 },
        roles: [],
      },
      {
        nickname: null,
        joinedAt: date,
        community: { id: 5, name: 'Ramen Club', ownerId: 8 },
        roles: [{ role: { permissions: ADMINISTRATOR } }],
      },
    ]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('never asks for secrets or other people’s emails and messages', async () => {
    await service.export(7);

    const { select } = prisma.user.findUniqueOrThrow.mock.calls[0][0];
    for (const secret of [
      'password',
      'twoFactorSecret',
      'twoFactorCodes',
      'twoFactorLastStep',
      'deletionCode',
      'sessionsRevokedAt',
    ]) {
      expect(select).not.toHaveProperty(secret);
    }
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { senderId: 7, system: false } }),
    );
    const friendSelect = prisma.friendship.findMany.mock.calls[0][0].select;
    expect(friendSelect.requester).toEqual({
      select: { username: true, name: true },
    });
    expect(friendSelect.addressee).toEqual({
      select: { username: true, name: true },
    });
    expect(prisma.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { authorId: 7, deletedAt: null } }),
    );
  });

  it('includes their profile, content, messages, friends and communities', async () => {
    const data = await service.export(7);

    expect(Object.keys(data)).toEqual([
      'exportedAt',
      'profile',
      'posts',
      'comments',
      'forumThreads',
      'forumPosts',
      'messages',
      'library',
      'friends',
      'communities',
    ]);
    expect(data.exportedAt).toBe('2026-11-07T12:00:00.000Z');
    expect(data.profile).toMatchObject({
      username: 'naruto',
      email: 'naruto@anime.test',
      twoFactorEnabled: true,
      settings: { theme: 'dark', isPublic: true },
      linkedAccounts: [{ provider: 'discord', username: 'naruto#1' }],
    });
    expect(data.profile).not.toHaveProperty('twoFactorEnabledAt');
    expect(data.posts[0]).toMatchObject({
      content: '<p>Believe it</p>',
      earlierVersions: [{ content: '<p>Belive it</p>' }],
    });
    expect(data.posts[0]).not.toHaveProperty('editVersions');
    expect(data.messages).toEqual([
      expect.objectContaining({
        text: 'See you at Ichiraku',
        conversationId: 9,
        conversation: { isGroup: false, name: null, members: ['sasuke'] },
      }),
      expect.objectContaining({
        conversationId: 10,
        conversation: { isGroup: true, name: 'Team 7', members: ['sakura'] },
      }),
      expect.objectContaining({
        conversationId: 11,
        conversation: { isGroup: true, name: null, members: [], left: true },
      }),
    ]);
    expect(JSON.stringify(data)).not.toContain('joined_later');
    expect(data.friends).toEqual({
      friends: [{ username: 'sasuke', name: 'Sasuke', since: date }],
      requestsSent: [],
      requestsReceived: [{ username: 'sakura', name: null, receivedAt: date }],
    });
    expect(data.communities).toEqual([
      {
        id: 4,
        name: 'Hidden Leaf',
        role: 'owner',
        nickname: 'Hokage',
        joinedAt: date,
      },
      {
        id: 5,
        name: 'Ramen Club',
        role: 'admin',
        nickname: null,
        joinedAt: date,
      },
    ]);
  });

  it('downloads as a dated file named for the account', async () => {
    const controller = new AccountController(
      service,
      {} as AccountDeletionService,
    );
    const res = { setHeader: jest.fn() };

    await controller.export(7, res as never);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="orbis-naruto-2026-11-07.json"',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Access-Control-Expose-Headers',
      'Content-Disposition',
    );
  });

  it('works before the email is confirmed', () => {
    expect(Reflect.getMetadata('allowUnconfirmed', AccountController)).toBe(
      true,
    );
  });
});
