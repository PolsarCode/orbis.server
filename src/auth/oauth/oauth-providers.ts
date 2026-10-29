import { AuthProvider } from '../../../prisma/generated/client';

export type OAuthProfile = {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  emailVerified: boolean;
  avatarUrl: string | null;
};

type ProviderConfig = {
  label: string;
  clientId: () => string | undefined;
  clientSecret: () => string | undefined;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  communityScope?: string;
  channelScope?: string;
  profile: (accessToken: string, clientId: string) => Promise<OAuthProfile>;
};

export type DiscordServer = {
  id: string;
  name: string;
  iconUrl: string | null;
};

const MANAGE_SERVER = BigInt(0x20);
const ADMINISTRATOR = BigInt(0x8);

export const OAUTH_TIMEOUT_MS = 10_000;

async function getJson(url: string, headers: Record<string, string>) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Request failed with ${response.status}`);
  return response.json();
}

export const oauthProviders: Record<AuthProvider, ProviderConfig> = {
  discord: {
    label: 'Discord',
    clientId: () => process.env.DISCORD_CLIENT_ID,
    clientSecret: () => process.env.DISCORD_CLIENT_SECRET,
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    scope: 'identify email',
    communityScope: 'identify guilds',
    channelScope: 'identify guilds webhook.incoming',
    profile: async (accessToken) => {
      const user = await getJson('https://discord.com/api/users/@me', {
        Authorization: `Bearer ${accessToken}`,
      });
      return {
        id: String(user.id),
        username: String(user.username),
        displayName: user.global_name ?? null,
        email: user.email ?? null,
        emailVerified: user.verified === true,
        avatarUrl:
          typeof user.avatar === 'string'
            ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=512`
            : null,
      };
    },
  },
  twitch: {
    label: 'Twitch',
    clientId: () => process.env.TWITCH_CLIENT_ID,
    clientSecret: () => process.env.TWITCH_CLIENT_SECRET,
    authorizeUrl: 'https://id.twitch.tv/oauth2/authorize',
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    scope: 'user:read:email',
    profile: async (accessToken, clientId) => {
      const { data } = await getJson('https://api.twitch.tv/helix/users', {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': clientId,
      });
      const user = data?.[0];
      if (!user) throw new Error('Twitch returned no user');
      const image =
        typeof user.profile_image_url === 'string'
          ? user.profile_image_url
          : '';
      return {
        id: String(user.id),
        username: String(user.login),
        displayName: user.display_name ?? null,
        email: user.email ?? null,
        emailVerified: Boolean(user.email),
        avatarUrl:
          image && !image.includes('user-default-pictures') ? image : null,
      };
    },
  },
};

export async function discordServerName(
  accessToken: string,
  serverId: string,
): Promise<string | null> {
  const guilds = await getJson('https://discord.com/api/users/@me/guilds', {
    Authorization: `Bearer ${accessToken}`,
  });
  if (!Array.isArray(guilds)) return null;
  const guild = guilds.find(({ id }) => String(id) === serverId);
  return guild ? String(guild.name) : null;
}

export async function discordServers(
  accessToken: string,
): Promise<DiscordServer[]> {
  const guilds = await getJson('https://discord.com/api/users/@me/guilds', {
    Authorization: `Bearer ${accessToken}`,
  });
  if (!Array.isArray(guilds)) throw new Error('Discord returned no servers');

  return guilds
    .filter((guild) => {
      const permissions = BigInt(guild.permissions ?? 0);
      return (
        guild.owner === true ||
        (permissions & MANAGE_SERVER) !== BigInt(0) ||
        (permissions & ADMINISTRATOR) !== BigInt(0)
      );
    })
    .map((guild) => ({
      id: String(guild.id),
      name: String(guild.name),
      iconUrl: guild.icon
        ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64`
        : null,
    }));
}
