import {
  compilePhrases,
  expiryOf,
  filteredPhrase,
  normalizePhrase,
} from './keywords';

function filtered(
  phrases: string[],
  html: string,
  ...notes: (string | null)[]
) {
  return filteredPhrase(compilePhrases(phrases), html, ...notes);
}

describe('Keyword filters', () => {
  it('stores phrases trimmed, lowercased and in one form', () => {
    expect(normalizePhrase('  Final   ARC ')).toBe('final arc');
    expect(normalizePhrase('Café')).toBe('café');
    expect(normalizePhrase('   ')).toBe('');
  });

  it('matches whole words only, ignoring case', () => {
    expect(filtered(['art'], '<p>Art!</p>')).toBe('art');
    expect(filtered(['art'], '<p>I love ART</p>')).toBe('art');
    expect(filtered(['art'], '<p>Let’s start</p>')).toBeNull();
    expect(filtered(['art'], '<p>artistic</p>')).toBeNull();
    expect(filtered(['art'], '<p>art_club</p>')).toBeNull();
    expect(filtered(['art'], '<p>art2</p>')).toBeNull();
  });

  it('matches phrases across spacing and line breaks', () => {
    expect(filtered(['final arc'], '<p>The final</p><p>arc is wild</p>')).toBe(
      'final arc',
    );
    expect(filtered(['final arc'], '<p>final   arc</p>')).toBe('final arc');
  });

  it('matches hashtags, and plain words inside hashtags', () => {
    const html =
      '<p>Watching <a href="/tags/frieren" class="hashtag">#Frieren</a></p>';
    expect(filtered(['#frieren'], html)).toBe('#frieren');
    expect(filtered(['frieren'], html)).toBe('frieren');
    expect(filtered(['#frieren'], '<p>frieren</p>')).toBeNull();
  });

  it('reads text without tags, with entities decoded', () => {
    expect(filtered(['tom & jerry'], '<p>Tom &amp; Jerry</p>')).toBe(
      'tom & jerry',
    );
    expect(filtered(['strong'], '<p><strong>hi</strong></p>')).toBeNull();
    expect(filtered(['nbsp'], '<p>a&nbsp;b</p>')).toBeNull();
  });

  it('checks the spoiler note too', () => {
    expect(filtered(['episode 12'], '<p>No words</p>', 'Episode 12')).toBe(
      'episode 12',
    );
    expect(filtered(['episode 12'], '<p>No words</p>', null)).toBeNull();
  });

  it('treats special characters in a phrase literally', () => {
    expect(filtered(['c++'], '<p>I write C++ daily</p>')).toBe('c++');
    expect(filtered(['a.b'], '<p>axb</p>')).toBeNull();
  });

  it('returns the first matching phrase, or nothing without filters', () => {
    expect(filtered(['zoro', 'luffy'], '<p>Luffy and Zoro</p>')).toBe('zoro');
    expect(filtered([], '<p>anything</p>')).toBeNull();
  });

  it('matches Chinese, Japanese and Korean phrases inside longer text', () => {
    expect(filtered(['葬送'], '<p>葬送のフリーレン最高</p>')).toBe('葬送');
    expect(filtered(['フリーレン'], '<p>今日はフリーレンを見た</p>')).toBe(
      'フリーレン',
    );
    expect(filtered(['ねたばれ'], '<p>これはねたばれです</p>')).toBe(
      'ねたばれ',
    );
    expect(filtered(['스포'], '<p>스포일러 주의</p>')).toBe('스포');
    expect(filtered(['葬送'], '<p>Frieren</p>')).toBeNull();
  });

  it('builds each phrase’s pattern once for every item it checks', () => {
    const matchers = compilePhrases(['art', '葬送']);
    expect(matchers.map(({ phrase }) => phrase)).toEqual(['art', '葬送']);
    const patterns = matchers.map(({ pattern }) => pattern);

    expect(filteredPhrase(matchers, '<p>Art!</p>')).toBe('art');
    expect(filteredPhrase(matchers, '<p>葬送のフリーレン</p>')).toBe('葬送');
    expect(filteredPhrase(matchers, '<p>start</p>')).toBeNull();
    expect(matchers.map(({ pattern }) => pattern)).toEqual(patterns);
  });

  it('sets the expiry from the chosen duration', () => {
    const now = new Date('2026-11-06T12:00:00Z');
    expect(expiryOf('forever', now)).toBeNull();
    expect(expiryOf('day', now)).toEqual(new Date('2026-11-07T12:00:00Z'));
    expect(expiryOf('week', now)).toEqual(new Date('2026-11-13T12:00:00Z'));
    expect(expiryOf('month', now)).toEqual(new Date('2026-12-06T12:00:00Z'));
  });
});
