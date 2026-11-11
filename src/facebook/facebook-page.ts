import { ChartImage } from '../library/chart-share.service';

const GRAPH_API = 'https://graph.facebook.com/v27.0';
const POST_TIMEOUT_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 10_000;

export type FacebookPage = { id: string; token: string };

export const NOT_SET_UP =
  'Facebook isn’t set up. Add FACEBOOK_PAGE_ID and FACEBOOK_PAGE_TOKEN to the server’s settings';

export function facebookPage(): FacebookPage | null {
  const id = process.env.FACEBOOK_PAGE_ID?.trim();
  const token = process.env.FACEBOOK_PAGE_TOKEN?.trim();
  return id && token ? { id, token } : null;
}

export class FacebookError extends Error {}

const isString = (value: unknown): value is string => typeof value === 'string';

const isCount = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

async function read<T>(
  response: Response,
  field: string,
  valid: (value: unknown) => value is T,
): Promise<T> {
  const result = await response.json().catch(() => null);
  if (response.ok && valid(result?.[field])) return result[field];
  const error = result?.error;
  if (response.status < 500 && error) {
    throw new FacebookError(
      error.message ?? `Facebook responded with ${response.status}`,
    );
  }
  throw new Error(`Facebook responded with ${response.status}`);
}

async function lookup<T>(
  page: FacebookPage,
  field: string,
  valid: (value: unknown) => value is T,
) {
  const response = await fetch(`${GRAPH_API}/${page.id}?fields=${field}`, {
    headers: { Authorization: `Bearer ${page.token}` },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  return read(response, field, valid);
}

export function pageName(page: FacebookPage) {
  return lookup(page, 'name', isString);
}

export function pageFollowers(page: FacebookPage) {
  return lookup(page, 'followers_count', isCount);
}

export async function postPhoto(
  page: FacebookPage,
  image: Pick<ChartImage, 'filename' | 'data'>,
  message: string,
) {
  const form = new FormData();
  form.append('message', message);
  form.append('access_token', page.token);
  form.append(
    'source',
    new Blob([new Uint8Array(image.data)], { type: 'image/png' }),
    image.filename,
  );
  const response = await fetch(`${GRAPH_API}/${page.id}/photos`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  return read(response, 'post_id', isString);
}
