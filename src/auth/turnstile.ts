import {
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;

const logger = new Logger('Turnstile');
let warnedMissingSecret = false;

export async function verifyTurnstile(
  token: string | undefined,
  remoteIp?: string,
) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (process.env.NODE_ENV === 'production' && !warnedMissingSecret) {
      warnedMissingSecret = true;
      logger.warn(
        'TURNSTILE_SECRET_KEY is not set, so sign-up and login skip the bot check.',
      );
    }
    return;
  }

  if (!token) {
    throw new ForbiddenException('We couldn’t check that you’re human');
  }

  let result: { success?: boolean };
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret,
        response: token,
        ...(remoteIp && { remoteip: remoteIp }),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    result = await response.json();
  } catch (error) {
    logger.error(`Couldn’t reach Cloudflare: ${(error as Error).message}`);
    throw new ServiceUnavailableException(
      'We couldn’t check that you’re human right now. Try again in a moment',
    );
  }

  if (result.success !== true) {
    throw new ForbiddenException('We couldn’t check that you’re human');
  }
}
