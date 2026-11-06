import {
  linkedMentions,
  linkMentions,
  mentionedUsernames,
  notifyMentions,
  resolveMentions,
  unlinkMentions,
} from './mentions';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

describe('Mentions', () => {
  const prisma = {
    user: { findMany: jest.fn(), findUnique: jest.fn() },
    community: { findUnique: jest.fn() },
    friendship: { findMany: jest.fn() },
  };
  const notifications = { notify: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  function notified() {
    return notifications.notify.mock.calls.flatMap(([items]) =>
      items.map(({ userId }: { userId: number }) => userId),
    );
  }

  it('finds usernames mentioned in the text', () => {
    expect(
      mentionedUsernames(
        '<p>@Naruto and <strong>@sakura</strong>, also @naruto again.</p>',
      ),
    ).toEqual(['naruto', 'sakura']);
  });

  it('ignores emails, links, code, and names that are too short', () => {
    expect(
      mentionedUsernames(
        '<p>mail me@example.com or see https://x.com/@luffy</p>' +
          '<p><a href="https://example.com"><strong>@zoro</strong></a></p>' +
          '<pre><code>@nami</code></pre><p><code>@usopp</code> @ab</p>',
      ),
    ).toEqual([]);
  });

  it('only notices the first ten people mentioned', () => {
    const names = Array.from({ length: 12 }, (_, i) => `@user${i + 10}`);
    expect(mentionedUsernames(`<p>${names.join(' ')}</p>`)).toHaveLength(10);
  });

  it('turns saved mentions back into plain text for editing', () => {
    const saved =
      '<p>hi <a href="/users/naruto" class="mention">@Naruto</a> and <a target="_blank" href="/users/sasuke" rel="noopener">@sasuke</a> <a href="https://x.com">site</a></p>';

    expect(unlinkMentions(saved)).toBe(
      '<p>hi @Naruto and @sasuke <a href="https://x.com">site</a></p>',
    );
    expect(linkedMentions(saved)).toEqual(new Set(['naruto', 'sasuke']));
  });

  it('links mentions of people who exist', () => {
    expect(
      linkMentions('<p>Hi @Naruto and @nobody</p>', new Set(['naruto'])),
    ).toBe(
      '<p>Hi <a href="/users/naruto" class="mention">@Naruto</a> and @nobody</p>',
    );
  });

  it('leaves out the author when they mention themselves', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 1, username: 'admin' },
      { id: 5, username: 'naruto' },
    ]);

    const { mentioned } = await resolveMentions(
      prisma as unknown as PrismaService,
      '<p>@admin @naruto</p>',
      1,
    );

    expect(mentioned).toEqual([{ id: 5, username: 'naruto' }]);
  });

  it('doesn’t link or return people blocked either way', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 5, username: 'naruto' }]);

    const { html, mentioned } = await resolveMentions(
      prisma as unknown as PrismaService,
      '<p>@naruto @sasuke</p>',
      1,
    );

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        username: { in: ['naruto', 'sasuke'] },
        blocksMade: { none: { blockedId: 1 } },
        blocksReceived: { none: { blockerId: 1 } },
      },
      select: { id: true, username: true },
    });
    expect(html).toBe(
      '<p><a href="/users/naruto" class="mention">@naruto</a> @sasuke</p>',
    );
    expect(mentioned).toEqual([{ id: 5, username: 'naruto' }]);
  });

  async function notify(
    place: Parameters<typeof notifyMentions>[2]['place'],
    alreadyNotified: number[] = [],
  ) {
    await notifyMentions(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
      {
        mentioned: [
          { id: 5, username: 'naruto' },
          { id: 6, username: 'sakura' },
        ],
        authorId: 1,
        place,
        message: 'mentioned you in a post',
        link: '/communities/3',
        alreadyNotified,
      },
    );
  }

  it('only notifies members of a private community', async () => {
    prisma.community.findUnique.mockResolvedValue({
      isPublic: false,
      memberships: [{ userId: 6 }],
    });

    await notify({ communityId: 3, wallUserId: null });

    expect(notified()).toEqual([6]);
    expect(notifications.notify).toHaveBeenCalledWith([
      {
        userId: 6,
        actorId: 1,
        type: 'mention',
        message: 'mentioned you in a post',
        link: '/communities/3',
      },
    ]);
  });

  it('notifies everyone mentioned in a public community', async () => {
    prisma.community.findUnique.mockResolvedValue({
      isPublic: true,
      memberships: [],
    });

    await notify({ communityId: 3, wallUserId: null });

    expect(notified()).toEqual([5, 6]);
  });

  it('only notifies the owner and their friends on a private wall', async () => {
    prisma.user.findUnique.mockResolvedValue({ isPublic: false });
    prisma.friendship.findMany.mockResolvedValue([
      { requesterId: 6, addresseeId: 9 },
    ]);

    await notify({ communityId: null, wallUserId: 9 });

    expect(notified()).toEqual([6]);
  });

  it('only notifies the owner of a private library update', async () => {
    await notify({ communityId: null, wallUserId: null, onlyUserId: 5 });

    expect(notified()).toEqual([5]);
  });

  it('skips people who were already notified about the same thing', async () => {
    await notify({ communityId: null, wallUserId: null }, [5]);

    expect(notified()).toEqual([6]);
  });
});
