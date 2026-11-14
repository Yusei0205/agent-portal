import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, codeForStep, generateSecret, otpauthUrl, stepAt, verifyCode } from '../server/totp.ts';

// RFC 6238 appendix B: secret "12345678901234567890", SHA-1; the 6 digits are the last 6 of the 8-digit values.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', () => {
    const cases: Array<[number, string]> = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']];
    for (const [seconds, expected] of cases) assert.equal(codeForStep(RFC_SECRET, stepAt(seconds * 1000)), expected, `t=${seconds}`);
  });

  it('base32 round-trips', () => {
    const buf = Buffer.from('hello world, this is a test');
    assert.deepEqual(base32Decode(base32Encode(buf)), buf);
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  });

  it('accepts the current code and one step either side, not two', () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    assert.equal(verifyCode(RFC_SECRET, codeForStep(RFC_SECRET, step), now), step);
    assert.equal(verifyCode(RFC_SECRET, codeForStep(RFC_SECRET, step - 1), now), step - 1);
    assert.equal(verifyCode(RFC_SECRET, codeForStep(RFC_SECRET, step + 1), now), step + 1);
    assert.equal(verifyCode(RFC_SECRET, codeForStep(RFC_SECRET, step - 2), now), null);
  });

  it('ignores spaces and refuses anything that is not six digits', () => {
    const now = 1_700_000_000_000;
    const c = codeForStep(RFC_SECRET, stepAt(now));
    assert.notEqual(verifyCode(RFC_SECRET, `${c.slice(0, 3)} ${c.slice(3)}`, now), null);
    assert.equal(verifyCode(RFC_SECRET, '12345', now), null);
    assert.equal(verifyCode(RFC_SECRET, 'abcdef', now), null);
    assert.equal(verifyCode(RFC_SECRET, '', now), null);
  });

  it('makes 32-character secrets and an authenticator link', () => {
    const s = generateSecret();
    assert.match(s, /^[A-Z2-7]{32}$/);
    const url = otpauthUrl(s, 'a@b.com', 'Agent Portal');
    assert.ok(url.startsWith('otpauth://totp/Agent%20Portal:a%40b.com?secret='));
    assert.ok(url.includes(`secret=${s}`));
  });
});
