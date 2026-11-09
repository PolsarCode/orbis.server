export type Webhook = { id: string; token: string };

export type SentMessage = { messageId: string; threadId: string | null };

export type WebhookFile = {
  filename: string;
  data: Buffer;
  description?: string;
};

const API = 'https://discord.com/api/v10/webhooks';
const TIMEOUT_MS = 10_000;
const MAX_RETRY_MS = 10_000;

const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_WEBHOOK = 10015;
const INVALID_FORM_BODY = 50035;
const INVALID_WEBHOOK_TOKEN = 50027;
const FORUM_NEEDS_THREAD = 220001;

export class DiscordError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
  ) {
    super(
      `Discord responded with ${status}${code === null ? '' : ` (code ${code})`}`,
    );
  }

  get webhookGone() {
    return this.code === UNKNOWN_WEBHOOK || this.code === INVALID_WEBHOOK_TOKEN;
  }

  get messageGone() {
    return this.code === UNKNOWN_MESSAGE || this.code === UNKNOWN_CHANNEL;
  }

  get needsThread() {
    return this.code === FORUM_NEEDS_THREAD;
  }

  get invalidBody() {
    return this.code === INVALID_FORM_BODY;
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(
  url: string,
  init: { method: string; body?: object },
  retried = false,
): Promise<Response> {
  const response = await fetch(url, {
    method: init.method,
    ...(init.body instanceof FormData
      ? { body: init.body }
      : init.body && {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(init.body),
        }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.ok) return response;

  const error = await response.json().catch(() => ({}));
  if (response.status === 429 && !retried) {
    const seconds = Number(error.retry_after);
    await wait(
      Math.min((Number.isFinite(seconds) ? seconds : 1) * 1000, MAX_RETRY_MS),
    );
    return request(url, init, true);
  }
  throw new DiscordError(
    response.status,
    typeof error.code === 'number' ? error.code : null,
  );
}

const webhookUrl = (webhook: Webhook, path: string) =>
  `${API}/${webhook.id}/${webhook.token}${path}`;

function query(params: Record<string, string | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) search.set(key, value);
  }
  return search.size ? `?${search}` : '';
}

function withFiles(body: object, files: WebhookFile[]) {
  const form = new FormData();
  form.append(
    'payload_json',
    JSON.stringify({
      ...body,
      attachments: files.map(({ filename, description }, id) => ({
        id,
        filename,
        ...(description && { description }),
      })),
    }),
  );
  files.forEach(({ filename, data }, index) =>
    form.append(
      `files[${index}]`,
      new Blob([new Uint8Array(data)], { type: 'image/png' }),
      filename,
    ),
  );
  return form;
}

export function postToWebhook(
  url: string,
  body: object,
  files: WebhookFile[] = [],
) {
  return request(url, {
    method: 'POST',
    body: files.length ? withFiles(body, files) : body,
  });
}

export async function sendMessage(
  webhook: Webhook,
  body: object,
  threadName?: string,
  files?: WebhookFile[],
): Promise<SentMessage> {
  const response = await postToWebhook(
    webhookUrl(webhook, query({ wait: 'true', with_components: 'true' })),
    threadName ? { ...body, thread_name: threadName } : body,
    files,
  );
  const message = await response.json();
  return {
    messageId: String(message.id),
    threadId: threadName ? String(message.channel_id) : null,
  };
}

export async function editMessage(
  webhook: Webhook,
  { messageId, threadId }: SentMessage,
  body: object,
) {
  await request(
    webhookUrl(
      webhook,
      `/messages/${messageId}${query({ thread_id: threadId, with_components: 'true' })}`,
    ),
    { method: 'PATCH', body },
  );
}

export async function deleteMessage(
  webhook: Webhook,
  { messageId, threadId }: SentMessage,
) {
  try {
    await request(
      webhookUrl(
        webhook,
        `/messages/${messageId}${query({ thread_id: threadId })}`,
      ),
      { method: 'DELETE' },
    );
  } catch (error) {
    if (!(error instanceof DiscordError && error.messageGone)) throw error;
  }
}

export async function deleteWebhook(webhook: Webhook) {
  try {
    await request(webhookUrl(webhook, ''), { method: 'DELETE' });
  } catch (error) {
    if (!(error instanceof DiscordError && error.webhookGone)) throw error;
  }
}
