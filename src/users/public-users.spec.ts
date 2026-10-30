import { ActiveUser, rankPublicUsers } from './users.service';

const user = (
  userId: number,
  activity: number,
  appearOffline = false,
): ActiveUser => ({
  userId,
  username: `user${userId}`,
  name: null,
  avatarUrl: null,
  coverUrl: null,
  isVerified: false,
  appearOffline,
  status: 'online',
  activity,
});

describe('rankPublicUsers', () => {
  it('puts online users first, then the most active', () => {
    const online = new Set([3, 4]);
    const ranked = rankPublicUsers(
      [user(1, 50), user(2, 10), user(3, 1), user(4, 20)],
      ({ userId }) => (online.has(userId) ? 'online' : 'offline'),
    );

    expect(ranked.map(({ userId }) => userId)).toEqual([4, 3, 1, 2]);
    expect(ranked.map(({ online }) => online)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('shows each person’s status, and treats appearing offline as offline', () => {
    const ranked = rankPublicUsers(
      [user(1, 5, true), { ...user(2, 1), status: 'busy' }, user(3, 0)],
      ({ appearOffline, status }) => (appearOffline ? 'offline' : status),
    );

    expect(ranked).toMatchObject([
      { userId: 2, online: true, status: 'busy' },
      { userId: 3, online: true, status: 'online' },
      { userId: 1, online: false, status: 'offline' },
    ]);
    expect(ranked[0]).not.toHaveProperty('appearOffline');
  });

  it('keeps only the top users', () => {
    const ranked = rankPublicUsers(
      [user(1, 1), user(2, 2), user(3, 3)],
      () => 'offline',
      2,
    );

    expect(ranked.map(({ userId }) => userId)).toEqual([3, 2]);
  });
});
