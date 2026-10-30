export const COMMUNITY_PIN_LIMIT = 1;
export const WALL_PIN_LIMIT = 3;

export function pinLimit(post: { communityId: number | null }) {
  return post.communityId !== null ? COMMUNITY_PIN_LIMIT : WALL_PIN_LIMIT;
}

export function pinLimitMessage(limit: number) {
  return limit === 1
    ? 'Only 1 post can be pinned here. Unpin it first'
    : `Up to ${limit} posts can be pinned here. Unpin one first`;
}
