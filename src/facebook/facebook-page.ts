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

async function read(response: Response, field: string) {
  const result = await response.json().catch(() => null);
  if (response.ok && typeof result?.[field] === 'string') {
    return result[field] as string;
  }
  const error = result?.error;
  if (response.status < 500 && error) {
    throw new FacebookError(
      error.message ?? `Facebook responded with ${response.status}`,
    );
  }
  throw new Error(`Facebook responded with ${response.status}`);
}

export async function pageName(page: FacebookPage) {
  const response = await fetch(`${GRAPH_API}/${page.id}?fields=name`, {
    headers: { Authorization: `Bearer ${page.token}` },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  return read(response, 'name');
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
  return read(response, 'post_id');
}
