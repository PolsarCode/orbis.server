import { BadGatewayException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PresenceGateway } from './presence.gateway';
import { TwitchLiveService } from './twitch-live.service';

describe('TwitchLiveService.clips', () => {
  const fetchMock = jest.fn();
  let service: TwitchLiveService;

  const token = {
    ok: true,
    json: async () => ({ access_token: 'app-token', expires_in: 3600 }),
  };
  const clip = (index: number) => ({
    id: `Clip${index}`,
    title: `Clip ${index}`,
    url: `https://clips.twitch.tv/Clip${index}`,
    thumbnail_url: `https://clips-media.example/${index}.jpg`,
    view_count: 1000 - index,
    duration: 30.5,
    creator_name: 'naruto',
    created_at: '2026-10-01T12:00:00Z',
  });
  const page = (count: number, cursor?: string) => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: Array.from({ length: count }, (_, index) => clip(index)),
      pagination: cursor ? { cursor } : {},
    }),
  });

  beforeAll(() => {
    process.env.TWITCH_CLIENT_ID = 'client';
    process.env.TWITCH_CLIENT_SECRET = 'secret';
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  beforeEach(() => {
    fetchMock.mockReset();
    service = new TwitchLiveService({} as PrismaService, {} as PresenceGateway);
  });

  it('loads a page of clips and the cursor for the next one', async () => {
    fetchMock
      .mockResolvedValueOnce(token)
      .mockResolvedValueOnce(page(12, 'next'));

    const result = await service.clips('141981764', 'prev');

    const url = new URL(fetchMock.mock.calls[1][0]);
    expect(url.pathname).toBe('/helix/clips');
    expect(url.searchParams.get('broadcaster_id')).toBe('141981764');
    expect(url.searchParams.get('first')).toBe('12');
    expect(url.searchParams.get('after')).toBe('prev');
    expect(result.nextCursor).toBe('next');
    expect(result.items[0]).toEqual({
      id: 'Clip0',
      title: 'Clip 0',
      url: 'https://clips.twitch.tv/Clip0',
      thumbnailUrl: 'https://clips-media.example/0.jpg',
      viewCount: 1000,
      duration: 30.5,
      creatorName: 'naruto',
      createdAt: '2026-10-01T12:00:00Z',
    });
  });

  it('stops paging after the last clips', async () => {
    fetchMock
      .mockResolvedValueOnce(token)
      .mockResolvedValueOnce(page(3, 'more'));

    await expect(service.clips('141981764')).resolves.toMatchObject({
      nextCursor: null,
    });
  });

  it('reuses a page it loaded recently', async () => {
    fetchMock.mockResolvedValueOnce(token).mockResolvedValueOnce(page(3));

    await service.clips('141981764');
    await service.clips('141981764');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says so when Twitch can’t be reached', async () => {
    fetchMock
      .mockResolvedValueOnce(token)
      .mockResolvedValueOnce({ ok: false, status: 503 });

    await expect(service.clips('141981764')).rejects.toThrow(
      BadGatewayException,
    );
  });
});
