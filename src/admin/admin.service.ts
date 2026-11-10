import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { isHeadAdmin } from '../users/head-admin';
import { author } from '../common/author';

export const DIRECTORY_PAGE_SIZE = 20;

const CONNECTIONS = ['discord', 'twitch', 'steam'] as const;

export type DirectoryPage<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type DirectoryUser = {
  userId: number;
  username: string;
  name: string | null;
  email: string;
  emailVerifiedAt: Date | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  isAdmin: boolean;
  isHeadAdmin: boolean;
  isVerified: boolean;
  communityCount: number;
  connections: Array<(typeof CONNECTIONS)[number]>;
  createdAt: Date;
};

export type DirectoryCommunity = {
  id: number;
  name: string;
  iconUrl: string | null;
  coverUrl: string | null;
  isPublic: boolean;
  isVerified: boolean;
  memberCount: number;
  owner: {
    id: number;
    username: string;
    name: string | null;
    avatarUrl: string | null;
  };
  createdAt: Date;
};

const newestFirst = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  private window(page: number) {
    return {
      skip: (page - 1) * DIRECTORY_PAGE_SIZE,
      take: DIRECTORY_PAGE_SIZE,
    };
  }

  async users(page: number): Promise<DirectoryPage<DirectoryUser>> {
    const [total, users] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.user.findMany({
        orderBy: newestFirst,
        ...this.window(page),
        select: {
          id: true,
          username: true,
          name: true,
          email: true,
          emailVerifiedAt: true,
          avatarUrl: true,
          coverUrl: true,
          isAdmin: true,
          isVerified: true,
          createdAt: true,
          _count: { select: { memberships: true } },
          oauthAccounts: { select: { provider: true } },
          steamAccount: { select: { userId: true } },
        },
      }),
    ]);

    return {
      items: users.map(
        ({ id, _count, oauthAccounts, steamAccount, ...user }) => {
          const headAdmin = isHeadAdmin(user.email);
          return {
            ...user,
            userId: id,
            isAdmin: user.isAdmin || headAdmin,
            isHeadAdmin: headAdmin,
            communityCount: _count.memberships,
            connections: CONNECTIONS.filter((connection) =>
              connection === 'steam'
                ? steamAccount !== null
                : oauthAccounts.some(({ provider }) => provider === connection),
            ),
          };
        },
      ),
      total,
      page,
      pageSize: DIRECTORY_PAGE_SIZE,
    };
  }

  async communities(page: number): Promise<DirectoryPage<DirectoryCommunity>> {
    const [total, communities] = await this.prisma.$transaction([
      this.prisma.community.count(),
      this.prisma.community.findMany({
        orderBy: newestFirst,
        ...this.window(page),
        select: {
          id: true,
          name: true,
          iconUrl: true,
          coverUrl: true,
          isPublic: true,
          isVerified: true,
          createdAt: true,
          owner: author,
          _count: { select: { memberships: true } },
        },
      }),
    ]);

    return {
      items: communities.map(({ _count, ...community }) => ({
        ...community,
        memberCount: _count.memberships,
      })),
      total,
      page,
      pageSize: DIRECTORY_PAGE_SIZE,
    };
  }
}
