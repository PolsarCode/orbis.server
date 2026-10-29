import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma.service';
import { nsfwEntries, showsNsfw } from './nsfw';
import { loadSteamLinks, SteamLink } from '../steam/steam-links';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { UpdateOnboardingDto } from './dto/update-onboarding.dto';
import {
  LibraryStatus,
  MediaType,
  User as UserModel,
  UserStatus,
} from '../../prisma/generated/client';
import { normalizeUsername } from './username';
import { isHeadAdmin } from './head-admin';
import { StorageService } from '../storage/storage.service';
import { canViewProfile } from '../posts/wall-access';
import { PresenceGateway, PresenceStatus } from '../friends/presence.gateway';
import { NextStream, TwitchLiveService } from '../friends/twitch-live.service';

export type PublicUser = Omit<UserModel, 'password'>;

export type PublicProfile = {
  userId: number;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  backgroundUrl: string | null;
  isAdmin: boolean;
  isHeadAdmin: boolean;
  isVerified: boolean;
  isPublic: boolean;
  restricted: boolean;
  hasClips: boolean;
  twitchLogin: string | null;
  nextStream: NextStream | null;
  createdAt: Date;
  online: boolean;
  status: PresenceStatus;
  friendCount: number;
  postCount: number;
  communityCount: number;
  communities: {
    id: number;
    name: string;
    iconUrl: string | null;
    coverUrl: string | null;
    isVerified: boolean;
    memberCount: number;
    isOwner: boolean;
  }[];
  friends: {
    userId: number;
    username: string;
    name: string | null;
    avatarUrl: string | null;
    coverUrl: string | null;
    isVerified: boolean;
    online: boolean;
    status: PresenceStatus;
    playing: string | null;
    twitchLogin: string | null;
  }[];
  library: {
    id: number;
    mediaType: MediaType;
    sourceId: string;
    title: string;
    coverImage: string | null;
    status: LibraryStatus;
    progress: number;
    total: number | null;
    steam: SteamLink | null;
  }[];
};

export type Onboarding = {
  tourCompleted: boolean;
  checklistDismissed: boolean;
  completedTours: string[];
  steps: {
    avatar: boolean;
    community: boolean;
    post: boolean;
    comment: boolean;
    friend: boolean;
    feedback: boolean;
    library: boolean;
  };
  used: {
    steam: boolean;
    connections: boolean;
    folders: boolean;
  };
};

export type Profile = Pick<
  UserModel,
  | 'email'
  | 'username'
  | 'avatarUrl'
  | 'coverUrl'
  | 'backgroundUrl'
  | 'theme'
  | 'appearOffline'
  | 'status'
  | 'isPublic'
  | 'showNsfw'
  | 'showChangelog'
  | 'isAdmin'
  | 'emailVerifiedAt'
  | 'createdAt'
> & {
  userId: number;
  isHeadAdmin: boolean;
};

export type PublicUserSummary = {
  userId: number;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  isVerified: boolean;
  online: boolean;
  activity: number;
};

export type ActiveUser = Omit<PublicUserSummary, 'online'> & {
  appearOffline: boolean;
};

export const PUBLIC_USER_LIMIT = 12;

const ACTIVITY_WINDOW_DAYS = 30;

export function rankPublicUsers(
  users: ActiveUser[],
  isOnline: (userId: number) => boolean,
  limit = PUBLIC_USER_LIMIT,
): PublicUserSummary[] {
  return users
    .map(({ appearOffline, ...user }) => ({
      ...user,
      online: !appearOffline && isOnline(user.userId),
    }))
    .sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        b.activity - a.activity ||
        a.userId - b.userId,
    )
    .slice(0, limit);
}

const omitPassword = { password: true } as const;

const profile = {
  id: true,
  email: true,
  username: true,
  avatarUrl: true,
  coverUrl: true,
  backgroundUrl: true,
  theme: true,
  appearOffline: true,
  status: true,
  isPublic: true,
  showNsfw: true,
  showChangelog: true,
  isAdmin: true,
  emailVerifiedAt: true,
  createdAt: true,
} as const;

