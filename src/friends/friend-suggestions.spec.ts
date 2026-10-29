import { FriendsService } from './friends.service';
import { PrismaService } from '../prisma.service';
import { PresenceGateway } from './presence.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { rankCandidates, titleReason } from './suggestions';

const person = (id: number) => ({
  id,
  username: `user${id}`,
  name: `User ${id}`,
  avatarUrl: null,
  isVerified: false,
});

const SUSPENDED = 9;

function prismaFor() {
  return {
    friendship: {
      findMany: jest.fn(({ where }) =>
        where.status === 'accepted'
          ? [
              { requesterId: 2, addresseeId: 6 },
              { requesterId: 6, addresseeId: 3 },
              { requesterId: 2, addresseeId: 7 },
            ]
          : [
              { requesterId: 1, addresseeId: 2, status: 'accepted' },
              { requesterId: 3, addresseeId: 1, status: 'accepted' },
              { requesterId: 1, addresseeId: 4, status: 'pending' },
              { requesterId: 5, addresseeId: 1, status: 'pending' },
            ],
      ),
    },
    membership: {
      findMany: jest.fn(({ where }) =>
        typeof where.userId === 'number'
          ? [{ communityId: 20 }]
          : [{ userId: 8, community: { name: 'Seasonal Anime Club' } }],
      ),
      groupBy: jest.fn(() => [
        { userId: 8, _count: { userId: 2 } },
        { userId: 7, _count: { userId: 1 } },
        { userId: SUSPENDED, _count: { userId: 1 } },
      ]),
    },
    libraryEntry: {
      findMany: jest.fn(({ where }) =>
        typeof where.userId === 'number'
          ? [{ mediaId: 'anime:1' }, { mediaId: 'anime:2' }]
          : [
              {
                userId: 10,
                title: 'Sousou no Frieren',
                mediaType: 'anime',
                status: 'completed',
              },
              {
                userId: 10,
                title: 'Steins;Gate',
                mediaType: 'anime',
                status: 'current',
              },
            ],
      ),
      groupBy: jest.fn(() => [
        { userId: 10, _count: { userId: 1 } },
        { userId: SUSPENDED, _count: { userId: 3 } },
      ]),
    },
    user: {
      findUnique: jest.fn(() => ({ showNsfw: false })),
      findMany: jest.fn(({ where }) =>
        where.id.in
          .filter((id: number) => !(where.OR && id === SUSPENDED))
          .map(person),
      ),
    },
  };
}

function serviceWith(prisma: ReturnType<typeof prismaFor>) {
  return new FriendsService(
    prisma as unknown as PrismaService,
    {} as PresenceGateway,
    {} as NotificationsService,
  );
}

describe('Friend suggestions', () => {
  it('ranks mutual friends above shared communities and titles', () => {
    expect(
      rankCandidates({
        mutual: new Map([[6, [2, 3]]]),
        communities: new Map([
          [7, 1],
          [8, 2],
        ]),
        titles: new Map([
          [7, 1],
          [10, 1],
        ]),
      }),
    ).toEqual([6, 8, 7, 10]);
  });

  it('describes a shared title by what they’re doing with it', () => {
    expect(
      titleReason({ title: 'Berserk', mediaType: 'manga', status: 'current' }),
    ).toBe('Also reading Berserk');
    expect(
      titleReason({ title: 'Hades', mediaType: 'game', status: 'completed' }),
    ).toBe('Also finished Hades');
  });

  it('suggests people with a reason each, best match first', async () => {
    const suggestions = await serviceWith(prismaFor()).suggestions(1);

    expect(
      suggestions.map(({ userId, reason }) => ({ userId, reason })),
    ).toEqual([
      { userId: 6, reason: '2 mutual friends' },
      { userId: 7, reason: '1 mutual friend' },
      { userId: 8, reason: 'In Seasonal Anime Club' },
      { userId: 10, reason: 'Also watching Steins;Gate' },
    ]);
    expect(suggestions[0].mutualFriends.map(({ userId }) => userId)).toEqual([
      2, 3,
    ]);
  });

  it('leaves out the viewer, friends, pending requests, and suspended accounts', async () => {
    const prisma = prismaFor();
    const suggestions = await serviceWith(prisma).suggestions(1);

    const excluded = [1, 2, 3, 4, 5];
    expect(prisma.membership.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: { notIn: expect.arrayContaining(excluded) },
        }),
      }),
    );
    expect(prisma.libraryEntry.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: { notIn: expect.arrayContaining(excluded) },
          isPublic: true,
          isAdult: false,
        }),
      }),
    );
    expect(suggestions.map(({ userId }) => userId)).not.toContain(SUSPENDED);
  });

  it('suggests nobody when there is nothing in common', async () => {
    const prisma = prismaFor();
    prisma.friendship.findMany.mockReturnValue([]);
    prisma.membership.findMany.mockReturnValue([]);
    prisma.libraryEntry.findMany.mockReturnValue([]);

    await expect(serviceWith(prisma).suggestions(1)).resolves.toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
