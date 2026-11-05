import {
  addHashtags,
  hashtagName,
  hashtagsIn,
  linkHashtags,
  replaceHashtags,
  resolveHashtags,
  unlinkHashtags,
} from './hashtags';
import { PrismaService } from '../prisma.service';

const names = (html: string) => hashtagsIn(html).map(({ name }) => name);

describe('Finding hashtags', () => {
  it('finds tags at the start, after spaces and after punctuation', () => {
    expect(
      names('<p>#Frieren is great (#anime), "#Fall2026"! &#39;#quote</p>'),
    ).toEqual(['frieren', 'anime', 'fall2026', 'quote']);
  });

  it('treats different casing as the same tag and keeps the first casing', () => {
    expect(hashtagsIn('<p>#Frieren and #FRIEREN and #frieren</p>')).toEqual([
      { name: 'frieren', display: 'Frieren' },
    ]);
  });

  it('accepts letters from any language, marks, numbers and underscores', () => {
    expect(names('<p>#フリーレン #café #naïve_2 #Ünïcödé</p>')).toEqual([
      'フリーレン',
      'café',
      'naïve_2',
      'ünïcödé',
    ]);
  });

  it('stores names NFC-normalized so composed and decomposed letters match', () => {
    const decomposed = 'café';
    expect(names(`<p>#${decomposed} #café</p>`)).toEqual(['café']);
    expect(names(`<p>#${decomposed}</p>`)[0]).toBe('café');
  });

  it('needs at least one letter', () => {
    expect(names('<p>We’re #1 and #2026 and #___</p>')).toEqual([]);
    expect(names('<p>#1st place</p>')).toEqual(['1st']);
  });

  it('ignores # after letters, numbers, underscores, & and /', () => {
    expect(
      names(
        '<p>C#9 and F#minor, x_#tag, 3#tag, &#39; &#x27; &amp;#nope ' +
          'https://example.com/#/route and site.com/page#anchor</p>',
      ),
    ).toEqual([]);
  });

  it('skips text inside links, code and pre blocks', () => {
    expect(
      names(
        '<p><a href="https://x.com">#linked</a> <code>#code</code></p>' +
          '<pre><strong>#pre</strong></pre><p>#kept</p>',
      ),
    ).toEqual(['kept']);
  });

  it('allows 1 to 50 characters and ignores longer runs entirely', () => {
    const fifty = 'a'.repeat(50);
    expect(names(`<p>#a #${fifty} #${fifty}b</p>`)).toEqual(['a', fifty]);
  });

  it('counts at most 10 distinct tags per item', () => {
    const html = `<p>${Array.from({ length: 12 }, (_, i) => `#tag${String.fromCharCode(97 + i)}`).join(' ')}</p>`;
    expect(names(html)).toHaveLength(10);
    expect(names(html)).not.toContain('tagk');
  });
});

describe('Checking a tag name', () => {
  it('normalizes valid names and refuses the rest', () => {
    expect(hashtagName('Frieren')).toBe('frieren');
    expect(hashtagName('café')).toBe('café');
    expect(hashtagName('1')).toBeNull();
    expect(hashtagName('#frieren')).toBeNull();
    expect(hashtagName('two words')).toBeNull();
    expect(hashtagName('a'.repeat(51))).toBeNull();
    expect(hashtagName('')).toBeNull();
  });
});

