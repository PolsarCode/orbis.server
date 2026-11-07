import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { communitySummary } from '../common/author';
import { editHistorySelect } from '../common/edit-history';
import { memberRole } from '../communities/communities.service';

const username = { select: { username: true } } as const;

const person = { select: { username: true, name: true } } as const;

function withEdits<T extends { editVersions: unknown[] }>({
  editVersions,
  ...item
}: T) {
  return { ...item, earlierVersions: editVersions };
}

@Injectable()
export class AccountExportService {
  constructor(private prisma: PrismaService) {}

  async export(userId: number) {
    const [
      user,
      posts,
      comments,
      forumThreads,
      forumPosts,
      messages,
      library,
      friendships,
      memberships,
    ] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          username: true,
          email: true,
          name: true,
          avatarUrl: true,
          coverUrl: true,
          backgroundUrl: true,
          emailVerifiedAt: true,
          twoFactorEnabledAt: true,
          createdAt: true,
          theme: true,
          appearOffline: true,
          status: true,
          isPublic: true,
          showNsfw: true,
          showChangelog: true,
          oauthAccounts: {
            orderBy: { createdAt: 'asc' },
            select: {
              provider: true,
              username: true,
              showLive: true,
              showClips: true,
              createdAt: true,
            },
          },
          steamAccount: {
            select: {
              steamId: true,
              personaName: true,
              trackGames: true,
              gamesPrivate: true,
              showPlaying: true,
              createdAt: true,
            },
          },
          keywordFilters: {
            orderBy: { createdAt: 'asc' },
            select: { phrase: true, expiresAt: true, createdAt: true },
          },
        },
      }),
      this.prisma.post.findMany({
        where: { authorId: userId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          ...editHistorySelect,
          community: communitySummary,
          wallUser: username,
          mediaType: true,
          mediaSourceId: true,
          isQuote: true,
          quotePostId: true,
          quoteActivityId: true,
          forumThreadId: true,
        },
      }),
      this.prisma.comment.findMany({
        where: { authorId: userId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          ...editHistorySelect,
          commentableType: true,
          commentableId: true,
          parentId: true,
          communityId: true,
        },
      }),
      this.prisma.forumThread.findMany({
        where: { authorId: userId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          title: true,
          createdAt: true,
          community: communitySummary,
          category: { select: { id: true, name: true } },
        },
      }),
      this.prisma.forumPost.findMany({
        where: { authorId: userId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          ...editHistorySelect,
          opening: true,
          threadId: true,
          thread: { select: { title: true } },
          communityId: true,
        },
      }),
      this.prisma.message.findMany({
        where: { senderId: userId, system: false },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          conversationId: true,
          text: true,
          replyToId: true,
          editedAt: true,
          createdAt: true,
        },
      }),
      this.prisma.libraryEntry.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: {
          mediaType: true,
          sourceId: true,
          title: true,
          year: true,
          status: true,
          progress: true,
          total: true,
          isPublic: true,
          createdAt: true,
          updatedAt: true,
          activities: {
            orderBy: { createdAt: 'asc' },
            select: {
              status: true,
              progressFrom: true,
              progressTo: true,
              createdAt: true,
            },
          },
        },
      }),
      this.prisma.friendship.findMany({
        where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
        orderBy: { createdAt: 'asc' },
        select: {
          requesterId: true,
          status: true,
          createdAt: true,
          requester: person,
          addressee: person,
        },
      }),
      this.prisma.membership.findMany({
        where: { userId },
        orderBy: { joinedAt: 'asc' },
        select: {
          nickname: true,
          joinedAt: true,
          community: { select: { id: true, name: true, ownerId: true } },
          roles: { select: { role: { select: { permissions: true } } } },
        },
      }),
    ]);

    const conversations = await this.prisma.conversation.findMany({
      where: {
        id: {
          in: [
            ...new Set(messages.map(({ conversationId }) => conversationId)),
          ],
        },
      },
      select: {
        id: true,
        isGroup: true,
        name: true,
        userA: { select: { id: true, username: true } },
        userB: { select: { id: true, username: true } },
        members: { select: { userId: true, user: username } },
      },
    });
    const otherMembers = new Map(
      conversations.map((conversation) => {
        const left =
          conversation.isGroup &&
          !conversation.members.some((member) => member.userId === userId);
        return [
          conversation.id,
          {
            isGroup: conversation.isGroup,
            name: left ? null : conversation.name,
            members: left
              ? []
              : conversation.isGroup
                ? conversation.members
                    .filter((member) => member.userId !== userId)
                    .map(({ user }) => user.username)
                : [conversation.userA, conversation.userB]
                    .filter((other) => other && other.id !== userId)
                    .map((other) => other!.username),
            ...(left && { left: true }),
          },
        ];
      }),
    );

    const {
      twoFactorEnabledAt,
      theme,
      appearOffline,
      status,
      isPublic,
      showNsfw,
      showChangelog,
      oauthAccounts,
      steamAccount,
      keywordFilters,
      ...profile
    } = user;
    const otherPerson = ({
      requesterId,
      requester,
      addressee,
    }: (typeof friendships)[number]) =>
      requesterId === userId ? addressee : requester;

    return {
      exportedAt: new Date().toISOString(),
      profile: {
        ...profile,
        twoFactorEnabled: twoFactorEnabledAt !== null,
        settings: {
          theme,
          appearOffline,
          status,
          isPublic,
          showNsfw,
          showChangelog,
          keywordFilters,
        },
        linkedAccounts: oauthAccounts,
        steam: steamAccount,
      },
      posts: posts.map(withEdits),
      comments: comments.map(withEdits),
      forumThreads,
      forumPosts: forumPosts.map(withEdits),
      messages: messages.map((message) => ({
        ...message,
        conversation: otherMembers.get(message.conversationId) ?? null,
      })),
      library,
      friends: {
        friends: friendships
          .filter((friendship) => friendship.status === 'accepted')
          .map((friendship) => ({
            ...otherPerson(friendship),
            since: friendship.createdAt,
          })),
        requestsSent: friendships
          .filter(
            (friendship) =>
              friendship.status === 'pending' &&
              friendship.requesterId === userId,
          )
          .map((friendship) => ({
            ...otherPerson(friendship),
            sentAt: friendship.createdAt,
          })),
        requestsReceived: friendships
          .filter(
            (friendship) =>
              friendship.status === 'pending' &&
              friendship.requesterId !== userId,
          )
          .map((friendship) => ({
            ...otherPerson(friendship),
            receivedAt: friendship.createdAt,
          })),
      },
      communities: memberships.map(
        ({ community, nickname, joinedAt, roles }) => ({
          id: community.id,
          name: community.name,
          role: memberRole(userId, community.ownerId, roles),
          nickname,
          joinedAt,
        }),
      ),
    };
  }
}
