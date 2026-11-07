import { ConflictException } from '@nestjs/common';
import { EditVersion } from '../../prisma/generated/client';

type Version = Pick<
  EditVersion,
  'content' | 'linkUrl' | 'spoiler' | 'createdAt'
>;

type Body = Omit<Version, 'createdAt'>;

type Editable = Version & { editedAt: Date | null };

export type EditHistory = Version[];

export const MAX_EDIT_HISTORY = 50;

const versionSelect = {
  content: true,
  linkUrl: true,
  spoiler: true,
  createdAt: true,
} as const;

export const editableSelect = { ...versionSelect, editedAt: true } as const;

export const editHistorySelect = {
  ...editableSelect,
  editVersions: {
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: MAX_EDIT_HISTORY - 1,
    select: versionSelect,
  },
};

export function recordEdit(saved: Editable, next: Body) {
  if (
    saved.content === next.content &&
    saved.linkUrl === next.linkUrl &&
    saved.spoiler === next.spoiler
  ) {
    return { edited: {}, version: null };
  }
  return {
    edited: { editedAt: new Date() },
    version: {
      content: saved.content,
      linkUrl: saved.linkUrl,
      spoiler: saved.spoiler,
      createdAt: saved.editedAt ?? saved.createdAt,
    },
  };
}

export function requireLatest({ count }: { count: number }) {
  if (count === 0) {
    throw new ConflictException(
      'This was edited somewhere else. Reload and try again',
    );
  }
}

export function editHistory({
  editVersions,
  editedAt,
  ...current
}: Editable & { editVersions: Version[] }): EditHistory {
  return [
    {
      content: current.content,
      linkUrl: current.linkUrl,
      spoiler: current.spoiler,
      createdAt: editedAt ?? current.createdAt,
    },
    ...editVersions,
  ];
}
