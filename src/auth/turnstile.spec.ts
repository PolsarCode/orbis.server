import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { verifyTurnstile } from './turnstile';

describe('verifyTurnstile', () => {
  const fetchMock = jest.fn();
  const realFetch = global.fetch;
  const realSecret = process.env.TURNSTILE_SECRET_KEY;

  beforeAll(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
    if (realSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = realSecret;
  });

  beforeEach(() => {
    fetchMock.mockReset();
    process.env.TURNSTILE_SECRET_KEY = 'secret-key';
  });

  it('skips the check when no secret key is set', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;

    await expect(
      verifyTurnstile(undefined, '203.0.113.7'),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a request without a token', async () => {
    await expect(
      verifyTurnstile(undefined, '203.0.113.7'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks Cloudflare about the token and the visitor’s address', async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ success: true }) });

    await expect(
      verifyTurnstile('token', '203.0.113.7'),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      secret: 'secret-key',
      response: 'token',
      remoteip: '203.0.113.7',
    });
  });

  it('refuses a token Cloudflare rejects', async () => {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({
        success: false,
        'error-codes': ['timeout-or-duplicate'],
      }),
    });

    await expect(
      verifyTurnstile('token', '203.0.113.7'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses the request when Cloudflare can’t be reached', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));

    await expect(
      verifyTurnstile('token', '203.0.113.7'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
