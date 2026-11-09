import { MediaType } from '../../prisma/generated/client';

export function chartPath(type: MediaType, week: string) {
  const params = new URLSearchParams({ tab: 'charts' });
  if (type !== MediaType.anime) params.set('type', type);
  params.set('week', week);
  return `/library?${params}#discussion`;
}
