import {
  activityMessage,
  connectedMessage,
  escapeMarkdown,
  plainText,
  postMessage,
  webhookName,
} from './discord-message';

const community = {
  id: 7,
  name: 'Hidden Leaf Village',
  iconUrl: '/images/communities/hidden-leaf-village.webp',
};
const author = {
  username: 'naruto',
  name: 'Naruto Uzumaki',
  nickname: null,
  avatarUrl: 'https://cdn.orbis.test/avatars/naruto.webp',
};
const createdAt = new Date('2026-10-28T12:00:00Z');

describe('Discord messages', () => {
  const previous = process.env.WEB_URL;

  beforeAll(() => {
    process.env.WEB_URL = 'https://orbis.test';
  });

  afterAll(() => {
    process.env.WEB_URL = previous;
  });

  it('posts under the author’s name and picture with a link to the post', () => {
    const message = postMessage(
      {
        id: 12,
        content: '<p>Believe it!</p>',
        linkUrl: null,
        createdAt,
        author,
      },
      community,
    );

    expect(message.identity).toEqual({
      username: 'Naruto Uzumaki',
      avatar_url: 'https://cdn.orbis.test/avatars/naruto.webp',
    });
    expect(message.body.allowed_mentions).toEqual({ parse: [] });
    expect(message.body.embeds[0]).toMatchObject({
      description: 'Believe it!',
      url: 'https://orbis.test/communities/7?post=12',
      footer: {
        text: 'Posted in Hidden Leaf Village on Orbis',
        icon_url:
          'https://orbis.test/images/communities/hidden-leaf-village.webp',
      },
    });
    expect(message.body.components).toEqual([
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: 'View more on Orbis',
            url: 'https://orbis.test/communities/7?post=12',
          },
        ],
      },
    ]);
  });

  it('shortens long posts and keeps the link button', () => {
    const message = postMessage(
      {
        id: 12,
        content: `<p>${'a'.repeat(800)}</p>`,
        linkUrl: 'https://tenor.com/view/dance-123',
        createdAt,
        author,
      },
      community,
    );
    const { description } = message.body.embeds[0] as { description: string };

    expect(description).toHaveLength(500);
    expect(description.endsWith('…')).toBe(true);
    expect(message.body.content).toBe('https://tenor.com/view/dance-123');
    expect(message.body.components).toHaveLength(1);
  });

  it('uses the community nickname, then the name, then the username', () => {
    expect(webhookName({ ...author, nickname: 'Hokage' })).toBe('Hokage');
    expect(webhookName({ ...author, name: null })).toBe('naruto');
    expect(webhookName({ ...author, name: 'Discord Mod' })).toBe('naruto');
    expect(
      webhookName({ ...author, name: 'clyde', username: 'discordfan' }),
    ).toBe('Orbis');
  });

  it('falls back to the community icon when the author has no picture', () => {
    const message = postMessage(
      {
        id: 1,
        content: '<p>Hi</p>',
        linkUrl: null,
        createdAt,
        author: { ...author, avatarUrl: null },
      },
      community,
    );

    expect(message.identity.avatar_url).toBe(
      'https://orbis.test/images/communities/hidden-leaf-village.webp',
    );
  });

  it('keeps paragraphs, decodes entities, and escapes Discord formatting', () => {
    expect(
      plainText(
        '<p>Tom &amp; Jerry</p><p>2 &lt; 3<br>next</p><ul><li>one</li></ul>',
      ),
    ).toBe('Tom & Jerry\n2 < 3\nnext\n• one');
    expect(escapeMarkdown('**bold** [x](y) see https://a.test/x_y')).toBe(
      '\\*\\*bold\\*\\* \\[x\\](y) see https://a.test/x_y',
    );
  });

  it('describes library progress with the cover', () => {
    const message = activityMessage(
      {
        id: 30,
        status: 'current',
        progressFrom: 3,
        progressTo: 7,
        createdAt,
        author,
        media: {
          type: 'anime',
          title: 'Frieren',
          coverImage: 'https://img.anili.st/frieren.jpg',
        },
      },
      community,
    );

    expect(message.body.embeds[0]).toMatchObject({
      description: 'Watched episodes 3–7 of **Frieren**',
      thumbnail: { url: 'https://img.anili.st/frieren.jpg' },
      url: 'https://orbis.test/communities/7?activity=30',
    });
    expect(message.threadName).toBe(
      'Naruto Uzumaki watched episodes 3–7 of Frieren',
    );
  });

  it('describes status changes', () => {
    const message = activityMessage(
      {
        id: 31,
        status: 'on_hold',
        progressFrom: null,
        progressTo: null,
        createdAt,
        author,
        media: { type: 'manga', title: 'Berserk', coverImage: null },
      },
      community,
    );

    expect(message.body.embeds[0]).toMatchObject({
      description: 'Put **Berserk** on hold',
    });
  });

  it('announces the connection as the community', () => {
    const message = connectedMessage(community);

    expect(message.identity.username).toBe('Hidden Leaf Village');
    expect(message.body.embeds[0]).toMatchObject({
      title: 'Connected to Orbis',
      url: 'https://orbis.test/communities/7',
      description:
        'New posts and library updates from **Hidden Leaf Village** on Orbis will show up here.',
    });
  });
});
