import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { PrismaService } from '../prisma.service';
import { PresenceGateway } from '../friends/presence.gateway';

const date = new Date('2026-11-07T12:00:00Z');
const sasuke = { id: 2, username: 'sasuke', name: null, avatarUrl: null };

const leftBehind = {
  id: 4,
  isGroup: false,
  name: null,
  creatorId: null,
  lastText: 'Still here',
  lastSenderId: 2,
  lastSystem: false,
  lastMessageAt: date,
  userA: null,
  userB: sasuke,
  members: [
    {
      userId: 2,
      unread: 0,
      status: 'accepted',
      readAt: null,
      mutedAt: null,
      user: sasuke,
    },
  ],
};

const deletedPerson = {
  userId: 0,
  username: '',
  name: null,
  avatarUrl: null,
  deleted: true,
};

describe('Removing a deleted account from chats', () => {
  const prisma = {
    conversation: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
    },
    conversationMember: {
      findMany: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    message: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      deleteMany: jest.fn(),
    },
    user: { findMany: jest.fn() },
    block: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn((run: (tx: unknown) => unknown) => run(prisma)),
  };
  const presence = { notify: jest.fn() };
  const service = new MessagesService(
    prisma as unknown as PrismaService,
    presence as unknown as PresenceGateway,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.block.findMany.mockResolvedValue([]);
    prisma.block.count.mockResolvedValue(0);
    prisma.message.findMany.mockResolvedValue([]);
    prisma.conversation.findUnique.mockResolvedValue({
      ...leftBehind,
      isGroup: true,
      userB: null,
    });
  });

  it('keeps a direct chat for the other person, with only their side left', async () => {
    prisma.conversation.findMany.mockResolvedValue([
      {
        id: 4,
        isGroup: false,
        creatorId: null,
        userAId: 1,
        userBId: 2,
        members: [{ userId: 2, unread: 1 }],
      },
    ]);
    prisma.message.findMany.mockResolvedValue([{ senderId: 1 }]);
    prisma.message.findFirst.mockResolvedValue({
      text: 'Still here',
      senderId: 2,
      system: false,
      createdAt: date,
    });

    await service.removeUser(1);

    expect(prisma.conversation.findMany.mock.calls[0][0].where).toEqual({
      OR: [
        { userAId: 1 },
        { userBId: 1 },
        { creatorId: 1 },
        { members: { some: { userId: 1 } } },
        { messages: { some: { senderId: 1 } } },
      ],
    });
    expect(prisma.conversationMember.update).toHaveBeenCalledWith({
      where: { conversationId_userId: { conversationId: 4, userId: 2 } },
      data: { unread: { decrement: 1 } },
    });
    expect(prisma.message.deleteMany).toHaveBeenCalledWith({
      where: { conversationId: 4, senderId: 1 },
    });
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: {
        userAId: null,
        lastText: 'Still here',
        lastSenderId: 2,
        lastSystem: false,
        lastMessageAt: date,
      },
    });
    expect(prisma.conversation.delete).not.toHaveBeenCalled();
  });

  it('tells the other person live that the chat is now with a deleted account', async () => {
    prisma.conversation.findMany.mockResolvedValue([
      {
        id: 4,
        isGroup: false,
        creatorId: null,
        userAId: 1,
        userBId: 2,
        members: [{ userId: 2, unread: 0 }],
      },
    ]);
    prisma.message.findFirst.mockResolvedValue({
      text: 'Still here',
      senderId: 2,
      system: false,
      createdAt: date,
    });
    prisma.conversation.findUnique.mockResolvedValue(leftBehind);

    await service.removeUser(1);

    expect(prisma.conversation.update.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.conversation.findUnique.mock.invocationCallOrder[0],
    );
    expect(presence.notify).toHaveBeenCalledTimes(1);
    expect(presence.notify).toHaveBeenCalledWith([2], 'conversation', {
      conversation: expect.objectContaining({
        id: 4,
        isGroup: false,
        members: [deletedPerson],
        canMessage: false,
      }),
    });
  });

  it('deletes a direct chat when only their messages were in it', async () => {
    prisma.conversation.findMany.mockResolvedValue([
      {
        id: 4,
        isGroup: false,
        creatorId: null,
        userAId: 1,
        userBId: 2,
        members: [{ userId: 2, unread: 0 }],
      },
    ]);
    prisma.message.findFirst.mockResolvedValue(null);

    await service.removeUser(1);

    expect(prisma.conversation.delete).toHaveBeenCalledWith({
      where: { id: 4 },
    });
    expect(presence.notify).toHaveBeenCalledWith([2], 'conversation:removed', {
      id: 4,
    });
  });

  it('passes a group they made to the longest-standing member and fixes what the others see', async () => {
    prisma.conversation.findMany.mockResolvedValue([
      {
        id: 5,
        isGroup: true,
        creatorId: 1,
        userAId: null,
        userBId: null,
        members: [
          { userId: 2, unread: 1 },
          { userId: 3, unread: 0 },
        ],
      },
    ]);
    prisma.message.findMany.mockResolvedValue([{ senderId: 1 }]);
    prisma.message.findFirst.mockResolvedValue({
      text: 'hi from sakura',
      senderId: 3,
      system: false,
      createdAt: date,
    });

    await service.removeUser(1);

    expect(prisma.conversation.findMany.mock.calls[0][0].select).toMatchObject({
      members: {
        where: { userId: { not: 1 } },
        orderBy: [{ status: 'asc' }, { joinedAt: 'asc' }, { userId: 'asc' }],
      },
    });
    expect(prisma.message.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationId: 5, system: false, senderId: { not: 2 } },
        orderBy: { id: 'desc' },
        take: 1,
      }),
    );
    expect(prisma.conversationMember.deleteMany).toHaveBeenCalledWith({
      where: { conversationId: 5, userId: 1 },
    });
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: {
        creatorId: 2,
        lastText: 'hi from sakura',
        lastSenderId: 3,
        lastSystem: false,
        lastMessageAt: date,
      },
    });
  });

  it('keeps a group with no messages left and deletes one with nobody else in it', async () => {
    prisma.conversation.findMany.mockResolvedValue([
      {
        id: 5,
        isGroup: true,
        creatorId: 2,
        userAId: null,
        userBId: null,
        members: [{ userId: 2, unread: 0 }],
      },
      {
        id: 6,
        isGroup: true,
        creatorId: 1,
        userAId: null,
        userBId: null,
        members: [],
      },
    ]);
    prisma.message.findFirst.mockResolvedValue(null);

    await service.removeUser(1);

    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { lastText: '', lastSenderId: null, lastSystem: false },
    });
    expect(prisma.conversation.delete).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.delete).toHaveBeenCalledWith({
      where: { id: 6 },
    });
  });

  it('shows the missing side as a deleted account nobody can message', async () => {
    prisma.conversationMember.findMany.mockResolvedValue([
      { conversation: leftBehind },
    ]);
    prisma.conversation.findUnique.mockResolvedValue(leftBehind);

    const [entry] = await service.inbox(2);
    const history = await service.history(2, 4);

    expect(entry).toMatchObject({
      id: 4,
      isGroup: false,
      members: [deletedPerson],
      canMessage: false,
    });
    expect(history).toMatchObject({
      members: [{ ...deletedPerson, readAt: null }],
      canMessage: false,
    });
    await expect(service.send(2, 4, 'Hello?')).rejects.toThrow(
      new ForbiddenException('You can’t message a deleted account'),
    );
  });

  it('won’t start a chat with, or add to a group, someone waiting to be deleted', async () => {
    prisma.user.findMany.mockResolvedValue([]);

    await expect(service.direct(2, 9)).rejects.toThrow(NotFoundException);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [9] }, deleteAt: null },
      }),
    );
  });
});