describe('Linking and unlinking hashtags', () => {
  it('links every use of the counted tags as typed, with an encoded href', () => {
    expect(
      linkHashtags(
        '<p>#Frieren #フリーレン #frieren</p>',
        new Set(['frieren', 'フリーレン']),
      ),
    ).toBe(
      '<p><a href="/tags/frieren" class="hashtag">#Frieren</a> ' +
        `<a href="/tags/${encodeURIComponent('フリーレン')}" class="hashtag">#フリーレン</a> ` +
        '<a href="/tags/frieren" class="hashtag">#frieren</a></p>',
    );
  });

  it('leaves tags past the limit as plain text', () => {
    const tags = Array.from(
      { length: 11 },
      (_, i) => `#tag${String.fromCharCode(97 + i)}`,
    );
    const { html, hashtags } = resolveHashtags(`<p>${tags.join(' ')}</p>`);
    expect(hashtags).toHaveLength(10);
    expect(html).toContain('<a href="/tags/taga" class="hashtag">#taga</a>');
    expect(html).toContain(' #tagk</p>');
  });

  it('leaves mention links alone', () => {
    const mention = '<a href="/users/naruto" class="mention">@naruto</a>';
    expect(resolveHashtags(`<p>${mention} #ramen</p>`).html).toBe(
      `<p>${mention} <a href="/tags/ramen" class="hashtag">#ramen</a></p>`,
    );
  });

  it('turns hashtag links back into text before an edit, keeping other links', () => {
    const html =
      '<p><a target="_blank" href="/tags/frieren" class="hashtag">#Frieren</a> ' +
      '<a href="https://example.com">#site</a> ' +
      '<a href="/users/naruto" class="mention">@naruto</a></p>';
    expect(unlinkHashtags(html)).toBe(
      '<p>#Frieren <a href="https://example.com">#site</a> ' +
        '<a href="/users/naruto" class="mention">@naruto</a></p>',
    );
  });

  it('gives the same result when linked content is unlinked and linked again', () => {
    const first = resolveHashtags('<p>#Frieren and #Himmel</p>');
    expect(resolveHashtags(unlinkHashtags(first.html))).toEqual(first);
  });
});

describe('Saving hashtag uses', () => {
  const prisma = {
    hashtag: {
      upsert: jest.fn(({ where }: { where: { name: string } }) =>
        Promise.resolve({ id: where.name === 'frieren' ? 1 : 2 }),
      ),
    },
    hashtagUsage: { createMany: jest.fn(), deleteMany: jest.fn() },
    $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
  };
  const db = prisma as unknown as PrismaService;
  const createdAt = new Date('2026-11-05T00:00:00Z');
  const hashtags = [
    { name: 'frieren', display: 'Frieren' },
    { name: 'himmel', display: 'HIMMEL' },
  ];

  beforeEach(() => jest.clearAllMocks());

  it('creates missing tags, updates their casing, and records each use', async () => {
    await addHashtags(
      db,
      { commentId: 5, targetPostId: 7, targetActivityId: null },
      { authorId: 3, createdAt },
      hashtags,
    );

    expect(prisma.hashtag.upsert).toHaveBeenCalledWith({
      where: { name: 'himmel' },
      create: { name: 'himmel', display: 'HIMMEL' },
      update: { display: 'HIMMEL' },
      select: { id: true },
    });
    expect(prisma.hashtagUsage.createMany).toHaveBeenCalledWith({
      data: [1, 2].map((hashtagId) => ({
        hashtagId,
        commentId: 5,
        targetPostId: 7,
        targetActivityId: null,
        authorId: 3,
        createdAt,
      })),
      skipDuplicates: true,
    });
  });

  it('does nothing for new content without tags', async () => {
    await addHashtags(db, { postId: 1 }, { authorId: 3, createdAt }, []);
    expect(prisma.hashtag.upsert).not.toHaveBeenCalled();
    expect(prisma.hashtagUsage.createMany).not.toHaveBeenCalled();
  });

  it('replaces the uses of edited content, even when no tags are left', async () => {
    await replaceHashtags(
      db,
      { forumPostId: 4 },
      { authorId: 3, createdAt },
      hashtags.slice(0, 1),
    );
    expect(prisma.hashtagUsage.deleteMany).toHaveBeenCalledWith({
      where: { forumPostId: 4 },
    });
    expect(prisma.hashtagUsage.createMany).toHaveBeenCalledWith({
      data: [{ hashtagId: 1, forumPostId: 4, authorId: 3, createdAt }],
    });

    jest.clearAllMocks();
    await replaceHashtags(db, { postId: 8 }, { authorId: 3, createdAt }, []);
    expect(prisma.hashtagUsage.deleteMany).toHaveBeenCalledWith({
      where: { postId: 8 },
    });
    expect(prisma.hashtagUsage.createMany).toHaveBeenCalledWith({ data: [] });
  });
});
