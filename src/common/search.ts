export function searchContains(raw: string) {
  const query = raw.trim().slice(0, 100);
  if (query.length < 2) return null;
  return { contains: query, mode: 'insensitive' as const };
}
