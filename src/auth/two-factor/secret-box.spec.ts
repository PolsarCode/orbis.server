import { ServiceUnavailableException } from '@nestjs/common';
import { openSecret, sealSecret } from './secret-box';

describe('Stored authenticator secrets', () => {
  const realKey = process.env.TWO_FACTOR_KEY;

  afterEach(() => {
    if (realKey === undefined) delete process.env.TWO_FACTOR_KEY;
    else process.env.TWO_FACTOR_KEY = realKey;
  });

  it('are encrypted and can be read back with the same key', () => {
    process.env.TWO_FACTOR_KEY = 'test-key';
    const sealed = sealSecret('JBSWY3DPEHPK3PXP');

    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(openSecret(sealed)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('can’t be read with another key or after tampering', () => {
    process.env.TWO_FACTOR_KEY = 'test-key';
    const sealed = sealSecret('JBSWY3DPEHPK3PXP');

    process.env.TWO_FACTOR_KEY = 'other-key';
    expect(() => openSecret(sealed)).toThrow();

    process.env.TWO_FACTOR_KEY = 'test-key';
    const [iv, tag, data] = sealed.split('.');
    expect(() =>
      openSecret([iv, tag, `A${data.slice(1)}`].join('.')),
    ).toThrow();
  });

  it('are unavailable when the key isn’t set', () => {
    delete process.env.TWO_FACTOR_KEY;
    expect(() => sealSecret('JBSWY3DPEHPK3PXP')).toThrow(
      ServiceUnavailableException,
    );
  });
});
