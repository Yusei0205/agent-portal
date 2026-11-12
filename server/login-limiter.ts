/**
 * Limits on failed sign-ins, kept in the auth repository so every server instance sees the same counts.
 *   - per account: 10 failures in 15 minutes locks that email for the rest of the window, whatever the address
 *   - per address: 30 failures in 15 minutes (many accounts tried from one place)
 * A correct password clears the account counter. Keys are hashed, so emails are not stored in the counters.
 */
import { createHash } from 'node:crypto';
import { getAuthRepository } from './repositories/auth.ts';
import { securityLog } from './security-log.ts';

export const LOGIN_WINDOW_MS = 15 * 60_000;
export const ACCOUNT_LIMIT = 10;
export const IP_LIMIT = 30;

const h = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 40);
export const accountKey = (email: string): string => `acct:${h(email)}`;
export const addressKey = (ip: string): string => `ip:${h(ip || 'unknown')}`;

/** True when this email or address has used up its failures for the current window. */
export async function loginBlocked(email: string, ip: string, nowMs = Date.now()): Promise<boolean> {
  const repo = getAuthRepository();
  const [acct, addr] = await Promise.all([
    repo.getLoginFailures(accountKey(email), nowMs),
    repo.getLoginFailures(addressKey(ip), nowMs),
  ]);
  const blocked = acct >= ACCOUNT_LIMIT || addr >= IP_LIMIT;
  if (blocked) securityLog('login_blocked', { ip, reason: acct >= ACCOUNT_LIMIT ? 'account' : 'address' });
  return blocked;
}

export async function recordLoginFailure(email: string, ip: string, nowMs = Date.now()): Promise<void> {
  const repo = getAuthRepository();
  securityLog('login_failed', { ip });
  await Promise.all([
    repo.recordLoginFailure(accountKey(email), LOGIN_WINDOW_MS, nowMs),
    repo.recordLoginFailure(addressKey(ip), LOGIN_WINDOW_MS, nowMs),
  ]);
}

export async function clearLoginFailures(email: string): Promise<void> {
  await getAuthRepository().clearLoginFailures(accountKey(email));
}
