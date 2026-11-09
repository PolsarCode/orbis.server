import {
  deleteMessage,
  deleteWebhook,
  DiscordError,
  editMessage,
  sendMessage,
} from './discord-webhook';

describe('Discord webhooks', () => {
  const fetchMock = jest.fn();
  const webhook = { id: '111', token: 'secret-token' };

  const reply = (status: number, body: object = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  beforeAll(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  beforeEach(() => fetchMock.mockReset());

  it('sends a message and returns its id', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { id: '900', channel_id: '5' }));

    const sent = await sendMessage(webhook, { content: 'hi' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://discord.com/api/v10/webhooks/111/secret-token?wait=true&with_components=true',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ content: 'hi' });
    expect(sent).toEqual({ messageId: '900', threadId: null });
  });

  it('starts a forum post and remembers its thread', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, { id: '900', channel_id: '77' }),
    );

    const sent = await sendMessage(webhook, { content: 'hi' }, 'Best arc?');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      content: 'hi',
      thread_name: 'Best arc?',
    });
    expect(sent).toEqual({ messageId: '900', threadId: '77' });
  });

  it('attaches a file and keeps it when retrying after a rate limit', async () => {
    jest.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(reply(429, { retry_after: 0.5 }))
      .mockResolvedValueOnce(reply(200, { id: '902', channel_id: '77' }));

    const sending = sendMessage(webhook, { content: 'hi' }, 'Charts', [
      {
        filename: 'chart.png',
        data: Buffer.from('png'),
        description: 'Weekly chart',
      },
    ]);
    await jest.advanceTimersByTimeAsync(500);

    await expect(sending).resolves.toEqual({
      messageId: '902',
      threadId: '77',
    });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(
      'https://discord.com/api/v10/webhooks/111/secret-token?wait=true&with_components=true',
    );
    expect(init.headers).toBeUndefined();
    const form = init.body as FormData;
    expect(JSON.parse(form.get('payload_json') as string)).toEqual({
      content: 'hi',
      thread_name: 'Charts',
      attachments: [
        { id: 0, filename: 'chart.png', description: 'Weekly chart' },
      ],
    });
    const file = form.get('files[0]') as File;
    expect(file.name).toBe('chart.png');
    expect(await file.text()).toBe('png');
    jest.useRealTimers();
  });

  it('attaches several files to one message', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { id: '903', channel_id: '5' }));

    await sendMessage(webhook, { content: 'hi' }, undefined, [
      { filename: 'anime.png', data: Buffer.from('a'), description: 'Anime' },
      { filename: 'manga.png', data: Buffer.from('m') },
    ]);

    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(JSON.parse(form.get('payload_json') as string)).toEqual({
      content: 'hi',
      attachments: [
        { id: 0, filename: 'anime.png', description: 'Anime' },
        { id: 1, filename: 'manga.png' },
      ],
    });
    expect((form.get('files[0]') as File).name).toBe('anime.png');
    expect(await (form.get('files[1]') as File).text()).toBe('m');
  });

  it('waits and retries once when rate limited', async () => {
    jest.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(reply(429, { retry_after: 0.5 }))
      .mockResolvedValueOnce(reply(200, { id: '901', channel_id: '5' }));

    const sending = sendMessage(webhook, { content: 'hi' });
    await jest.advanceTimersByTimeAsync(500);

    await expect(sending).resolves.toEqual({
      messageId: '901',
      threadId: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('reports webhooks that were deleted in Discord', async () => {
    fetchMock.mockResolvedValueOnce(reply(404, { code: 10015 }));

    const error = await sendMessage(webhook, {}).catch((cause) => cause);

    expect(error).toBeInstanceOf(DiscordError);
    expect(error.webhookGone).toBe(true);
  });

  it('reports forum channels that need a post title', async () => {
    fetchMock.mockResolvedValueOnce(reply(400, { code: 220001 }));

    const error = await sendMessage(webhook, {}).catch((cause) => cause);

    expect(error.needsThread).toBe(true);
  });

  it('edits and deletes messages inside forum posts', async () => {
    fetchMock.mockResolvedValue(reply(200, {}));

    await editMessage(
      webhook,
      { messageId: '900', threadId: '77' },
      { embeds: [] },
    );
    await deleteMessage(webhook, { messageId: '900', threadId: '77' });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://discord.com/api/v10/webhooks/111/secret-token/messages/900?thread_id=77&with_components=true',
    );
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://discord.com/api/v10/webhooks/111/secret-token/messages/900?thread_id=77',
    );
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
  });

  it('treats messages and webhooks that are already gone as deleted', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(404, { code: 10008 }))
      .mockResolvedValueOnce(reply(404, { code: 10015 }));

    await expect(
      deleteMessage(webhook, { messageId: '900', threadId: null }),
    ).resolves.toBeUndefined();
    await expect(deleteWebhook(webhook)).resolves.toBeUndefined();
  });
});
