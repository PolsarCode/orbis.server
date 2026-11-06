import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConversationStatus, Prisma } from '../../prisma/generated/client';
import { PrismaService } from '../prisma.service';
import { MAX_INT } from '../communities/community-member.guard';
import { PresenceGateway } from '../friends/presence.gateway';
import {
  GROUP_MAX_MEMBERS,
  MESSAGE_LIMIT,
  MESSAGE_PAGE_SIZE,
  pair,
} from './conversation';
import { blockedWith, isBlocked } from '../safety/blocks';

const person = {
  select: { id: true, username: true, name: true, avatarUrl: true },
} as const;

const conversationSelect = {
  id: true,
  isGroup: true,
  name: true,
  creatorId: true,
  lastText: true,
  lastSenderId: true,
  lastSystem: true,
  lastMessageAt: true,
  userA: person,
  userB: person,
  members: {
    select: {
      userId: true,
      unread: true,
      status: true,
      readAt: true,
      mutedAt: true,
      user: person,
    },
  },
} satisfies Prisma.ConversationSelect;

const messageSelect = {
  id: true,
  senderId: true,
  text: true,
  system: true,
  editedAt: true,
  createdAt: true,
  sender: person,
  replyTo: {
    select: { id: true, senderId: true, text: true, sender: person },
  },
  reactions: {
    select: { userId: true, emoji: true },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.MessageSelect;

type Person = {
  id: number;
  username: string;
  name: string | null;
  avatarUrl: string | null;
};

type LoadedConversation = Prisma.ConversationGetPayload<{
  select: typeof conversationSelect;
}>;

type LoadedMessage = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

type Tx = Prisma.TransactionClient;

export type ChatPerson = {
  userId: number;
  username: string;
  name: string | null;
  avatarUrl: string | null;
};

const BLOCKED = { kind: 'blocked' } as const;

const BLOCKED_TEXT = 'Message from someone you blocked';

const NONE: ReadonlySet<number> = new Set();

export type ChatReply = {
  id: number;
  senderId: number;
  sender: ChatPerson;
  text: string;
  hiddenBecause: typeof BLOCKED | null;
};

export type ChatReaction = { emoji: string; userIds: number[] };

export type ChatMessage = {
  id: number;
  senderId: number;
  sender: ChatPerson;
  text: string;
  system: boolean;
  sentAt: string;
  editedAt: string | null;
  replyTo: ChatReply | null;
  reactions: ChatReaction[];
  hiddenBecause: typeof BLOCKED | null;
};

export type InboxEntry = {
  id: number;
  isGroup: boolean;
  name: string | null;
  creatorId: number | null;
  members: ChatPerson[];
  lastText: string;
  lastSenderId: number | null;
  lastSystem: boolean;
  lastAt: string;
  unread: number;
  status: ConversationStatus;
  muted: boolean;
  canMessage: boolean;
};

export type ChatHistory = {
  messages: ChatMessage[];
  members: (ChatPerson & { readAt: string | null })[];
  hasMore: boolean;
  muted: boolean;
  canMessage: boolean;
};

function toPerson({ id, username, name, avatarUrl }: Person): ChatPerson {
  return { userId: id, username, name, avatarUrl };
}

function displayName({ name, username }: Person) {
  return name ?? username;
}

function listNames(people: Person[]) {
  const names = people.map(displayName);
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    : names[0];
}

function reactionsOf(reactions: LoadedMessage['reactions']): ChatReaction[] {
  const grouped = new Map<string, number[]>();
  for (const { emoji, userId } of reactions) {
    grouped.set(emoji, [...(grouped.get(emoji) ?? []), userId]);
  }
  return [...grouped].map(([emoji, userIds]) => ({ emoji, userIds }));
}

function toMessage(
  message: LoadedMessage,
  collapsed: ReadonlySet<number> = NONE,
): ChatMessage {
  const { replyTo } = message;
  const replyHidden = replyTo !== null && collapsed.has(replyTo.senderId);
  return {
    id: message.id,
    senderId: message.senderId,
    sender: toPerson(message.sender),
    text: message.text,
    system: message.system,
    sentAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    replyTo: replyTo && {
      id: replyTo.id,
      senderId: replyTo.senderId,
      sender: toPerson(replyTo.sender),
      text: replyHidden ? '' : replyTo.text,
      hiddenBecause: replyHidden ? BLOCKED : null,
    },
    reactions: reactionsOf(message.reactions),
    hiddenBecause:
      !message.system && collapsed.has(message.senderId) ? BLOCKED : null,
  };
}

function collapsedIn(
  conversation: LoadedConversation,
  blocked: ReadonlySet<number>,
) {
  return conversation.isGroup ? blocked : NONE;
}

function othersOf(conversation: LoadedConversation, userId: number) {
  if (!conversation.isGroup) {
    const other =
      conversation.userA?.id === userId
        ? conversation.userB
        : conversation.userA;
    return other ? [other] : [];
  }
  return conversation.members
    .filter((member) => member.userId !== userId)
    .map((member) => member.user);
}

function entryFor(
  conversation: LoadedConversation,
  userId: number,
  blocked: ReadonlySet<number> = NONE,
): InboxEntry | null {
  const mine = conversation.members.find((member) => member.userId === userId);
  if (!mine) return null;
  const others = othersOf(conversation, userId);
  const lastHidden =
    conversation.isGroup &&
    !conversation.lastSystem &&
    conversation.lastSenderId !== null &&
    blocked.has(conversation.lastSenderId);

  return {
    id: conversation.id,
    isGroup: conversation.isGroup,
    name: conversation.name,
    creatorId: conversation.creatorId,
    members: others.map(toPerson),
    lastText: lastHidden ? BLOCKED_TEXT : conversation.lastText,
    lastSenderId: conversation.lastSenderId,
    lastSystem: conversation.lastSystem,
    lastAt: conversation.lastMessageAt.toISOString(),
    unread: mine.unread,
    status: mine.status,
    muted: mine.mutedAt !== null,
    canMessage:
      conversation.isGroup || !others.some(({ id }) => blocked.has(id)),
  };
}

function cleanName(name?: string) {
  return name?.trim() || null;
}

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@Injectable()
export class MessagesService {
  constructor(
    private prisma: PrismaService,
    private presence: PresenceGateway,
  ) {}

  async inbox(userId: number): Promise<InboxEntry[]> {
    const members = await this.prisma.conversationMember.findMany({
      where: { userId, conversation: { lastSenderId: { not: null } } },
      orderBy: { conversation: { lastMessageAt: 'desc' } },
      select: { conversation: { select: conversationSelect } },
    });
    const blocked = await blockedWith(this.prisma, userId);

    return members.map(
      ({ conversation }) => entryFor(conversation, userId, blocked)!,
    );
  }

  async direct(userId: number, otherId: number): Promise<InboxEntry> {
    if (otherId === userId) {
      throw new BadRequestException('You cannot message yourself');
    }
    await this.requireUsers([otherId]);
    if (await isBlocked(this.prisma, userId, otherId)) {
      throw new ForbiddenException('You can’t message this person');
    }

    const open = () =>
      this.prisma.conversation.upsert({
        where: { userAId_userBId: pair(userId, otherId) },
        create: { ...pair(userId, otherId), members: { create: { userId } } },
        update: {},
        select: { id: true },
      });
    const { id } = await open().catch((error) => {
      if (isUniqueViolation(error)) return open();
      throw error;
    });
    await this.prisma.conversationMember.upsert({
      where: { conversationId_userId: { conversationId: id, userId } },
      create: { conversationId: id, userId },
      update: {},
    });

    return entryFor(await this.load(id), userId)!;
  }

  async createGroup(
    userId: number,
    userIds: number[],
    name?: string,
  ): Promise<InboxEntry> {
    const others = [...new Set(userIds)].filter((id) => id !== userId);
    if (others.length < 2) {
      throw new BadRequestException('Pick at least two people for a group');
    }
    if (others.length + 1 > GROUP_MAX_MEMBERS) {
      throw new BadRequestException(
        `Groups can have up to ${GROUP_MAX_MEMBERS} people`,
      );
    }
    await this.requireUsers(others);
    await this.requireUnblocked(userId, others);
    const friends = await this.friendIdsOf(userId, others);

    const message = await this.prisma.$transaction(async (tx) => {
      const { id } = await tx.conversation.create({
        data: {
          isGroup: true,
          name: cleanName(name),
          creatorId: userId,
          members: {
            create: [
              { userId, readAt: new Date() },
              ...others.map((other) => ({
                userId: other,
                status: friends.has(other)
                  ? ConversationStatus.accepted
                  : ConversationStatus.request,
              })),
            ],
          },
        },
        select: { id: true },
      });
      return this.post(tx, id, userId, 'created the group', true);
    });

    const { conversation } = await this.broadcast(
      message.conversationId,
      message,
    );
    return entryFor(conversation, userId)!;
  }

  async history(
    userId: number,
    id: number,
    before?: number,
  ): Promise<ChatHistory> {
    if (before !== undefined && (before < 1 || before > MAX_INT)) {
      throw new BadRequestException('Invalid cursor');
    }
    const { conversation, mine } = await this.membership(userId, id);
    const others = othersOf(conversation, userId);

    const page = await this.prisma.message.findMany({
      where: {
        conversationId: id,
        ...(before !== undefined && { id: { lt: before } }),
      },
      orderBy: { id: 'desc' },
      take: MESSAGE_PAGE_SIZE + 1,
      select: messageSelect,
    });

    const blocked = await blockedWith(this.prisma, userId, [
      ...new Set([
        ...others.map((other) => other.id),
        ...page.flatMap(({ senderId, replyTo }) =>
          replyTo ? [senderId, replyTo.senderId] : [senderId],
        ),
      ]),
    ]);
    const collapsed = collapsedIn(conversation, blocked);
    return {
      messages: page
        .slice(0, MESSAGE_PAGE_SIZE)
        .reverse()
        .map((message) => toMessage(message, collapsed)),
      members: others.map((other) => ({
        ...toPerson(other),
        readAt:
          conversation.members
            .find((member) => member.userId === other.id)
            ?.readAt?.toISOString() ?? null,
      })),
      hasMore: page.length > MESSAGE_PAGE_SIZE,
      muted: mine.mutedAt !== null,
      canMessage:
        conversation.isGroup || !others.some(({ id }) => blocked.has(id)),
    };
  }

  async send(
    userId: number,
    id: number,
    content: string,
    replyToId?: number,
  ): Promise<ChatMessage> {
    const text = content.trim();
    if (!text) throw new BadRequestException('Message cannot be empty');
    const { conversation } = await this.membership(userId, id);
    if (replyToId !== undefined) {
      const quoted = await this.prisma.message.findFirst({
        where: { id: replyToId, conversationId: id, system: false },
        select: { id: true },
      });
      if (!quoted) {
        throw new BadRequestException('That message can’t be replied to');
      }
    }

    const other = await this.requireMessageable(userId, conversation);
    const friends = other
      ? await this.friendIdsOf(userId, [other.id])
      : new Set<number>();

    const message = await this.prisma.$transaction(async (tx) => {
      if (other) {
        const theirs = conversation.members.find(
          (member) => member.userId === other.id,
        );
        const status =
          friends.has(other.id) || theirs?.status === 'accepted'
            ? ConversationStatus.accepted
            : ConversationStatus.request;
        await tx.conversationMember.upsert({
          where: {
            conversationId_userId: { conversationId: id, userId: other.id },
          },
          create: { conversationId: id, userId: other.id, status, unread: 1 },
          update: { status, unread: { increment: 1 } },
        });
      } else {
        await tx.conversationMember.updateMany({
          where: { conversationId: id, userId: { not: userId } },
          data: { unread: { increment: 1 } },
        });
      }

      const message = await this.post(tx, id, userId, text, false, replyToId);
      await tx.conversationMember.update({
        where: { conversationId_userId: { conversationId: id, userId } },
        data: { status: 'accepted', unread: 0, readAt: message.createdAt },
      });
      return message;
    });

    const { blockedFor } = await this.broadcast(id, message);
    return toMessage(message, collapsedIn(conversation, blockedFor(userId)));
  }

  async edit(
    userId: number,
    id: number,
    messageId: number,
    content: string,
  ): Promise<ChatMessage> {
    const text = content.trim();
    if (!text) throw new BadRequestException('Message cannot be empty');
    const { conversation } = await this.membership(userId, id);
    await this.requireMessageable(userId, conversation);
    if (messageId < 1 || messageId > MAX_INT) {
      throw new NotFoundException('Message not found');
    }
    const target = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId: id, system: false },
      select: { senderId: true },
    });
    if (!target) throw new NotFoundException('Message not found');
    if (target.senderId !== userId) {
      throw new ForbiddenException('You can only edit your own messages');
    }

    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { text, editedAt: new Date() },
      select: messageSelect,
    });
    const latest = await this.prisma.message.findFirst({
      where: { conversationId: id },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    if (latest?.id === messageId) {
      await this.prisma.conversation.update({
        where: { id },
        data: { lastText: text },
      });
      await this.broadcast(id);
    }
    return this.notifyUpdated(conversation, userId, updated);
  }

  async react(
    userId: number,
    id: number,
    messageId: number,
    emoji: string,
  ): Promise<ChatMessage> {
    const { conversation, mine } = await this.membership(userId, id);
    if (mine.status !== 'accepted') {
      throw new ForbiddenException('Accept the chat first');
    }
    await this.requireMessageable(userId, conversation);
    if (messageId < 1 || messageId > MAX_INT) {
      throw new NotFoundException('Message not found');
    }
    const target = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId: id, system: false },
      select: {
        id: true,
        reactions: { where: { userId }, select: { emoji: true } },
      },
    });
    if (!target) throw new NotFoundException('Message not found');

    if (target.reactions[0]?.emoji === emoji) {
      await this.prisma.messageReaction.deleteMany({
        where: { messageId, userId },
      });
    } else {
      await this.prisma.messageReaction.upsert({
        where: { messageId_userId: { messageId, userId } },
        create: { messageId, userId, emoji },
        update: { emoji, createdAt: new Date() },
      });
    }

    const updated = await this.prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      select: messageSelect,
    });
    return this.notifyUpdated(conversation, userId, updated);
  }

  async read(userId: number, id: number) {
    const { mine } = await this.membership(userId, id);
    const readAt = new Date();
    const accepted = mine.status === 'accepted';
    await this.prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId: id, userId } },
      data: { unread: 0, ...(accepted && { readAt }) },
    });

    const conversation = await this.load(id);
    this.presence.notify([userId], 'conversation', {
      conversation: entryFor(
        conversation,
        userId,
        await this.blockedFor(conversation, userId),
      ),
    });
    if (accepted) {
      this.presence.notify(
        this.acceptedOthers(conversation, userId),
        'messages:read',
        {
          conversationId: id,
          userId,
          readAt: readAt.toISOString(),
        },
      );
    }
  }

  async accept(userId: number, id: number) {
    await this.request(userId, id);
    await this.prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId: id, userId } },
      data: { status: 'accepted' },
    });
    const conversation = await this.load(id);
    this.presence.notify([userId], 'conversation', {
      conversation: entryFor(
        conversation,
        userId,
        await this.blockedFor(conversation, userId),
      ),
    });
  }

  async decline(userId: number, id: number) {
    const { conversation } = await this.request(userId, id);
    await this.prisma.conversationMember.delete({
      where: { conversationId_userId: { conversationId: id, userId } },
    });
    this.presence.notify([userId], 'conversation:removed', { id });
    if (conversation.isGroup) await this.broadcast(id);
  }

  async rename(userId: number, id: number, name: string) {
    await this.groupMember(userId, id);
    const cleaned = cleanName(name);

    const message = await this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({ where: { id }, data: { name: cleaned } });
      return this.post(
        tx,
        id,
        userId,
        cleaned ? `named the group “${cleaned}”` : 'removed the group name',
        true,
      );
    });
    await this.broadcast(id, message);
  }

  async addMembers(userId: number, id: number, userIds: number[]) {
    const conversation = await this.groupMember(userId, id);
    const existing = new Set(
      conversation.members.map((member) => member.userId),
    );
    const added = [...new Set(userIds)].filter((other) => !existing.has(other));
    if (added.length === 0) {
      throw new BadRequestException('Those people are already in the group');
    }
    if (existing.size + added.length > GROUP_MAX_MEMBERS) {
      throw new BadRequestException(
        `Groups can have up to ${GROUP_MAX_MEMBERS} people`,
      );
    }
    const people = await this.requireUsers(added);
    await this.requireUnblocked(userId, added);
    const friends = await this.friendIdsOf(userId, added);

    const message = await this.prisma.$transaction(async (tx) => {
      await tx.conversationMember.createMany({
        data: added.map((other) => ({
          conversationId: id,
          userId: other,
          status: friends.has(other)
            ? ConversationStatus.accepted
            : ConversationStatus.request,
        })),
      });
      return this.post(tx, id, userId, `added ${listNames(people)}`, true);
    });
    await this.broadcast(id, message);
  }

  async removeMember(userId: number, id: number, targetId: number) {
    const { conversation } = await this.membership(userId, id);
    if (!conversation.isGroup) {
      throw new BadRequestException('Only group chats have members to remove');
    }

    const leaving = targetId === userId;
    const target = conversation.members.find(
      (member) => member.userId === targetId,
    );
    if (!leaving && conversation.creatorId !== userId) {
      throw new ForbiddenException(
        'Only the person who made the group can remove people',
      );
    }
    if (!target) throw new NotFoundException('That person isn’t in the group');

    const message = await this.prisma.$transaction(async (tx) => {
      await tx.conversationMember.delete({
        where: {
          conversationId_userId: { conversationId: id, userId: targetId },
        },
      });
      return this.post(
        tx,
        id,
        userId,
        leaving ? 'left the group' : `removed ${displayName(target.user)}`,
        true,
      );
    });

    this.presence.notify([targetId], 'conversation:removed', { id });
    await this.broadcast(id, message);
  }

  async typing(userId: number, id: number, typing: boolean) {
    if (id < 1 || id > MAX_INT) return;
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      select: conversationSelect,
    });
    if (!conversation?.members.some((member) => member.userId === userId)) {
      return;
    }
    const recipients = this.acceptedOthers(conversation, userId);
    if (recipients.length === 0) return;
    this.presence.notify(recipients, 'typing', {
      conversationId: id,
      userId,
      typing,
    });
  }

  private async post(
    tx: Tx,
    conversationId: number,
    senderId: number,
    text: string,
    system: boolean,
    replyToId?: number,
  ) {
    const message = await tx.message.create({
      data: { conversationId, senderId, text, system, replyToId },
      select: { ...messageSelect, conversationId: true },
    });
    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        lastText: text,
        lastSenderId: senderId,
        lastSystem: system,
        lastMessageAt: message.createdAt,
      },
    });

    const cutoff = await tx.message.findFirst({
      where: { conversationId },
      orderBy: { id: 'desc' },
      skip: MESSAGE_LIMIT,
      select: { id: true },
    });
    if (cutoff) {
      await tx.message.deleteMany({
        where: { conversationId, id: { lte: cutoff.id } },
      });
    }
    return message;
  }

  private async broadcast(id: number, message?: LoadedMessage) {
    const conversation = await this.load(id);
    const blockedFor = await this.blocksAmong(conversation, message);
    for (const { userId } of conversation.members) {
      const blocked = blockedFor(userId);
      const entry = entryFor(conversation, userId, blocked);
      if (message) {
        this.presence.notify([userId], 'message', {
          conversation: entry,
          message: toMessage(message, collapsedIn(conversation, blocked)),
        });
      } else {
        this.presence.notify([userId], 'conversation', { conversation: entry });
      }
    }
    return { conversation, blockedFor };
  }

  private async blocksAmong(
    conversation: LoadedConversation,
    message?: LoadedMessage,
  ) {
    const ids = [
      ...new Set([
        ...conversation.members.map((member) => member.userId),
        ...[conversation.userA, conversation.userB].flatMap((other) =>
          other ? [other.id] : [],
        ),
        ...(conversation.lastSenderId === null
          ? []
          : [conversation.lastSenderId]),
        ...(message ? [message.senderId] : []),
        ...(message?.replyTo ? [message.replyTo.senderId] : []),
      ]),
    ];
    const blocks =
      ids.length < 2
        ? []
        : await this.prisma.block.findMany({
            where: { blockerId: { in: ids }, blockedId: { in: ids } },
            select: { blockerId: true, blockedId: true },
          });
    return (userId: number): ReadonlySet<number> =>
      new Set(
        blocks.flatMap(({ blockerId, blockedId }) =>
          blockerId === userId
            ? [blockedId]
            : blockedId === userId
              ? [blockerId]
              : [],
        ),
      );
  }

  private async notifyUpdated(
    conversation: LoadedConversation,
    userId: number,
    updated: LoadedMessage,
  ) {
    const blockedFor = conversation.isGroup
      ? await this.blocksAmong(conversation, updated)
      : () => NONE;
    const viewOf = (memberId: number) =>
      toMessage(updated, collapsedIn(conversation, blockedFor(memberId)));
    const audiences = new Map<
      string,
      { ids: number[]; message: ChatMessage }
    >();
    for (const { userId: memberId } of conversation.members) {
      const message = viewOf(memberId);
      const key = JSON.stringify([
        message.hiddenBecause,
        message.replyTo?.hiddenBecause ?? null,
      ]);
      const audience = audiences.get(key) ?? { ids: [], message };
      audience.ids.push(memberId);
      audiences.set(key, audience);
    }
    for (const { ids, message } of audiences.values()) {
      this.presence.notify(ids, 'message:updated', {
        conversationId: conversation.id,
        message,
      });
    }
    return viewOf(userId);
  }

  async setMuted(userId: number, id: number, muted: boolean) {
    await this.membership(userId, id);
    await this.prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId: id, userId } },
      data: { mutedAt: muted ? new Date() : null },
    });
    const conversation = await this.load(id);
    this.presence.notify([userId], 'conversation', {
      conversation: entryFor(
        conversation,
        userId,
        await this.blockedFor(conversation, userId),
      ),
    });
    return { muted };
  }

  private async blockedFor(conversation: LoadedConversation, userId: number) {
    return blockedWith(this.prisma, userId, [
      ...othersOf(conversation, userId).map((other) => other.id),
      ...(conversation.lastSenderId === null
        ? []
        : [conversation.lastSenderId]),
    ]);
  }

  private async requireMessageable(
    userId: number,
    conversation: LoadedConversation,
  ) {
    const other = conversation.isGroup
      ? null
      : (othersOf(conversation, userId)[0] ?? null);
    if (other && (await isBlocked(this.prisma, userId, other.id))) {
      throw new ForbiddenException('You can’t message this person');
    }
    return other;
  }

  private async requireUnblocked(userId: number, others: number[]) {
    if ((await blockedWith(this.prisma, userId, others)).size > 0) {
      throw new ForbiddenException('You can’t add this person');
    }
  }

  private acceptedOthers(conversation: LoadedConversation, userId: number) {
    return conversation.members
      .filter(
        (member) => member.userId !== userId && member.status === 'accepted',
      )
      .map((member) => member.userId);
  }

  private async load(id: number) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      select: conversationSelect,
    });
    if (!conversation) throw new NotFoundException('Chat not found');
    return conversation;
  }

  private async membership(userId: number, id: number) {
    if (id < 1 || id > MAX_INT) throw new NotFoundException('Chat not found');
    const conversation = await this.load(id);
    const mine = conversation.members.find(
      (member) => member.userId === userId,
    );
    if (!mine) throw new NotFoundException('Chat not found');
    return { conversation, mine };
  }

  private async request(userId: number, id: number) {
    const membership = await this.membership(userId, id);
    if (membership.mine.status !== 'request') {
      throw new NotFoundException('Message request not found');
    }
    return membership;
  }

  private async groupMember(userId: number, id: number) {
    const { conversation, mine } = await this.membership(userId, id);
    if (!conversation.isGroup) {
      throw new BadRequestException('Only group chats can do that');
    }
    if (mine.status !== 'accepted') {
      throw new ForbiddenException('Accept the group first');
    }
    return conversation;
  }

  private async requireUsers(userIds: number[]) {
    if (userIds.some((id) => id < 1 || id > MAX_INT)) {
      throw new NotFoundException('User not found');
    }
    const people = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      ...person,
    });
    if (people.length !== new Set(userIds).size) {
      throw new NotFoundException('User not found');
    }
    return people;
  }

  private async friendIdsOf(userId: number, candidates: number[]) {
    const friendships = await this.prisma.friendship.findMany({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: userId, addresseeId: { in: candidates } },
          { addresseeId: userId, requesterId: { in: candidates } },
        ],
      },
      select: { requesterId: true, addresseeId: true },
    });
    return new Set(
      friendships.map(({ requesterId, addresseeId }) =>
        requesterId === userId ? addresseeId : requesterId,
      ),
    );
  }
}
