import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import {
  editHistory,
  editHistorySelect,
  MAX_EDIT_HISTORY,
  recordEdit,
  requireLatest,
} from './edit-history';

const posted = new Date('2026-11-01T10:00:00Z');
const firstEdit = new Date('2026-11-01T10:05:00Z');
const secondEdit = new Date('2026-11-01T11:00:00Z');

const saved = {
  content: '<p>Frieren is a quiet show</p>',
  linkUrl: 'https://frieren.example',
  spoiler: null,
  createdAt: posted,
  editedAt: null,
};
const body = {
  content: saved.content,
  linkUrl: saved.linkUrl,
  spoiler: saved.spoiler,
};

describe('Edit history', () => {
  beforeEach(() =>
    jest.useFakeTimers({
      now: secondEdit,
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    }),
  );
  afterEach(() => jest.useRealTimers());

  it('marks it edited now and keeps the previous body, dated when it was posted if it was never edited', () => {
    expect(
      recordEdit(saved, { ...body, content: '<p>Frieren is perfect</p>' }),
    ).toEqual({
      edited: { editedAt: secondEdit },
      version: {
        content: '<p>Frieren is a quiet show</p>',
        linkUrl: 'https://frieren.example',
        spoiler: null,
        createdAt: posted,
      },
    });
  });

  it('dates the previous body by its last edit', () => {
    expect(
      recordEdit(
        { ...saved, editedAt: firstEdit },
        { ...body, spoiler: 'Episode 28' },
      ).version?.createdAt,
    ).toEqual(firstEdit);
  });

  it('keeps a version when only the link or the spoiler changes', () => {
    expect(recordEdit(saved, { ...body, linkUrl: null }).version).not.toBe(
      null,
    );
    expect(recordEdit(saved, { ...body, spoiler: '' }).version).not.toBe(null);
  });

  it('neither marks it edited nor keeps a version when the body is the same', () => {
    const nothing = { edited: {}, version: null };
    expect(recordEdit(saved, body)).toEqual(nothing);
    expect(
      recordEdit(
        { ...saved, spoiler: 'Finale' },
        { ...body, spoiler: 'Finale' },
      ),
    ).toEqual(nothing);
  });

  it('dates a real edit after an unchanged one by when the body was really published', () => {
    let current: typeof saved & { editedAt: Date | null } = saved;
    const versions: unknown[] = [];
    const edit = (next: typeof body, at: Date) => {
      jest.setSystemTime(at);
      const { edited, version } = recordEdit(current, next);
      if (version) versions.push(version);
      current = { ...current, ...next, ...edited };
    };

    edit({ ...body, content: '<p>Second</p>' }, firstEdit);
    edit(
      { ...body, content: '<p>Second</p>' },
      new Date('2026-11-01T10:30:00Z'),
    );
    edit({ ...body, content: '<p>Third</p>' }, secondEdit);

    expect(current.editedAt).toEqual(secondEdit);
    expect(versions).toEqual([
      expect.objectContaining({ content: saved.content, createdAt: posted }),
      expect.objectContaining({
        content: '<p>Second</p>',
        createdAt: firstEdit,
      }),
    ]);
  });

  it('lists the current version first, then the saved ones newest first', () => {
    const versions = [
      {
        content: '<p>Second</p>',
        linkUrl: null,
        spoiler: null,
        createdAt: firstEdit,
      },
      {
        content: '<p>First</p>',
        linkUrl: null,
        spoiler: null,
        createdAt: posted,
      },
    ];

    expect(
      editHistory({
        ...saved,
        content: '<p>Third</p>',
        editedAt: secondEdit,
        editVersions: versions,
      }),
    ).toEqual([
      {
        content: '<p>Third</p>',
        linkUrl: 'https://frieren.example',
        spoiler: null,
        createdAt: secondEdit,
      },
      ...versions,
    ]);
    expect(editHistorySelect.editVersions.orderBy).toEqual([
      { createdAt: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('returns at most the 50 newest versions, the current one included', () => {
    expect(MAX_EDIT_HISTORY).toBe(50);
    expect(editHistorySelect.editVersions.take).toBe(49);
  });

  it('refuses an edit when someone else edited it after it was read', () => {
    expect(() => requireLatest({ count: 1 })).not.toThrow();
    expect(() => requireLatest({ count: 0 })).toThrow(
      new ConflictException(
        'This was edited somewhere else. Reload and try again',
      ),
    );
  });

  it('shows only the current version, dated when it was posted, when nothing was saved', () => {
    expect(editHistory({ ...saved, editVersions: [] })).toEqual([
      { ...body, createdAt: posted },
    ]);
  });

  it('removes versions with their post, comment or forum post', () => {
    const schema = readFileSync(
      join(__dirname, '../../prisma/schema/content.prisma'),
      'utf8',
    );
    const model = /model EditVersion \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';

    for (const relation of ['post', 'comment', 'forumPost']) {
      expect(model).toMatch(
        new RegExp(
          `^\\s+${relation}\\s+\\w+\\?\\s+@relation\\(.*onDelete: Cascade\\)`,
          'm',
        ),
      );
    }
  });
});
