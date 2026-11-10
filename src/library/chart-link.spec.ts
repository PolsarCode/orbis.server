import { chartPath, chartShortPath } from './chart-link';

describe('Chart links', () => {
  it('links to a chart’s discussion on the Catalog page', () => {
    expect(chartPath('anime', '2026-W46')).toBe(
      '/library?tab=charts&week=2026-W46#discussion',
    );
    expect(chartPath('game', '2026-W46')).toBe(
      '/library?tab=charts&type=game&week=2026-W46#discussion',
    );
  });

  it('keeps the short links already shared outside Orbis', () => {
    expect(chartShortPath('anime', '2026-W46')).toBe('/c/loc');
    expect(chartShortPath('manga', '2026-W46')).toBe('/c/775');
    expect(chartShortPath('game', '2026-W46')).toBe('/c/y6h');
    expect(chartShortPath('anime', '2027-W01')).toBe('/c/j6c');
  });

  it('gives every chart its own 3-character code', () => {
    const codes = new Set<string>();
    for (let year = 2020; year <= 2312; year++) {
      for (let week = 1; week <= 53; week++) {
        for (const type of ['anime', 'manga', 'game'] as const) {
          const path = chartShortPath(
            type,
            `${year}-W${String(week).padStart(2, '0')}`,
          );
          expect(path).toMatch(/^\/c\/[0-9a-z]{3}$/);
          codes.add(path);
        }
      }
    }
    expect(codes.size).toBe(293 * 53 * 3);
  });
});
