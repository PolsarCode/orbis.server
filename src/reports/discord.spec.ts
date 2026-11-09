import { Logger } from '@nestjs/common';
import {
  postReportToDiscord,
  postActivityToDiscord,
  type DiscordReport,
} from './discord';
import { renderReportCard } from './report-card';

jest.mock('./report-card', () => ({ renderReportCard: jest.fn() }));
const render = jest.mocked(renderReportCard);
const report: DiscordReport = {
  id: 42,
  category: 'bug',
  status: 'todo',
  message: 'A ticket',
  pageUrl: null,
  createdAt: new Date('2026-10-24T12:00:00Z'),
  author: { username: 'reader', name: null, avatarUrl: null },
  assignee: null,
  hiddenAt: null,
  resolutionNote: null,
};
const target = {
  webhookUrl: 'https://discord.test/webhook',
  siteUrl: 'https://orbis.test',
};

describe('Discord ticket delivery', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock;
    fetchMock.mockResolvedValue({ ok: true });
    render.mockResolvedValue(Buffer.from('png'));
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('attaches the PNG directly to the embed without a public image URL', async () => {
    await postReportToDiscord(target, report);
    const options = fetchMock.mock.calls[0][1];
    expect(options.headers).toBeUndefined();
    const form = options.body as FormData;
    const body = JSON.parse(form.get('payload_json') as string);
    expect(body.embeds[0].image.url).toBe('attachment://ticket-42.png');
    expect(body.attachments[0]).toMatchObject({
      id: 0,
      filename: 'ticket-42.png',
    });
    expect((form.get('files[0]') as File).name).toBe('ticket-42.png');
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.components).toHaveLength(1);
  });

  it('retains the file in the compatibility fallback and only renders once', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ code: 50035 }),
    });
    await postReportToDiscord(target, report);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalledTimes(1);
    const form = fetchMock.mock.calls[1][1].body as FormData;
    const body = JSON.parse(form.get('payload_json') as string);
    expect(body.components).toBeUndefined();
    expect(body.embeds[0].image.url).toBe('attachment://ticket-42.png');
    expect(await (form.get('files[0]') as File).text()).toBe('png');
  });

  it('sends text and logs a warning when image generation fails', async () => {
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    render.mockRejectedValueOnce(new Error('Renderer unavailable'));
    await postReportToDiscord(target, report);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.embeds[0].description).toBe(report.message);
    expect(body.embeds[0].image).toBeUndefined();
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });

  it('includes activity details and its ticket snapshot', async () => {
    await postActivityToDiscord(target, {
      report,
      actor: report.author,
      path: '/reports?report=42',
      title: 'Reader commented',
      description: 'More detail',
      color: 1,
    });
    expect(render).toHaveBeenCalledWith(report, {
      title: 'Reader commented',
      description: 'More detail',
    });
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(
      JSON.parse(form.get('payload_json') as string).embeds[0].image.url,
    ).toBe('attachment://ticket-42.png');
  });

  it('keeps moderation notifications text only', async () => {
    await postActivityToDiscord(target, {
      actor: report.author,
      path: '/reports?tab=reported',
      title: 'Content reported',
      color: 1,
    });
    expect(render).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
    });
  });
});
