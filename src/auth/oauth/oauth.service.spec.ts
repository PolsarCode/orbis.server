import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '../../../prisma/generated/client';
import { PrismaService } from '../../prisma.service';
import { CommunitiesService } from '../../communities/communities.service';
import { PresenceGateway } from '../../friends/presence.gateway';
import { StorageService } from '../../storage/storage.service';
import { DiscordChannelService } from '../../discord-channel/discord-channel.service';
import { AuthService } from '../auth.service';
import { oauthProviders } from './oauth-providers';
import { OAuthService } from './oauth.service';

const NONCE = 'nonce-0123456789abcdef';

describe('OAuthService', () => {
  const prisma = {
    oAuthAccount: {
      findUnique: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      updateMany: jest.fn(),
    },
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    community: { findUnique: jest.fn() },
  };
  const jwt = new JwtService({ secret: 'test-secret' });
  const auth = {
    generateToken: jest.fn((id: number) => ({ access_token: `token-${id}` })),
  };
  const presence = { stopLive: jest.fn() };
  const communities = {
    assertCanManage: jest.fn(),
    connectTwitch: jest.fn(),
    connectDiscord: jest.fn(),
  };
  const storage = { uploadImage: jest.fn(), delete: jest.fn() };
  const discordChannel = { connect: jest.fn() };
  const service = new OAuthService(
    prisma as unknown as PrismaService,
    jwt,
    auth as unknown as AuthService,
    presence as unknown as PresenceGateway,
    communities as unknown as CommunitiesService,
    storage as unknown as StorageService,
    discordChannel as unknown as DiscordChannelService,
  );
  const fetchMock = jest.fn();

  function discordUser(overrides: Record<string, unknown> = {}) {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'discord-token' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: '42',
          username: 'Naruto.Uzumaki',
          global_name: 'Naruto',
          email: 'naruto@anime.test',
          verified: true,
          avatar: 'avatar-hash',
          ...overrides,
        }),
      });
  }

  function stateFor(uid: number | null, nonce = NONCE) {
    const url = new URL(service.authorizeUrl('discord', nonce, uid));
    return url.searchParams.get('state')!;
  }

  it('marks mobile authorization state without changing the web default', () => {
    const mobileUrl = new URL(
      service.authorizeUrl('discord', NONCE, null, null, 'mobile'),
    );
    const webUrl = new URL(service.authorizeUrl('discord', NONCE, null));
    const mobileState = jwt.verify(mobileUrl.searchParams.get('state')!, {
      secret: 'test-secret:oauth-state',
    });
    const webState = jwt.verify(webUrl.searchParams.get('state')!, {
      secret: 'test-secret:oauth-state',
    });

    expect(mobileState).toMatchObject({ client: 'mobile', nonce: NONCE });
    expect(webState).toMatchObject({ client: 'web', nonce: NONCE });
  });

  function uniqueViolation() {
    return new Prisma.PrismaClientKnownRequestError('Unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
  }

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.DISCORD_CLIENT_ID = 'client';
    process.env.DISCORD_CLIENT_SECRET = 'secret';
    process.env.TWITCH_CLIENT_ID = 'twitch-client';
    process.env.TWITCH_CLIENT_SECRET = 'twitch-secret';
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.oAuthAccount.findUnique.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue(null);
  });

  it('connects an existing account with the same verified email', async () => {
    discordUser();
    prisma.user.findFirst.mockResolvedValueOnce({
      id: 7,
      email: 'Naruto@Anime.test',
      emailVerifiedAt: new Date('2026-10-01T00:00:00Z'),
    });

    const result = await service.complete(
      'discord',
      { code: 'code', state: stateFor(null), nonce: NONCE },
      0,
    );

    expect(result).toEqual({ access_token: 'token-7' });
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { equals: 'naruto@anime.test', mode: 'insensitive' } },
      }),
    );
    expect(prisma.oAuthAccount.create).toHaveBeenCalledWith({
      data: {
        provider: 'discord',
        providerAccountId: '42',
        username: 'Naruto.Uzumaki',
        userId: 7,
      },
    });
  });

  it('won’t connect an account whose Orbis email isn’t confirmed', async () => {
    discordUser();
    prisma.user.findFirst.mockResolvedValueOnce({
      id: 7,
      email: 'naruto@anime.test',
      emailVerifiedAt: null,
    });

    await expect(
      service.complete(
        'discord',
        { code: 'code', state: stateFor(null), nonce: NONCE },
        0,
      ),
    ).rejects.toThrow(
      'An Orbis account already uses this email. Log in with your password, then connect Discord in Settings',
    );
    expect(prisma.oAuthAccount.create).not.toHaveBeenCalled();
  });

  it('refuses an email the provider hasn’t verified', async () => {
    discordUser({ verified: false });

    await expect(
      service.complete(
        'discord',
        { code: 'code', state: stateFor(null), nonce: NONCE },
        0,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.oAuthAccount.create).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  async function startSignup(overrides: Record<string, unknown> = {}) {
    discordUser(overrides);
    const result = await service.complete(
      'discord',
      { code: 'code', state: stateFor(null), nonce: NONCE },
      0,
    );
    if (!('signup' in result)) throw new Error('Expected a sign-up');
    return result.signup;
  }

  it('asks a new account to pick a username before creating it', async () => {
    const signup = await startSignup();

    expect(signup.username).toBe('narutouzumaki');
    expect(signup.avatarUrl).toBe(
      'https://cdn.discordapp.com/avatars/42/avatar-hash.png?size=512',
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('creates the account with the chosen username', async () => {
    const { token } = await startSignup();
    prisma.user.create.mockResolvedValueOnce({
      id: 9,
      email: 'naruto@anime.test',
    });

    const result = await service.finishSignup(token, 'Hokage_Naruto');

    expect(result).toEqual({ access_token: 'token-9' });
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          email: 'naruto@anime.test',
          emailVerifiedAt: expect.any(Date),
          username: 'hokage_naruto',
          name: 'Naruto',
          avatarUrl:
            'https://cdn.discordapp.com/avatars/42/avatar-hash.png?size=512',
          oauthAccounts: {
            create: {
              provider: 'discord',
              providerAccountId: '42',
              username: 'Naruto.Uzumaki',
            },
          },
        },
      }),
    );
  });

  it('allows a new account to decline the provider avatar', async () => {
    const { token } = await startSignup();
    prisma.user.create.mockResolvedValueOnce({
      id: 9,
      email: 'naruto@anime.test',
    });

    await service.finishSignup(token, 'Hokage_Naruto', false);

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ avatarUrl: null }),
      }),
    );
  });

  it('refuses a username someone already has', async () => {
    const { token } = await startSignup();
    prisma.user.findUnique.mockResolvedValueOnce({ id: 3 });

    await expect(service.finishSignup(token, 'naruto')).rejects.toThrow(
      ConflictException,
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('refuses a sign-up it didn’t start', async () => {
    const forged = new JwtService({ secret: 'other' }).sign({
      provider: 'discord',
      id: '42',
      username: 'naruto',
      displayName: null,
      email: 'naruto@anime.test',
    });

    await expect(service.finishSignup(forged, 'naruto')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('rejects a state from another browser', async () => {
    await expect(
      service.complete(
        'discord',
        {
          code: 'code',
          state: stateFor(null),
          nonce: 'other-0123456789abcdef',
        },
        0,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('connects only for the account that started it', async () => {
    discordUser();

    await expect(
      service.complete(
        'discord',
        { code: 'code', state: stateFor(5), nonce: NONCE },
        6,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses to connect an account another user already has', async () => {
    discordUser();
    prisma.oAuthAccount.create.mockRejectedValueOnce(uniqueViolation());
    prisma.oAuthAccount.findUnique.mockResolvedValueOnce({ userId: 99 });

    await expect(
      service.complete(
        'discord',
        { code: 'code', state: stateFor(5), nonce: NONCE },
        5,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('keeps the only way to log in', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      password: null,
      oauthAccounts: [
        { provider: 'discord', username: 'naruto', createdAt: new Date() },
      ],
    });

    await expect(service.disconnect(5, 'discord')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.oAuthAccount.delete).not.toHaveBeenCalled();
  });

  it('disconnects when a password is set', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      password: 'hash',
      oauthAccounts: [
        { provider: 'discord', username: 'naruto', createdAt: new Date() },
      ],
    });

    await service.disconnect(5, 'discord');

    expect(prisma.oAuthAccount.delete).toHaveBeenCalledWith({
      where: { userId_provider: { userId: 5, provider: 'discord' } },
    });
  });

  it('hides a live stream right away when showing it is turned off', async () => {
    prisma.oAuthAccount.updateMany.mockResolvedValueOnce({ count: 1 });

    await service.updateConnection(5, 'twitch', { showLive: false });

    expect(prisma.oAuthAccount.updateMany).toHaveBeenCalledWith({
      where: { userId: 5, provider: 'twitch' },
      data: { showLive: false },
    });
    expect(presence.stopLive).toHaveBeenCalledWith(5);
  });

  it('hides Twitch clips without touching the live badge', async () => {
    prisma.oAuthAccount.updateMany.mockResolvedValueOnce({ count: 1 });

    await service.updateConnection(5, 'twitch', { showClips: false });

    expect(prisma.oAuthAccount.updateMany).toHaveBeenCalledWith({
      where: { userId: 5, provider: 'twitch' },
      data: { showClips: false },
    });
    expect(presence.stopLive).not.toHaveBeenCalled();
  });

  it('only lets Twitch show when you’re live', async () => {
    await expect(
      service.updateConnection(5, 'discord', { showLive: true }),
    ).rejects.toThrow(BadRequestException);
  });

  it('connects a Twitch channel to a community for its admins', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'twitch-token' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: '77', login: 'seasonalclub', display_name: 'Seasonal Club' },
          ],
        }),
      });
    const url = await service.communityAuthorizeUrl(5, 'twitch', 12, NONCE);
    const state = new URL(url).searchParams.get('state')!;

    const result = await service.complete(
      'twitch',
      { code: 'code', state, nonce: NONCE },
      5,
    );

    expect(communities.assertCanManage).toHaveBeenCalledWith(5, 12);
    expect(communities.connectTwitch).toHaveBeenCalledWith(5, 12, {
      id: '77',
      login: 'seasonalclub',
    });
    expect(result).toEqual({ linked: 'twitch', communityId: 12 });
  });

  describe('Discord servers for communities', () => {
    const guilds = [
      {
        id: '900',
        name: 'Seasonal Club',
        icon: 'abc',
        owner: true,
        permissions: '0',
      },
      {
        id: '901',
        name: 'Mod Team',
        icon: null,
        owner: false,
        permissions: '32',
      },
      { id: '902', name: 'Admins', icon: null, owner: false, permissions: '8' },
      {
        id: '903',
        name: 'Just a member',
        icon: null,
        owner: false,
        permissions: '1024',
      },
    ];

    function discordWithServers(servers: unknown[] = guilds) {
      discordUser();
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => servers });
    }

    async function connectCommunity(viewer = 5) {
      const url = await service.communityAuthorizeUrl(5, 'discord', 12, NONCE);
      const state = new URL(url).searchParams.get('state')!;
      return service.complete(
        'discord',
        { code: 'code', state, nonce: NONCE },
        viewer,
      );
    }

    async function serverToken() {
      discordWithServers();
      const result = await connectCommunity();
      if (!('servers' in result) || !result.servers)
        throw new Error('Expected servers');
      return result.servers.token;
    }

    it('asks Discord for the server list only when connecting a community', async () => {
      const community = new URL(
        await service.communityAuthorizeUrl(5, 'discord', 12, NONCE),
      );
      const login = new URL(service.authorizeUrl('discord', NONCE, null));

      expect(community.searchParams.get('scope')).toBe('identify guilds');
      expect(login.searchParams.get('scope')).toBe('identify email');
      expect(communities.assertCanManage).toHaveBeenCalledWith(5, 12);
    });

    it('offers only the servers the admin owns or manages', async () => {
      discordWithServers();

      const result = await connectCommunity();

      expect(result).toEqual({
        linked: 'discord',
        communityId: 12,
        servers: {
          token: expect.any(String),
          options: [
            {
              id: '900',
              name: 'Seasonal Club',
              iconUrl: 'https://cdn.discordapp.com/icons/900/abc.png?size=64',
            },
            { id: '901', name: 'Mod Team', iconUrl: null },
            { id: '902', name: 'Admins', iconUrl: null },
          ],
        },
      });
      expect(fetchMock).toHaveBeenLastCalledWith(
        'https://discord.com/api/users/@me/guilds',
        expect.anything(),
      );
      expect(communities.connectDiscord).not.toHaveBeenCalled();
    });

    it('explains when the admin manages no servers', async () => {
      discordWithServers([guilds[3]]);

      await expect(connectCommunity()).rejects.toThrow(BadRequestException);
    });

    it('connects the server the admin picks', async () => {
      const token = await serverToken();
      communities.connectDiscord.mockResolvedValueOnce({
        online: 42,
        inviteUrl: 'https://discord.com/invite/abc',
      });

      await expect(
        service.connectDiscordServer(5, token, '901'),
      ).resolves.toEqual({
        communityId: 12,
        name: 'Mod Team',
        online: 42,
        inviteUrl: 'https://discord.com/invite/abc',
      });
      expect(communities.connectDiscord).toHaveBeenCalledWith(5, 12, {
        id: '901',
        name: 'Mod Team',
      });
    });

    it('refuses a server that wasn’t offered', async () => {
      const token = await serverToken();

      await expect(
        service.connectDiscordServer(5, token, '903'),
      ).rejects.toThrow(BadRequestException);
      expect(communities.connectDiscord).not.toHaveBeenCalled();
    });

    it('refuses a pick from another account', async () => {
      const token = await serverToken();

      await expect(
        service.connectDiscordServer(6, token, '900'),
      ).rejects.toThrow(ForbiddenException);
      expect(communities.connectDiscord).not.toHaveBeenCalled();
    });

    it('refuses a server list it didn’t make', async () => {
      const forged = new JwtService({ secret: 'other' }).sign({
        uid: 5,
        communityId: 12,
        servers: [{ id: '903', name: 'Just a member' }],
      });

      await expect(
        service.connectDiscordServer(5, forged, '903'),
      ).rejects.toThrow(BadRequestException);
      expect(communities.connectDiscord).not.toHaveBeenCalled();
    });
  });

  describe('Discord channels', () => {
    beforeEach(() => {
      prisma.community.findUnique.mockResolvedValue({ isPublic: true });
    });

    const webhook = {
      id: '111',
      token: 'hook-token',
      guild_id: '900',
      channel_id: '66',
      name: 'Orbis',
    };

    function discordWithWebhook(hook: unknown = webhook) {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'discord-token', webhook: hook }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: '42', username: 'naruto', verified: true }),
        });
    }

    function discordServer() {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: '900', name: 'Seasonal Club' }],
      });
    }

    async function connectChannel(viewer = 5) {
      const url = await service.communityAuthorizeUrl(
        5,
        'discord',
        12,
        NONCE,
        true,
      );
      const state = new URL(url).searchParams.get('state')!;
      return service.complete(
        'discord',
        { code: 'code', state, nonce: NONCE },
        viewer,
      );
    }

    it('asks Discord to add a webhook to a channel the admin picks', async () => {
      const url = new URL(
        await service.communityAuthorizeUrl(5, 'discord', 12, NONCE, true),
      );

      expect(url.searchParams.get('scope')).toBe(
        'identify guilds webhook.incoming',
      );
      expect(communities.assertCanManage).toHaveBeenCalledWith(5, 12);
    });

    it('won’t connect a channel to a private community', async () => {
      prisma.community.findUnique.mockResolvedValue({ isPublic: false });

      await expect(
        service.communityAuthorizeUrl(5, 'discord', 12, NONCE, true),
      ).rejects.toThrow(BadRequestException);
    });

    it('only connects Discord channels', async () => {
      await expect(
        service.communityAuthorizeUrl(5, 'twitch', 12, NONCE, true),
      ).rejects.toThrow(BadRequestException);
    });

    it('connects the channel Discord added the webhook to', async () => {
      discordWithWebhook();
      discordServer();

      const result = await connectChannel();

      expect(result).toEqual({ linked: 'discord', communityId: 12 });
      expect(discordChannel.connect).toHaveBeenCalledWith(
        5,
        12,
        { id: '111', token: 'hook-token', guildId: '900', channelId: '66' },
        'Seasonal Club',
      );
      expect(communities.connectDiscord).not.toHaveBeenCalled();
    });

    it('explains when Discord didn’t add a webhook', async () => {
      discordWithWebhook(null);

      await expect(connectChannel()).rejects.toThrow(BadGatewayException);
      expect(discordChannel.connect).not.toHaveBeenCalled();
    });

    it('connects only for the admin who started it', async () => {
      discordWithWebhook();

      await expect(connectChannel(6)).rejects.toThrow(ForbiddenException);
      expect(discordChannel.connect).not.toHaveBeenCalled();
    });
  });

  describe('profile pictures', () => {
    const DISCORD_PICTURE =
      'https://cdn.discordapp.com/avatars/42/abc.png?size=512';
    const STORED = 'https://files.test/avatars/new.webp';

    beforeEach(() => {
      storage.uploadImage.mockResolvedValue({
        key: 'avatars/new.webp',
        url: STORED,
      });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
    });

    function picture(ok = true) {
      fetchMock.mockResolvedValueOnce(
        ok
          ? { ok: true, arrayBuffer: async () => new ArrayBuffer(4) }
          : { ok: false, status: 404 },
      );
    }

    function connect() {
      discordUser({ avatar: 'abc' });
      return service.complete(
        'discord',
        { code: 'code', state: stateFor(5), nonce: NONCE },
        5,
      );
    }

    async function offer() {
      prisma.user.findUnique.mockResolvedValueOnce({ avatarUrl: null });
      const result = await connect();
      if (!('avatar' in result) || !result.avatar) {
        throw new Error('Expected a picture offer');
      }
      return result.avatar.token;
    }

    it('copies the Discord picture onto a new account', async () => {
      const { token } = await startSignup({ avatar: 'abc' });
      prisma.user.create.mockResolvedValueOnce({
        id: 9,
        email: 'naruto@anime.test',
      });
      picture();

      await expect(service.finishSignup(token, 'hokage')).resolves.toEqual({
        access_token: 'token-9',
      });
      expect(fetchMock).toHaveBeenLastCalledWith(
        DISCORD_PICTURE,
        expect.anything(),
      );
      expect(storage.uploadImage).toHaveBeenCalledWith(
        expect.any(Buffer),
        'avatars',
        384,
      );
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 9, avatarUrl: null },
        data: { avatarUrl: STORED },
      });
    });

    it('still creates the account when the picture can’t be fetched', async () => {
      const { token } = await startSignup({ avatar: 'abc' });
      prisma.user.create.mockResolvedValueOnce({
        id: 9,
        email: 'naruto@anime.test',
      });
      picture(false);

      await expect(service.finishSignup(token, 'hokage')).resolves.toEqual({
        access_token: 'token-9',
      });
      expect(storage.uploadImage).not.toHaveBeenCalled();
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('skips Discord’s default picture', async () => {
      const { token } = await startSignup({ avatar: null });
      prisma.user.create.mockResolvedValueOnce({
        id: 9,
        email: 'naruto@anime.test',
      });

      await service.finishSignup(token, 'hokage');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(storage.uploadImage).not.toHaveBeenCalled();
    });

    it('skips Twitch’s default picture and keeps a custom one', async () => {
      const twitchUser = (image: string) =>
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [
              { id: '77', login: 'seasonalclub', profile_image_url: image },
            ],
          }),
        });

      twitchUser(
        'https://static-cdn.jtvnw.net/user-default-pictures-uv/x-profile_image-300x300.png',
      );
      await expect(
        oauthProviders.twitch.profile('token', 'client'),
      ).resolves.toMatchObject({
        avatarUrl: null,
      });

      twitchUser(
        'https://static-cdn.jtvnw.net/jtv_user_pictures/me-profile_image-300x300.png',
      );
      await expect(
        oauthProviders.twitch.profile('token', 'client'),
      ).resolves.toMatchObject({
        avatarUrl:
          'https://static-cdn.jtvnw.net/jtv_user_pictures/me-profile_image-300x300.png',
      });
    });

    it('offers the picture when connecting to an account without one', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ avatarUrl: null });

      await expect(connect()).resolves.toEqual({
        linked: 'discord',
        avatar: { url: DISCORD_PICTURE, token: expect.any(String) },
      });
      expect(storage.uploadImage).not.toHaveBeenCalled();
    });

    it('doesn’t offer it when the account already has a picture', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        avatarUrl: 'https://files.test/mine.webp',
      });

      await expect(connect()).resolves.toEqual({ linked: 'discord' });
    });

    it('uses the offered picture once the person confirms', async () => {
      const token = await offer();
      prisma.user.findUnique.mockResolvedValueOnce({ avatarUrl: null });
      picture();

      await expect(service.useLinkedAvatar(5, token)).resolves.toEqual({
        avatarUrl: STORED,
      });
      expect(fetchMock).toHaveBeenLastCalledWith(
        DISCORD_PICTURE,
        expect.anything(),
      );
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 5, avatarUrl: null },
        data: { avatarUrl: STORED },
      });
    });

    it('refuses an offer made for another account', async () => {
      const token = await offer();

      await expect(service.useLinkedAvatar(6, token)).rejects.toThrow(
        ForbiddenException,
      );
      expect(storage.uploadImage).not.toHaveBeenCalled();
    });

    it('never replaces a picture set since the offer', async () => {
      const token = await offer();
      prisma.user.findUnique.mockResolvedValueOnce({
        avatarUrl: 'https://files.test/mine.webp',
      });

      await expect(service.useLinkedAvatar(5, token)).rejects.toThrow(
        ConflictException,
      );
      expect(storage.uploadImage).not.toHaveBeenCalled();
    });

    it('removes the copy when another picture lands first', async () => {
      const token = await offer();
      prisma.user.findUnique.mockResolvedValueOnce({ avatarUrl: null });
      prisma.user.updateMany.mockResolvedValueOnce({ count: 0 });
      picture();

      await expect(service.useLinkedAvatar(5, token)).rejects.toThrow(
        ConflictException,
      );
      expect(storage.delete).toHaveBeenCalledWith('avatars/new.webp');
    });

    it('rejects an offer it didn’t make', async () => {
      const forged = new JwtService({ secret: 'other' }).sign({
        uid: 5,
        url: 'https://example.test/picture.png',
      });

      await expect(service.useLinkedAvatar(5, forged)).rejects.toThrow(
        BadRequestException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
