import { BadRequestException } from '@nestjs/common';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';

describe('OAuthController', () => {
  const oauth = { communityAuthorizeUrl: jest.fn() };
  const controller = new OAuthController(oauth as unknown as OAuthService);

  beforeEach(() => {
    jest.clearAllMocks();
    oauth.communityAuthorizeUrl.mockResolvedValue('https://discord.test');
  });

  it('passes the community connection target along', async () => {
    await controller.communityUrl(5, 'discord', 12, 'nonce', 'charts');
    await controller.communityUrl(5, 'discord', 12, 'nonce', 'channel');
    await controller.communityUrl(5, 'discord', 12, 'nonce');

    expect(
      oauth.communityAuthorizeUrl.mock.calls.map((call) => call[4]),
    ).toEqual(['charts', 'channel', null]);
  });

  it('refuses targets it doesn’t know', async () => {
    await expect(
      controller.communityUrl(5, 'discord', 12, 'nonce', 'server'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(oauth.communityAuthorizeUrl).not.toHaveBeenCalled();
  });
});
