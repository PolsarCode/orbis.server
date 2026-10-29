import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MessagesService } from './messages.service';
import { GROUP_MAX_MEMBERS, MESSAGE_LIMIT } from './conversation';
import { PrismaService } from '../prisma.service';
import { PresenceGateway } from '../friends/presence.gateway';

const date = new Date('2026-10-24T12:00:00Z');
const user = (id: number, username: string) => ({
  id,
  username,
  name: null,
  avatarUrl: null,
});
const users = {
  1: user(1, 'admin'),
  2: user(2, 'naruto'),
  3: user(3, 'sasuke'),
  4: user(4, 'sakura'),
};
const member = (
  id: number,
  status: 'accepted' | 'request' = 'accepted',
  readAt: Date | null = null,
) => ({ userId: id, unread: 0, status, readAt, user: users[id] });

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    isGroup: false,
    name: null,
    creatorId: null,
    lastText: 'Hi',
    lastSenderId: 1,
    lastSystem: false,
    lastMessageAt: date,
    userA: users[1],
    userB: users[2],
    members: [member(1), member(2)],
    ...overrides,
  };
}

const group = (members = [member(1), member(2), member(3)]) =>
  conversation({
    isGroup: true,
    name: 'Team 7',
    creatorId: 1,
    userA: null,
    userB: null,
    members,
  });

