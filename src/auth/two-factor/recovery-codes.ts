import { createHash, randomInt } from 'node:crypto';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const COUNT = 10;

function randomChunk(length: number) {
  return Array.from(
    { length },
    () => ALPHABET[randomInt(ALPHABET.length)],
  ).join('');
}

export function generateRecoveryCodes() {
  return Array.from(
    { length: COUNT },
    () => `${randomChunk(5)}-${randomChunk(5)}`,
  );
}

export function hashRecoveryCode(code: string) {
  const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  return createHash('sha256').update(normalized).digest('hex');
}