function toProfile({
  id,
  ...user
}: Pick<UserModel, keyof typeof profile>): Profile {
  const headAdmin = isHeadAdmin(user.email);
  return {
    userId: id,
    ...user,
    isAdmin: user.isAdmin || headAdmin,
    isHeadAdmin: headAdmin,
  };
}

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private presence: PresenceGateway,
    private twitch: TwitchLiveService,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<PublicUser> {
    return this.prisma.user.create({
      data: {
        email: createUserDto.email,
        username: normalizeUsername(createUserDto.username),
        password: await bcrypt.hash(createUserDto.password, 10),
      },
      omit: omitPassword,
    });
  }

  async findProfile(id: number): Promise<Profile | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: profile,
    });

    return user && toProfile(user);
  }

  async updatePreferences(
    id: number,
    {
      theme,
      appearOffline,
      status,
      isPublic,
      showNsfw,
      showChangelog,
    }: UpdatePreferencesDto,
  ): Promise<Profile> {
    const user = await this.prisma.user.update({
      where: { id },
      data: { theme, appearOffline, status, isPublic, showNsfw, showChangelog },
      select: profile,
    });

    return toProfile(user);
  }

  async updateAvatar(id: number, file: Buffer): Promise<Profile> {
    const { url } = await this.storage.uploadImage(file, 'avatars', 384);
    return this.replaceImage(id, 'avatarUrl', url);
  }

  removeAvatar(id: number): Promise<Profile> {
    return this.replaceImage(id, 'avatarUrl', null);
  }

  async updateCover(id: number, file: Buffer): Promise<Profile> {
    const { url } = await this.storage.uploadImage(file, 'user-covers', 1600);
    return this.replaceImage(id, 'coverUrl', url);
  }

  removeCover(id: number): Promise<Profile> {
    return this.replaceImage(id, 'coverUrl', null);
  }

  async updateBackground(id: number, file: Buffer): Promise<Profile> {
    const { url } = await this.storage.uploadImage(
      file,
      'user-backgrounds',
      1920,
    );
    return this.replaceImage(id, 'backgroundUrl', url);
  }

  removeBackground(id: number): Promise<Profile> {
    return this.replaceImage(id, 'backgroundUrl', null);
  }

  private async replaceImage(
    id: number,
    field: 'avatarUrl' | 'coverUrl' | 'backgroundUrl',
    url: string | null,
  ): Promise<Profile> {
    const previous = await this.prisma.user.findUnique({
      where: { id },
      select: { avatarUrl: true, coverUrl: true, backgroundUrl: true },
    });
    const user = await this.prisma.user.update({
      where: { id },
      data: { [field]: url },
      select: profile,
    });

    const previousKey =
      previous?.[field] && this.storage.keyFor(previous[field]);
    if (previousKey) await this.storage.delete(previousKey).catch(() => {});

    return toProfile(user);
  }

  async activePublicUsers(): Promise<ActiveUser[]> {
    const since = new Date(
      Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const recent = { where: { createdAt: { gte: since } } };
    const users = await this.prisma.user.findMany({
      where: { isPublic: true },
      select: {
        id: true,
        username: true,
        name: true,
        avatarUrl: true,
        coverUrl: true,
        isVerified: true,
        appearOffline: true,
        _count: {
          select: { posts: recent, comments: recent },
        },
      },
    });

    return users.map(({ id, _count, ...user }) => ({
      userId: id,
      ...user,
      activity: _count.posts + _count.comments,
    }));
  }

  async publicProfile(
    viewerId: number,
    username: string,
  ): Promise<
    Omit<PublicProfile, 'online' | 'status' | 'friends'> & {
      appearOffline: boolean;
      status: UserStatus;
      friends: (Omit<
        PublicProfile['friends'][number],
        'online' | 'status' | 'playing' | 'twitchLogin'
      > & {
        appearOffline: boolean;
        status: UserStatus;
      })[];
    }
  > {
    const user = await this.prisma.user.findUnique({
      where: { username: normalizeUsername(username) },
      select: {
        id: true,
        username: true,
        name: true,
        avatarUrl: true,
        coverUrl: true,
        backgroundUrl: true,
        email: true,
        isAdmin: true,
        isVerified: true,
        appearOffline: true,
        status: true,
        isPublic: true,
        createdAt: true,
        oauthAccounts: {
          where: { provider: 'twitch' },
          select: {
            username: true,
            providerAccountId: true,
            showLive: true,
            showClips: true,
          },
        },
        memberships: {
          orderBy: { joinedAt: 'asc' },
          select: {
            community: {
              select: {
                id: true,
                name: true,
                iconUrl: true,
                coverUrl: true,
                isVerified: true,
                ownerId: true,
                isPublic: true,
                _count: { select: { memberships: true } },
                memberships: {
                  where: { userId: viewerId },
                  select: { userId: true },
                },
              },
            },
          },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');

    if (!(await canViewProfile(this.prisma, viewerId, user))) {
      const headAdmin = isHeadAdmin(user.email);
      return {
        userId: user.id,
        username: user.username,
        name: user.name,
        avatarUrl: user.avatarUrl,
        coverUrl: null,
        backgroundUrl: null,
        isAdmin: user.isAdmin || headAdmin,
        isHeadAdmin: headAdmin,
        isVerified: user.isVerified,
        isPublic: false,
        restricted: true,
        hasClips: false,
        twitchLogin: null,
        nextStream: null,
        appearOffline: true,
        status: 'online',
        createdAt: user.createdAt,
        friendCount: 0,
        postCount: 0,
        communityCount: 0,
        communities: [],
        friends: [],
        library: [],
      };
    }

    const friendUser = {
      select: {
        id: true,
        username: true,
        name: true,
        avatarUrl: true,
        coverUrl: true,
        isVerified: true,
        appearOffline: true,
        status: true,
      },
    } as const;
    const [twitch] = user.oauthAccounts;
    const liveChannel = twitch?.showLive ? twitch : null;
    const [friendships, posts, library, nextStream] = await Promise.all([
      this.prisma.friendship.findMany({
        where: {
          status: 'accepted',
          OR: [{ requesterId: user.id }, { addresseeId: user.id }],
        },
        orderBy: { createdAt: 'desc' },
        select: { requester: friendUser, addressee: friendUser },
      }),
      this.prisma.post.count({ where: { authorId: user.id } }),
      this.prisma.libraryEntry.findMany({
        where: {
          userId: user.id,
          isPublic: true,
          ...nsfwEntries(await showsNsfw(this.prisma, viewerId)),
        },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          mediaType: true,
          sourceId: true,
          title: true,
          coverImage: true,
          status: true,
          progress: true,
          total: true,
          steamAppId: true,
        },
      }),
      liveChannel
        ? this.twitch.nextStream(liveChannel.providerAccountId)
        : null,
    ]);
    const steamOf = await loadSteamLinks(
      this.prisma,
      library.map((entry) => ({ userId: user.id, appId: entry.steamAppId })),
    );

    const { memberships, id, email, oauthAccounts, ...rest } = user;
    const headAdmin = isHeadAdmin(email);
    return {
      ...rest,
      isAdmin: rest.isAdmin || headAdmin,
      isHeadAdmin: headAdmin,
      restricted: false,
      hasClips: oauthAccounts.some((account) => account.showClips),
      twitchLogin: liveChannel?.username ?? null,
      nextStream,
      userId: id,
      friendCount: friendships.length,
      friends: friendships.map(({ requester, addressee }) => {
        const friend = requester.id === id ? addressee : requester;
        return {
          userId: friend.id,
          username: friend.username,
          name: friend.name,
          avatarUrl: friend.avatarUrl,
          coverUrl: friend.coverUrl,
          isVerified: friend.isVerified,
          appearOffline: friend.appearOffline,
          status: friend.status,
        };
      }),
      postCount: posts,
      communityCount: memberships.length,
      library: library.map(({ steamAppId, ...entry }) => ({
        ...entry,
        steam: steamOf(user.id, steamAppId),
      })),
      communities: memberships
        .map(({ community }) => community)
        .filter(
          (community) => community.isPublic || community.memberships.length > 0,
        )
        .map((community) => ({
          id: community.id,
          name: community.name,
          iconUrl: community.iconUrl,
          coverUrl: community.coverUrl,
          isVerified: community.isVerified,
          memberCount: community._count.memberships,
          isOwner: community.ownerId === id,
        })),
    };
  }

  async setAdmin(
    headAdminId: number,
    username: string,
    isAdmin: boolean,
  ): Promise<{ isAdmin: boolean }> {
    const headAdmin = await this.prisma.user.findUnique({
      where: { id: headAdminId },
      select: { email: true },
    });
    if (!headAdmin || !isHeadAdmin(headAdmin.email)) {
      throw new ForbiddenException(
        'Only the head admin can change site admins',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { username: normalizeUsername(username) },
      select: { id: true, email: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (isHeadAdmin(user.email)) {
      throw new BadRequestException('The head admin is always an admin');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { isAdmin },
    });
    return { isAdmin };
  }

  async setVerified(
    headAdminId: number,
    username: string,
    isVerified: boolean,
  ): Promise<{ isVerified: boolean }> {
    const headAdmin = await this.prisma.user.findUnique({
      where: { id: headAdminId },
      select: { email: true },
    });
    if (!headAdmin || !isHeadAdmin(headAdmin.email)) {
      throw new ForbiddenException('Only the head admin can verify profiles');
    }

    const user = await this.prisma.user.findUnique({
      where: { username: normalizeUsername(username) },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { isVerified },
    });

    const friendships = await this.prisma.friendship.findMany({
      where: { OR: [{ requesterId: user.id }, { addresseeId: user.id }] },
      select: { requesterId: true, addresseeId: true },
    });
    const friendIds = friendships.map(({ requesterId, addresseeId }) =>
      requesterId === user.id ? addresseeId : requesterId,
    );
    if (friendIds.length > 0) {
      this.presence.notify(friendIds, 'friends:changed');
    }
    return { isVerified };
  }

  async onboarding(id: number): Promise<Onboarding> {
    const [
      user,
      memberships,
      posts,
      comments,
      friendships,
      reports,
      libraryEntries,
      steamAccounts,
      oauthAccounts,
      folders,
    ] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id },
        select: {
          avatarUrl: true,
          tourCompletedAt: true,
          checklistDismissedAt: true,
          completedTours: true,
        },
      }),
      this.prisma.membership.count({ where: { userId: id } }),
      this.prisma.post.count({ where: { authorId: id } }),
      this.prisma.comment.count({ where: { authorId: id } }),
      this.prisma.friendship.count({
        where: {
          OR: [{ requesterId: id }, { addresseeId: id, status: 'accepted' }],
        },
      }),
      this.prisma.report.count({ where: { authorId: id } }),
      this.prisma.libraryEntry.count({ where: { userId: id } }),
      this.prisma.steamAccount.count({ where: { userId: id } }),
      this.prisma.oAuthAccount.count({ where: { userId: id } }),
      this.prisma.railFolder.count({ where: { userId: id } }),
    ]);

    return {
      tourCompleted: user.tourCompletedAt !== null,
      checklistDismissed: user.checklistDismissedAt !== null,
      completedTours: user.completedTours,
      steps: {
        avatar: user.avatarUrl !== null,
        community: memberships > 0,
        post: posts > 0,
        comment: comments > 0,
        friend: friendships > 0,
        feedback: reports > 0,
        library: libraryEntries > 0,
      },
      used: {
        steam: steamAccounts > 0,
        connections: oauthAccounts > 0,
        folders: folders > 0,
      },
    };
  }

  async updateOnboarding(
    id: number,
    {
      tourCompleted,
      checklistDismissed,
      completedTour,
      resetTours,
    }: UpdateOnboardingDto,
  ): Promise<Onboarding> {
    const at = (value?: boolean) =>
      value === undefined ? undefined : value ? new Date() : null;

    const completedTours = completedTour
      ? (
          await this.prisma.user.findUniqueOrThrow({
            where: { id },
            select: { completedTours: true },
          })
        ).completedTours
      : [];

    await this.prisma.user.update({
      where: { id },
      data: {
        tourCompletedAt: at(tourCompleted),
        checklistDismissedAt: at(checklistDismissed),
        ...(completedTour &&
          !completedTours.includes(completedTour) && {
            completedTours: { push: completedTour },
          }),
        ...(resetTours && { tourCompletedAt: null, completedTours: [] }),
      },
    });
    return this.onboarding(id);
  }

  findByEmail(email: string): Promise<UserModel | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findByUsername(username: string): Promise<UserModel | null> {
    return this.prisma.user.findUnique({ where: { username } });
  }
}