describe('MessagesService', () => {
  const prisma = {
    user: {
      findMany: jest.fn(({ where: { id } }) =>
        id.in.map((key: number) => users[key]).filter(Boolean),
      ),
    },
    friendship: { findMany: jest.fn() },
    conversation: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    conversationMember: {
      findMany: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      createMany: jest.fn(),
      delete: jest.fn(),
    },
    message: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    messageReaction: {
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn((run) => run(prisma)),
  };
  const presence = { notify: jest.fn() };
  const service = new MessagesService(
    prisma as unknown as PrismaService,
    presence as unknown as PresenceGateway,
  );

  function friendsWith(...ids: number[]) {
    prisma.friendship.findMany.mockResolvedValue(
      ids.map((id) => ({ requesterId: 1, addresseeId: id })),
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    friendsWith();
    prisma.conversation.findUnique.mockResolvedValue(conversation());
    prisma.conversation.create.mockResolvedValue({ id: 5 });
    prisma.message.create.mockImplementation(({ data }) => ({
      id: 9,
      conversationId: data.conversationId,
      senderId: data.senderId,
      text: data.text,
      system: data.system,
      createdAt: date,
      sender: users[data.senderId],
      replyTo: null,
      reactions: [],
    }));
    prisma.message.findFirst.mockResolvedValue(null);
  });

  describe('direct chats', () => {
    it('sends a first message to a non-friend as a request', async () => {
      prisma.conversation.findUnique.mockResolvedValueOnce(
        conversation({ members: [member(1)] }),
      );
      const sent = await service.send(1, 5, '  Hi  ');

      expect(sent).toMatchObject({ senderId: 1, text: 'Hi', system: false });
      expect(prisma.conversationMember.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: {
            conversationId: 5,
            userId: 2,
            status: 'request',
            unread: 1,
          },
          update: { status: 'request', unread: { increment: 1 } },
        }),
      );
      expect(presence.notify).toHaveBeenCalledWith([2], 'message', {
        conversation: expect.objectContaining({
          id: 5,
          members: [expect.objectContaining({ userId: 1 })],
        }),
        message: sent,
      });
    });

    it('delivers straight to friends and accepted chats', async () => {
      friendsWith(2);
      await service.send(1, 5, 'Hi');
      expect(prisma.conversationMember.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          update: { status: 'accepted', unread: { increment: 1 } },
        }),
      );
    });

    it(`keeps only the newest ${MESSAGE_LIMIT} messages`, async () => {
      prisma.message.findFirst.mockResolvedValueOnce({ id: 40 });
      await service.send(1, 5, 'Hi');
      expect(prisma.message.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: MESSAGE_LIMIT,
          orderBy: { id: 'desc' },
        }),
      );
      expect(prisma.message.deleteMany).toHaveBeenCalledWith({
        where: { conversationId: 5, id: { lte: 40 } },
      });
    });

    it('rejects empty messages, non-members and unknown chats', async () => {
      await expect(service.send(1, 5, '   ')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.send(4, 5, 'Hi')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      prisma.conversation.findUnique.mockResolvedValueOnce(null);
      await expect(service.send(1, 6, 'Hi')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('opens a direct chat with someone else only', async () => {
      prisma.conversation.upsert.mockResolvedValue({ id: 5 });
      await expect(service.direct(1, 2)).resolves.toMatchObject({ id: 5 });
      await expect(service.direct(1, 1)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.direct(1, 99)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('groups', () => {
    beforeEach(() => {
      prisma.conversation.findUnique.mockResolvedValue(group());
    });

    it('creates a group with requests for people who aren’t the creator’s friends', async () => {
      friendsWith(2);
      await service.createGroup(1, [2, 3, 3, 1], ' Team 7 ');

      expect(prisma.conversation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            isGroup: true,
            name: 'Team 7',
            creatorId: 1,
            members: {
              create: [
                expect.objectContaining({ userId: 1 }),
                { userId: 2, status: 'accepted' },
                { userId: 3, status: 'request' },
              ],
            },
          }),
        }),
      );
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            text: 'created the group',
            system: true,
          }),
        }),
      );
    });

    it(`needs at least two others and at most ${GROUP_MAX_MEMBERS} people`, async () => {
      await expect(service.createGroup(1, [2])).rejects.toBeInstanceOf(
        BadRequestException,
      );
      const crowd = Array.from({ length: GROUP_MAX_MEMBERS }, (_, i) => i + 2);
      await expect(service.createGroup(1, crowd)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.conversation.create).not.toHaveBeenCalled();
    });

    it('counts a group message as unread for everyone else', async () => {
      await service.send(1, 5, 'Hey team');
      expect(prisma.conversationMember.updateMany).toHaveBeenCalledWith({
        where: { conversationId: 5, userId: { not: 1 } },
        data: { unread: { increment: 1 } },
      });
      expect(presence.notify).toHaveBeenCalledTimes(3);
    });

    it('lets accepted members rename and add people, up to the cap', async () => {
      await service.rename(1, 5, 'Squad');
      expect(prisma.message.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            text: 'named the group “Squad”',
            system: true,
          }),
        }),
      );

      await service.addMembers(1, 5, [4, 2]);
      expect(prisma.conversationMember.createMany).toHaveBeenCalledWith({
        data: [{ conversationId: 5, userId: 4, status: 'request' }],
      });

      prisma.conversation.findUnique.mockResolvedValue(
        group([member(1), member(2, 'request'), member(3)]),
      );
      await expect(service.rename(2, 5, 'Mine')).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      const full = Array.from({ length: GROUP_MAX_MEMBERS }, (_, i) => ({
        ...member(1),
        userId: i + 1,
      }));
      prisma.conversation.findUnique.mockResolvedValue(group(full));
      await expect(service.addMembers(1, 5, [99])).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('lets anyone leave but only the creator remove others', async () => {
      await service.removeMember(2, 5, 2);
      expect(prisma.message.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ text: 'left the group' }),
        }),
      );
      expect(presence.notify).toHaveBeenCalledWith(
        [2],
        'conversation:removed',
        {
          id: 5,
        },
      );

      await expect(service.removeMember(2, 5, 3)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await service.removeMember(1, 5, 3);
      expect(prisma.message.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ text: 'removed sasuke' }),
        }),
      );
    });

    it('relays typing and read receipts only to accepted members', async () => {
      prisma.conversation.findUnique.mockResolvedValue(
        group([member(1), member(2), member(3, 'request')]),
      );
      await service.typing(1, 5, true);
      expect(presence.notify).toHaveBeenCalledWith([2], 'typing', {
        conversationId: 5,
        userId: 1,
        typing: true,
      });

      await service.read(1, 5);
      expect(presence.notify).toHaveBeenCalledWith(
        [2],
        'messages:read',
        expect.objectContaining({ conversationId: 5, userId: 1 }),
      );
    });

    it('returns history oldest first with each member’s read time', async () => {
      prisma.conversation.findUnique.mockResolvedValue(
        group([member(1), member(2, 'accepted', date), member(3)]),
      );
      prisma.message.findMany.mockResolvedValue([
        {
          id: 3,
          senderId: 2,
          text: 'b',
          system: false,
          createdAt: date,
          sender: users[2],
          replyTo: null,
          reactions: [],
        },
        {
          id: 2,
          senderId: 1,
          text: 'a',
          system: false,
          createdAt: date,
          sender: users[1],
          replyTo: null,
          reactions: [],
        },
      ]);

      const history = await service.history(1, 5, 4);

      expect(history.messages.map(({ id }) => id)).toEqual([2, 3]);
      expect(history.members).toEqual([
        expect.objectContaining({ userId: 2, readAt: date.toISOString() }),
        expect.objectContaining({ userId: 3, readAt: null }),
      ]);
    });
  });

  it('accepts and declines only pending requests', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      conversation({ members: [member(1, 'request'), member(2)] }),
    );
    await service.accept(1, 5);
    expect(prisma.conversationMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'accepted' } }),
    );
    await service.decline(1, 5);
    expect(prisma.conversationMember.delete).toHaveBeenCalled();

    prisma.conversation.findUnique.mockResolvedValue(conversation());
    await expect(service.accept(1, 5)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('replies', () => {
    it('sends a reply to a message in the same chat', async () => {
      friendsWith(2);
      prisma.message.findFirst.mockResolvedValueOnce({ id: 3 });

      await service.send(1, 5, 'Same here', 3);

      expect(prisma.message.findFirst).toHaveBeenCalledWith({
        where: { id: 3, conversationId: 5, system: false },
        select: { id: true },
      });
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ replyToId: 3 }),
        }),
      );
    });

    it('refuses to reply to a message outside the chat', async () => {
      prisma.message.findFirst.mockResolvedValueOnce(null);

      await expect(service.send(1, 5, 'Hi', 99)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.message.create).not.toHaveBeenCalled();
    });
  });

  describe('reactions', () => {
    const reacted = (reactions: { userId: number; emoji: string }[]) => ({
      id: 3,
      senderId: 2,
      text: 'Ramen later?',
      system: false,
      createdAt: date,
      sender: users[2],
      replyTo: null,
      reactions,
    });

    it('adds a reaction and tells everyone in the chat', async () => {
      prisma.message.findFirst.mockResolvedValueOnce({ id: 3, reactions: [] });
      prisma.message.findUniqueOrThrow.mockResolvedValueOnce(
        reacted([
          { userId: 2, emoji: '❤️' },
          { userId: 1, emoji: '❤️' },
        ]),
      );

      const message = await service.react(1, 5, 3, '❤️');

      expect(prisma.messageReaction.upsert).toHaveBeenCalledWith({
        where: { messageId_userId: { messageId: 3, userId: 1 } },
        create: { messageId: 3, userId: 1, emoji: '❤️' },
        update: { emoji: '❤️', createdAt: expect.any(Date) },
      });
      expect(message.reactions).toEqual([{ emoji: '❤️', userIds: [2, 1] }]);
      expect(presence.notify).toHaveBeenCalledWith([1, 2], 'message:updated', {
        conversationId: 5,
        message,
      });
    });

    it('removes the reaction when the same emoji is picked again', async () => {
      prisma.message.findFirst.mockResolvedValueOnce({
        id: 3,
        reactions: [{ emoji: '👍' }],
      });
      prisma.message.findUniqueOrThrow.mockResolvedValueOnce(reacted([]));

      await service.react(1, 5, 3, '👍');

      expect(prisma.messageReaction.deleteMany).toHaveBeenCalledWith({
        where: { messageId: 3, userId: 1 },
      });
      expect(prisma.messageReaction.upsert).not.toHaveBeenCalled();
    });

    it('refuses reactions before the chat is accepted', async () => {
      prisma.conversation.findUnique.mockResolvedValueOnce(
        conversation({ members: [member(1, 'request'), member(2)] }),
      );

      await expect(service.react(1, 5, 3, '👍')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('refuses reactions on messages outside the chat', async () => {
      prisma.message.findFirst.mockResolvedValueOnce(null);

      await expect(service.react(1, 5, 99, '👍')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('editing', () => {
    const edited = (text: string) => ({
      id: 3,
      senderId: 1,
      text,
      system: false,
      editedAt: date,
      createdAt: date,
      sender: users[1],
      replyTo: null,
      reactions: [],
    });

    it('edits your own message and tells everyone in the chat', async () => {
      prisma.message.findFirst
        .mockResolvedValueOnce({ senderId: 1 })
        .mockResolvedValueOnce({ id: 8 });
      prisma.message.update.mockResolvedValueOnce(edited('Ramen at 7'));

      const message = await service.edit(1, 5, 3, '  Ramen at 7  ');

      expect(prisma.message.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 3 },
          data: { text: 'Ramen at 7', editedAt: expect.any(Date) },
        }),
      );
      expect(message).toMatchObject({
        text: 'Ramen at 7',
        editedAt: date.toISOString(),
      });
      expect(presence.notify).toHaveBeenCalledWith([1, 2], 'message:updated', {
        conversationId: 5,
        message,
      });
      expect(prisma.conversation.update).not.toHaveBeenCalled();
    });

    it('updates the chat preview when the latest message is edited', async () => {
      prisma.message.findFirst
        .mockResolvedValueOnce({ senderId: 1 })
        .mockResolvedValueOnce({ id: 3 });
      prisma.message.update.mockResolvedValueOnce(edited('Ramen at 8'));

      await service.edit(1, 5, 3, 'Ramen at 8');

      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { lastText: 'Ramen at 8' },
      });
    });

    it('refuses to edit someone else’s message', async () => {
      prisma.message.findFirst.mockResolvedValueOnce({ senderId: 2 });

      await expect(service.edit(1, 5, 3, 'Hi')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.message.update).not.toHaveBeenCalled();
    });

    it('refuses an empty edit', async () => {
      await expect(service.edit(1, 5, 3, '   ')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
