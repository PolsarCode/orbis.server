import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Buffer) {
  let output = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string) {
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 text');
    value = ((value << 5) | index) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateSecret() {
  return base32Encode(randomBytes(20));
}

function hotp(key: Buffer, counter: number) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function timeStep(now = Date.now()) {
  return Math.floor(now / 1000 / PERIOD_SECONDS);
}

export function totpCode(secret: string, step: number) {
  return hotp(base32Decode(secret), step);
}

export function matchingStep(
  secret: string,
  code: string,
  {
    after = null,
    now = Date.now(),
  }: { after?: number | null; now?: number } = {},
) {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret);
  const current = timeStep(now);
  for (const step of [current - 1, current, current + 1]) {
    if (after !== null && step <= after) continue;
    if (timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(code))) {
      return step;
    }
  }
  return null;
}

export function otpauthUri({
  issuer,
  label,
  secret,
}: {
  issuer: string;
  label: string;
  secret: string;
}) {
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${query}`;
}
