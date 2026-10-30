import {
  base32Decode,
  base32Encode,
  matchingStep,
  otpauthUri,
  timeStep,
  totpCode,
} from './totp';

const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));

describe('Authenticator codes', () => {
  it('encodes and decodes base32', () => {
    expect(rfcSecret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(rfcSecret).toString()).toBe('12345678901234567890');
  });

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches the RFC 6238 code at %i seconds', (seconds, code) => {
    expect(totpCode(rfcSecret, timeStep(seconds * 1000))).toBe(code);
  });

  it('accepts the previous, current and next code only', () => {
    const now = 1234567890 * 1000;
    const step = timeStep(now);
    for (const offset of [-1, 0, 1]) {
      expect(
        matchingStep(rfcSecret, totpCode(rfcSecret, step + offset), { now }),
      ).toBe(step + offset);
    }
    expect(
      matchingStep(rfcSecret, totpCode(rfcSecret, step - 2), { now }),
    ).toBeNull();
    expect(matchingStep(rfcSecret, 'abcdef', { now })).toBeNull();
  });

  it('refuses a code from a step that was already used', () => {
    const now = 1234567890 * 1000;
    const step = timeStep(now);
    const code = totpCode(rfcSecret, step);
    expect(matchingStep(rfcSecret, code, { now, after: step })).toBeNull();
    expect(matchingStep(rfcSecret, code, { now, after: step - 1 })).toBe(step);
  });

  it('builds a link authenticator apps understand', () => {
    expect(otpauthUri({ issuer: 'Orbis', label: 'aya', secret: 'ABC' })).toBe(
      'otpauth://totp/Orbis:aya?secret=ABC&issuer=Orbis&algorithm=SHA1&digits=6&period=30',
    );
  });
});
