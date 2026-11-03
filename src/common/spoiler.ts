export const SPOILER_MAX = 100;

export function spoilerOf(value?: string | null) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : null;
}
