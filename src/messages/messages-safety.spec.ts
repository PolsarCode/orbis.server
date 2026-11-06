import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MessagesService } from './messages.service';
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
const member = (id: number, mutedAt: Date | null = null) => ({
  userId: id,
  unread: 0,
  status: 'accepted' as const,
  readAt: null,
  mutedAt,
  user: users[id],
});

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

const message = (
  id: number,
  senderId: number,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  senderId,
  text: `Message ${id}`,
  system: false,
  editedAt: null,
  createdAt: date,
  sender: users[senderId],
  replyTo: null,
  reactions: [],
  ...overrides,
});

type Clause = Partial<
  Record<'blockerId' | 'blockedId', number | { in: number[] }>
>;

describe('MessagesService across blocks and mutes', () => {
  const prisma = {
    block: { count: jest.fn(), findMany: jest.fn() },
    user: {
      findMany: jest.fn(({ where: { id } }) =>
        id.in.map((key: number) => users[key]).filter(Boolean),
      ),
    },
    friendship: { findMany: jest.fn().mockResolvedValue([]) },
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
    },
    message: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    messageReaction: { upsert: jest.fn(), deleteMany: jest.fn() },
    $transaction: jest.fn((run) => run(prisma)),
  };
  const presence = { notify: jest.fn() };
  const service = new MessagesService(
    prisma as unknown as PrismaService,
    presence as unknown as PresenceGateway,
  );

  function blocks(...pairs: [number, number][]) {
    const rows = pairs.map(([blockerId, blockedId]) => ({
      blockerId,
      blockedId,
    }));
    const matching = ({ where }: { where: Clause & { OR?: Clause[] } }) =>
      rows.filter((row) =>
        (where.OR ?? [where]).some((clause) =>
          (['blockerId', 'blockedId'] as const).every((key) => {
            const value = clause[key];
            if (value === undefined) return true;
            return typeof value === 'number'
              ? row[key] === value
              : value.in.includes(row[key]);
          }),
        ),
      );
    prisma.block.findMany.mockImplementation(matching);
    prisma.block.count.mockImplementation((args) => matching(args).length);
  }

  function sentTo(userId: number) {
    return presence.notify.mock.calls.find(
      ([ids, event]) => event === 'message' && ids[0] === userId,
    )?.[2];
  }

  beforeEach(() => {
    jest.clearAllMocks();
    blocks();
    prisma.conversation.findUnique.mockResolvedValue(conversation());
    prisma.message.create.mockImplementation(({ data }) => ({
      ...message(9, data.senderId, { text: data.text, system: data.system }),
      conversationId: data.conversationId,
    }));
    prisma.message.findFirst.mockResolvedValue(null);
  });

  describe('direct messages', () => {
    it.each([
      ['you blocked them', [1, 2]],
      ['they blocked you', [2, 1]],
    ] as [string, [number, number]][])(
      'won’t start a chat when %s',
      async (_case, pair) => {
        blocks(pair);

        await expect(service.direct(1, 2)).rejects.toThrow(
          new ForbiddenException('You can’t message this person'),
        );
        expect(prisma.conversation.upsert).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['you blocked them', [1, 2]],
      ['they blocked you', [2, 1]],
    ] as [string, [number, number]][])(
      'won’t send in an existing chat when %s',
      async (_case, pair) => {
        blocks(pair);

        await expect(service.send(1, 5, 'Hi')).rejects.toThrow(
          new ForbiddenException('You can’t message this person'),
        );
        expect(prisma.message.create).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['you blocked them', [1, 2]],
      ['they blocked you', [2, 1]],
    ] as [string, [number, number]][])(
      'won’t edit a message in an existing chat when %s',
      async (_case, pair) => {
        blocks(pair);
        prisma.message.findFirst.mockResolvedValue({ senderId: 1 });

        await expect(service.edit(1, 5, 9, 'Edited')).rejects.toThrow(
          new ForbiddenException('You can’t message this person'),
        );
        expect(prisma.message.update).not.toHaveBeenCalled();
        expect(presence.notify).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['you blocked them', [1, 2]],
      ['they blocked you', [2, 1]],
    ] as [string, [number, number]][])(
      'won’t react in an existing chat when %s',
      async (_case, pair) => {
        blocks(pair);
        prisma.message.findFirst.mockResolvedValue({ id: 9, reactions: [] });

        await expect(service.react(1, 5, 9, '👍')).rejects.toThrow(
          new ForbiddenException('You can’t message this person'),
        );
        expect(prisma.messageReaction.upsert).not.toHaveBeenCalled();
        expect(prisma.messageReaction.deleteMany).not.toHaveBeenCalled();
      },
    );

    it('keeps the chat preview text in a one-to-one chat across a block', async () => {
      blocks([1, 2]);
      prisma.conversationMember.findMany.mockResolvedValue([
        { conversation: conversation({ lastSenderId: 2 }) },
      ]);

      const [direct] = await service.inbox(1);

      expect(direct.lastText).toBe('Hi');
    });

    it('keeps the chat in the list but says you can’t message them', async () => {
      blocks([2, 1]);
      prisma.conversationMember.findMany.mockResolvedValue([
        { conversation: conversation() },
        {
          conversation: group([member(1, date), member(2), member(3)]),
        },
      ]);

      const [direct, team] = await service.inbox(1);

      expect(direct).toMatchObject({ id: 5, canMessage: false, muted: false });
      expect(team).toMatchObject({ canMessage: true, muted: true });
    });

    it('never collapses messages in a one-to-one chat', async () => {
      blocks([1, 2]);
      prisma.message.findMany.mockResolvedValue([message(2, 2), message(1, 1)]);

      const history = await service.history(1, 5);

      expect(history.canMessage).toBe(false);
      expect(history.messages.map((item) => item.hiddenBecause)).toEqual([
        null,
        null,
      ]);
    });
  });

  describe('groups', () => {
    it('won’t make a group with someone across a block', async () => {
      blocks([3, 1]);

      await expect(service.createGroup(1, [2, 3])).rejects.toThrow(
        new ForbiddenException('You can’t add this person'),
      );
      expect(prisma.conversation.create).not.toHaveBeenCalled();
    });

    it('won’t add someone across a block', async () => {
      prisma.conversation.findUnique.mockResolvedValue(group());
      blocks([1, 4]);

      await expect(service.addMembers(1, 5, [4])).rejects.toThrow(
        new ForbiddenException('You can’t add this person'),
      );
      expect(prisma.conversationMember.createMany).not.toHaveBeenCalled();
    });

    it('collapses messages from someone blocked either way, but not system ones', async () => {
      prisma.conversation.findUnique.mockResolvedValue(
        group([member(1), member(2), member(3), member(4)]),
      );
      blocks([1, 2], [4, 1]);
      prisma.message.findMany.mockResolvedValue([
        message(6, 4),
        message(5, 3),
        message(4, 2, { system: true, text: 'renamed the group' }),
        message(3, 2),
        message(2, 1),
      ]);

      const history = await service.history(1, 5);

      expect(
        history.messages.map(({ id, hiddenBecause }) => [id, hiddenBecause]),
      ).toEqual([
        [2, null],
        [3, { kind: 'blocked' }],
        [4, null],
        [5, null],
        [6, { kind: 'blocked' }],
      ]);
      expect(history.canMessage).toBe(true);
    });

    it('sends the collapsed copy only to people blocked with the sender', async () => {
      prisma.conversation.findUnique.mockResolvedValue(group());
      blocks([3, 1]);

      const sent = await service.send(1, 5, 'Hi team');

      expect(sent.hiddenBecause).toBeNull();
      expect(sentTo(1).message.hiddenBecause).toBeNull();
      expect(sentTo(2).message.hiddenBecause).toBeNull();
      expect(sentTo(3).message.hiddenBecause).toEqual({ kind: 'blocked' });
      expect(sentTo(3).message.text).toBe('Hi team');
    });

    it('masks the preview of a group whose last message is from someone blocked either way', async () => {
      blocks([1, 2], [4, 1]);
      prisma.conversationMember.findMany.mockResolvedValue([
        { conversation: conversation({ ...group(), lastSenderId: 2 }) },
        {
          conversation: conversation({
            ...group([member(1), member(4)]),
            lastSenderId: 4,
          }),
        },
        {
          conversation: conversation({
            ...group(),
            lastSenderId: 2,
            lastSystem: true,
            lastText: 'renamed the group',
          }),
        },
        { conversation: conversation({ ...group(), lastSenderId: 3 }) },
        { conversation: conversation({ ...group(), lastSenderId: 1 }) },
      ]);

      const entries = await service.inbox(1);

      expect(entries.map(({ lastText }) => lastText)).toEqual([
        'Message from someone you blocked',
        'Message from someone you blocked',
        'renamed the group',
        'Hi',
        'Hi',
      ]);
    });

    it('masks the chat preview only for people blocked with the sender', async () => {
      prisma.conversation.findUnique.mockResolvedValue(
        conversation({ ...group(), lastSenderId: 1, lastText: 'Hi team' }),
      );
      blocks([3, 1]);

      await service.send(1, 5, 'Hi team');

      expect(sentTo(1).conversation.lastText).toBe('Hi team');
      expect(sentTo(2).conversation.lastText).toBe('Hi team');
      expect(sentTo(3).conversation.lastText).toBe(
        'Message from someone you blocked',
      );
    });

    it('masks the conversation update after editing the latest message', async () => {
      prisma.conversation.findUnique.mockResolvedValue(
        conversation({ ...group(), lastSenderId: 1, lastText: 'Edited' }),
      );
      blocks([2, 1]);
      prisma.message.findFirst
        .mockResolvedValueOnce({ senderId: 1 })
        .mockResolvedValueOnce({ id: 9 });
      prisma.message.update.mockResolvedValue(
        message(9, 1, { text: 'Edited', editedAt: date }),
      );

      await service.edit(1, 5, 9, 'Edited');

      const previews = presence.notify.mock.calls.filter(
        ([, event]) => event === 'conversation',
      );
      expect(
        previews.map(([ids, , payload]) => [
          ids,
          payload.conversation.lastText,
        ]),
      ).toEqual([
        [[1], 'Edited'],
        [[2], 'Message from someone you blocked'],
        [[3], 'Edited'],
      ]);
    });

    it('hides a quoted message from someone blocked with you in the history', async () => {
      prisma.conversation.findUnique.mockResolvedValue(group());
      blocks([1, 2]);
      const quoted = (senderId: number) => ({
        id: 1,
        senderId,
        text: 'Ramen later?',
        sender: users[senderId],
      });
      prisma.message.findMany.mockResolvedValue([
        message(3, 3, { replyTo: quoted(3) }),
        message(2, 3, { replyTo: quoted(2) }),
      ]);

      const history = await service.history(1, 5);

      expect(history.messages.map(({ replyTo }) => replyTo)).toEqual([
        {
          id: 1,
          senderId: 2,
          sender: {
            userId: 2,
            username: 'naruto',
            name: null,
            avatarUrl: null,
          },
          text: '',
          hiddenBecause: { kind: 'blocked' },
        },
        expect.objectContaining({ text: 'Ramen later?', hiddenBecause: null }),
      ]);
    });

    it('hides a quoted message per recipient in the live update', async () => {
      prisma.conversation.findUnique.mockResolvedValue(group());
      blocks([3, 2]);
      prisma.message.findFirst.mockResolvedValue({ id: 1 });
      prisma.message.create.mockImplementation(({ data }) => ({
        ...message(9, data.senderId, {
          text: data.text,
          replyTo: {
            id: 1,
            senderId: 2,
            text: 'Ramen later?',
            sender: users[2],
          },
        }),
        conversationId: data.conversationId,
      }));

      const sent = await service.send(1, 5, 'Yes', 1);

      expect(sent.replyTo).toMatchObject({
        text: 'Ramen later?',
        hiddenBecause: null,
      });
      expect(sentTo(2).message.replyTo).toMatchObject({
        text: 'Ramen later?',
        hiddenBecause: null,
      });
      expect(sentTo(3).message.hiddenBecause).toBeNull();
      expect(sentTo(3).message.replyTo).toMatchObject({
        text: '',
        hiddenBecause: { kind: 'blocked' },
      });
    });

    it('gives the person reacting their own view of a collapsed message', async () => {
      prisma.conversation.findUnique.mockResolvedValue(group());
      blocks([1, 2]);
      prisma.message.findFirst.mockResolvedValue({ id: 9, reactions: [] });
      prisma.message.findUniqueOrThrow.mockResolvedValue(
        message(9, 2, { reactions: [{ userId: 1, emoji: '👍' }] }),
      );

      const reacted = await service.react(1, 5, 9, '👍');

      expect(reacted.hiddenBecause).toEqual({ kind: 'blocked' });
      const updates = presence.notify.mock.calls.filter(
        ([, event]) => event === 'message:updated',
      );
      expect(
        updates.map(([ids, , payload]) => [ids, payload.message.hiddenBecause]),
      ).toEqual([
        [[1], { kind: 'blocked' }],
        [[2, 3], null],
      ]);
    });

    it('splits an edit between people who see it and people blocked with the sender', async () => {
      prisma.conversation.findUnique.mockResolvedValue(group());
      blocks([2, 1]);
      prisma.message.findFirst
        .mockResolvedValueOnce({ senderId: 1 })
        .mockResolvedValueOnce({ id: 3 });
      prisma.message.update.mockResolvedValue(
        message(9, 1, { text: 'Edited', editedAt: date }),
      );

      await service.edit(1, 5, 9, 'Edited');

      const updates = presence.notify.mock.calls.filter(
        ([, event]) => event === 'message:updated',
      );
      expect(updates).toHaveLength(2);
      expect(updates[0][0]).toEqual([1, 3]);
      expect(updates[0][2].message.hiddenBecause).toBeNull();
      expect(updates[1][0]).toEqual([2]);
      expect(updates[1][2].message.hiddenBecause).toEqual({ kind: 'blocked' });
    });
  });

  describe('muting a conversation', () => {
    it('mutes it for you only and updates your other tabs', async () => {
      prisma.conversation.findUnique
        .mockResolvedValueOnce(conversation())
        .mockResolvedValueOnce(
          conversation({ members: [member(1, date), member(2)] }),
        );

      await expect(service.setMuted(1, 5, true)).resolves.toEqual({
        muted: true,
      });

      expect(prisma.conversationMember.update).toHaveBeenCalledWith({
        where: { conversationId_userId: { conversationId: 5, userId: 1 } },
        data: { mutedAt: expect.any(Date) },
      });
      expect(presence.notify).toHaveBeenCalledWith([1], 'conversation', {
        conversation: expect.objectContaining({
          id: 5,
          muted: true,
          canMessage: true,
        }),
      });
    });

    it('unmutes it', async () => {
      await expect(service.setMuted(1, 5, false)).resolves.toEqual({
        muted: false,
      });

      expect(prisma.conversationMember.update).toHaveBeenCalledWith({
        where: { conversationId_userId: { conversationId: 5, userId: 1 } },
        data: { mutedAt: null },
      });
      expect(presence.notify).toHaveBeenCalledWith([1], 'conversation', {
        conversation: expect.objectContaining({ muted: false }),
      });
    });

    it('only lets members mute a chat', async () => {
      await expect(service.setMuted(3, 5, true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.conversationMember.update).not.toHaveBeenCalled();
    });

    it('keeps counting a muted chat’s unread messages and marks it muted', async () => {
      prisma.conversationMember.findMany.mockResolvedValue([
        {
          conversation: conversation({
            members: [{ ...member(1, date), unread: 3 }, member(2)],
          }),
        },
      ]);

      const [entry] = await service.inbox(1);

      expect(entry).toMatchObject({ unread: 3, muted: true });
    });

    it('says whether the open chat is muted', async () => {
      prisma.conversation.findUnique.mockResolvedValue(
        conversation({ members: [member(1, date), member(2)] }),
      );
      prisma.message.findMany.mockResolvedValue([]);

      await expect(service.history(1, 5)).resolves.toMatchObject({
        muted: true,
        canMessage: true,
      });
    });
  });
});
