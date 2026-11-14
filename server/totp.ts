/**
 * Time-based one-time passwords (RFC 6238, SHA-1, 6 digits, 30 second steps), the kind every authenticator app makes.
 * Only the maths lives here; storing the secret and the sign-in flow are in mfa.ts.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;
export const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Not a base32 string');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret, base32 text (20 bytes, the size authenticator apps expect). */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code for one time step. */
export function codeForStep(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/**
 * Check a typed code. One step either side is accepted (clock drift). Returns the step that matched, or null.
 * The caller keeps the last step it accepted and refuses a step that is not newer, so a code cannot be used twice.
 */
export function verifyCode(secretBase32: string, code: string, nowMs: number, window = 1): number | null {
  const typed = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;
  const now = stepAt(nowMs);
  let matched: number | null = null;
  for (let s = now - window; s <= now + window; s++) {
    const expected = Buffer.from(codeForStep(secretBase32, s));
    const given = Buffer.from(typed);
    // No early return: every step is compared so the time taken does not say which one was close.
    if (expected.length === given.length && timingSafeEqual(expected, given)) matched = s;
  }
  return matched;
}

/** The link an authenticator app reads (shown as text; people can also type the secret). */
export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
