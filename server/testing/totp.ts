/**
 * RFC 6238 TOTP implementation using node:crypto only.
 * Algorithm: HMAC-SHA1, 30-second time step, 6-digit output.
 */
import { createHmac } from 'node:crypto';

/**
 * Decode a base32 string to a Buffer.
 * Accepts both upper and lower case, ignores spaces and padding.
 */
export function base32ToBuffer(base32: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = base32.replace(/\s/g, '').toUpperCase().replace(/=+$/, '');
  const bits: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue; // skip unknown chars
    for (let i = 4; i >= 0; i--) {
      bits.push((idx >> i) & 1);
    }
  }
  const bytes: number[] = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/**
 * HOTP (RFC 4226): HMAC-SHA1 of the 8-byte big-endian counter.
 * Returns a 6-digit zero-padded string.
 */
export function hotp(secret: Buffer, counter: bigint): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', secret).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

/**
 * TOTP (RFC 6238): HOTP with counter = floor(timestampMs / 30_000).
 *
 * @param base32Secret  Base32-encoded secret (case-insensitive, spaces and padding ignored).
 * @param timestampMs   Unix timestamp in milliseconds (default: Date.now()).
 * @returns 6-digit TOTP code as a zero-padded string.
 */
export function totp(base32Secret: string, timestampMs = Date.now()): string {
  const secret = base32ToBuffer(base32Secret);
  const counter = BigInt(Math.floor(timestampMs / 30_000));
  return hotp(secret, counter);
}
