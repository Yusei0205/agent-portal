/**
 * Two-step sign-in with an authenticator app (TOTP), optional per person.
 *
 * Stored on the user as one JSON string (`users.mfa`): the secret encrypted with the portal key, whether it is switched
 * on, the last time step accepted (a code works once) and the hashes of the one-time recovery codes.
 *
 * Sign-in: after the password is right, a person with MFA on must also send `code` (an authenticator code or a recovery
 * code). A wrong code counts as a failed sign-in for the limits. People who sign in with Google do not use this (Google
 * protects that account).
 */
import { randomBytes } from 'node:crypto';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { config } from './config.ts';
import { encrypt, decrypt } from './secrets.ts';
import { sha256 } from './util.ts';
import { getAuthRepository } from './repositories/auth.ts';
import type { UserRecord } from './repositories/auth.ts';
import { appendAudit } from './audit.ts';
import { requireStepUp } from './step-up.ts';
import { generateSecret, otpauthUrl, verifyCode } from './totp.ts';

export interface MfaState {
  secret_enc: string;
  enabled: boolean;
  last_step: number;
  recovery: string[];
}

export function parseMfa(raw: string | null | undefined): MfaState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<MfaState>;
    if (typeof v.secret_enc !== 'string') return null;
    return { secret_enc: v.secret_enc, enabled: v.enabled === true, last_step: Number(v.last_step ?? 0), recovery: Array.isArray(v.recovery) ? v.recovery.map(String) : [] };
  } catch {
    return null;
  }
}

export function mfaEnabled(user: Pick<UserRecord, 'mfa'>): boolean {
  return parseMfa(user.mfa)?.enabled === true;
}

const normaliseRecovery = (code: string): string => code.toLowerCase().replace(/[^0-9a-f]/g, '');

export function newRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const hex = randomBytes(5).toString('hex');
    return `${hex.slice(0, 5)}-${hex.slice(5)}`;
  });
}

async function save(userId: string, state: MfaState | null): Promise<void> {
  await getAuthRepository().updateUserFields(userId, { mfa: state ? JSON.stringify(state) : '' });
}

/**
 * Check the second factor at sign-in: an authenticator code (once per time step) or an unused recovery code.
 * Records what was used. True when the person may sign in.
 */
export async function checkSecondFactor(user: UserRecord, code: string, nowMs = Date.now()): Promise<boolean> {
  const state = parseMfa(user.mfa);
  if (!state?.enabled) return true;
  const typed = code.trim();
  if (!typed) return false;
  const step = verifyCode(decrypt(state.secret_enc, config.secretKey), typed, nowMs);
  if (step !== null) {
    if (step <= state.last_step) return false; // this code (or an older one) was already used
    await save(user.id, { ...state, last_step: step });
    return true;
  }
  const hash = sha256(normaliseRecovery(typed));
  if (normaliseRecovery(typed).length === 10 && state.recovery.includes(hash)) {
    await save(user.id, { ...state, recovery: state.recovery.filter((h) => h !== hash) });
    appendAudit(null, user.id, 'auth.mfa_recovery_used', `user:${user.id}`, { left: state.recovery.length - 1 }, '');
    return true;
  }
  return false;
}

export function registerMfaRoutes(): void {
  // GET /api/auth/mfa — is it on, and how many recovery codes are left
  router.get('/api/auth/mfa', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    const user = await getAuthRepository().getUserById(req.user.id);
    const state = parseMfa(user?.mfa);
    sendJson(res, 200, { available: !user?.google_sub, enabled: state?.enabled === true, recoveryLeft: state?.enabled ? state.recovery.length : 0 });
  });

  // POST /api/auth/mfa/setup — make a secret to add to an authenticator app (not on until a code is confirmed)
  router.post('/api/auth/mfa/setup', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    if (!await requireStepUp(req, res)) return;
    const user = await getAuthRepository().getUserById(req.user.id);
    if (!user) { sendJson(res, 404, { error: 'User not found' }); return; }
    if (user.google_sub) { sendJson(res, 400, { error: 'Your account signs in with Google, which has its own second step' }); return; }
    if (mfaEnabled(user)) { sendJson(res, 409, { error: 'Two-step sign-in is already on' }); return; }
    const secret = generateSecret();
    await save(user.id, { secret_enc: encrypt(secret, config.secretKey), enabled: false, last_step: 0, recovery: [] });
    sendJson(res, 200, { secret, otpauthUrl: otpauthUrl(secret, user.email, 'Agent Portal') });
  });

  // POST /api/auth/mfa/enable { code } — confirm the app works, switch it on, show the recovery codes once
  router.post('/api/auth/mfa/enable', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    const user = await getAuthRepository().getUserById(req.user.id);
    const state = parseMfa(user?.mfa);
    if (!user || !state) { sendJson(res, 400, { error: 'Start the setup first' }); return; }
    if (state.enabled) { sendJson(res, 409, { error: 'Two-step sign-in is already on' }); return; }
    const step = verifyCode(decrypt(state.secret_enc, config.secretKey), String((req.body as Record<string, unknown> | undefined)?.code ?? ''), Date.now());
    if (step === null) { sendJson(res, 400, { error: 'That code is not right. Check the time on your phone and try the next code.' }); return; }
    const codes = newRecoveryCodes();
    await save(user.id, { ...state, enabled: true, last_step: step, recovery: codes.map((c) => sha256(normaliseRecovery(c))) });
    appendAudit(null, user.id, 'auth.mfa_enabled', `user:${user.id}`, {}, req.ip);
    sendJson(res, 200, { ok: true, recoveryCodes: codes });
  });

  // POST /api/auth/mfa/disable { code } — switch it off (needs the password and a code)
  router.post('/api/auth/mfa/disable', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    if (!await requireStepUp(req, res)) return;
    const user = await getAuthRepository().getUserById(req.user.id);
    if (!user || !mfaEnabled(user)) { sendJson(res, 400, { error: 'Two-step sign-in is not on' }); return; }
    if (!await checkSecondFactor(user, String((req.body as Record<string, unknown> | undefined)?.code ?? ''))) {
      sendJson(res, 400, { error: 'That code is not right' });
      return;
    }
    await save(user.id, null);
    appendAudit(null, user.id, 'auth.mfa_disabled', `user:${user.id}`, {}, req.ip);
    sendJson(res, 200, { ok: true });
  });
}
