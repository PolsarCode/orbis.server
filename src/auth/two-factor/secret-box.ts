import { ServiceUnavailableException } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

function key() {
  const secret = process.env.TWO_FACTOR_KEY;
  if (!secret) {
    throw new ServiceUnavailableException(
      'Two-factor sign-in isn’t available right now',
    );
  }
  return createHash('sha256').update(secret).digest();
}

export function sealSecret(secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data]
    .map((part) => part.toString('base64'))
    .join('.');
}

export function openSecret(sealed: string) {
  const [iv, tag, data] = sealed
    .split('.')
    .map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8',
  );
}
