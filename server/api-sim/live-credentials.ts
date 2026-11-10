/**
 * The login a simulated API uses when it is switched to the client's real API: header values kept encrypted with the
 * portal's key (the same way integration secrets are), shown in the browser by name only, and used when a caller has
 * not sent its own login (X-Sim-Authorization / clientAuthorization).
 */

import { config } from '../config.ts';
import { decrypt, encrypt } from '../secrets.ts';

const NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const MAX_HEADERS = 5;
const MAX_VALUE = 4000;

export function readLiveHeaders(enc: string | null): Record<string, string> {
  if (!enc) return {};
  try {
    const v = JSON.parse(decrypt(enc, config.secretKey)) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v).filter(([k, x]) => NAME_RE.test(k) && typeof x === 'string')) as Record<string, string>;
  } catch { return {}; }
}

/**
 * Builds the stored value from a form's list of {name, value}. An empty value keeps the value already stored under
 * that name (secrets are write-only, so the form never has them to send back); a name that is not in the list is removed.
 */
export function buildLiveHeaders(list: unknown, existingEnc: string | null): { enc: string | null } | { error: string } {
  if (!Array.isArray(list)) return { error: 'liveHeaders must be a list of {name, value}' };
  if (list.length > MAX_HEADERS) return { error: `At most ${MAX_HEADERS} headers` };
  const existing = readLiveHeaders(existingEnc);
  const out: Record<string, string> = {};
  for (const item of list as Array<Record<string, unknown>>) {
    const name = String(item?.name ?? '').trim();
    if (!name) continue;
    if (!NAME_RE.test(name)) return { error: `"${name}" is not a valid header name` };
    if (/^(host|content-length|transfer-encoding|connection|cookie)$/i.test(name)) return { error: `"${name}" cannot be set here` };
    const value = String(item?.value ?? '');
    const final = value === '' ? existing[name] : value;
    if (!final) return { error: `Header "${name}" needs a value` };
    if (final.length > MAX_VALUE || /[\r\n]/.test(final)) return { error: `Header "${name}" has an invalid value` };
    out[name] = final;
  }
  return { enc: Object.keys(out).length === 0 ? null : encrypt(JSON.stringify(out), config.secretKey) };
}
