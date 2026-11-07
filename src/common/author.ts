import type { Prisma } from '../../prisma/generated/client';

export const author = {
  select: { id: true, username: true, name: true, avatarUrl: true },
} as const;

export type Author = Prisma.UserGetPayload<typeof author>;

export const deletedAuthor: Author = {
  id: 0,
  username: '',
  name: null,
  avatarUrl: null,
};

export const presenceUser = {
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

export const communitySummary = {
  select: { id: true, name: true, iconUrl: true },
} as const;
