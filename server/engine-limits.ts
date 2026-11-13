/**
 * How much of a person's plan an engine has left: the 5-hour and weekly windows of a ChatGPT (Codex) or Claude plan, and the
 * credits of a Kiro account. The session's status bar shows it next to what the session itself has used.
 *
 * Each engine reports it differently, and none of the three is a published, stable API for the portal's use, so every
 * reader fails soft: it answers `available: false` with a short reason instead of throwing, and the bar then just omits it.
 *   Codex   the Codex app-server's account/rateLimits/read (through the AgentCore runner in the cloud).
 *   Claude  Anthropic's OAuth usage endpoint, with the plan's token. A long-lived token made for inference only is
 *           refused there (it lacks the profile scope), so the windows are read from the rate-limit headers of a one-token call.
 *   Kiro    the Kiro (CodeWhisperer) GetUsageLimits call with the Identity Center token. Company-managed profiles can
 *           answer FEATURE_NOT_SUPPORTED.
 * Answers are cached for a minute: the status bar asks every minute per open session, and these are not cheap calls.
 */

import { randomUUID } from 'node:crypto';
import { getCredentialsRepository } from './repositories/credentials.ts';
import { findUserCredential } from './credential-default.ts';
import { planCheckModelIds } from './models.ts';
import { isBedrockRuntimeChoice, resolveCredentialEnv, IDC_TOKEN_KEY, IDC_REGION_KEY, IDC_PROFILE_ARN_KEY } from './credentials.ts';

export interface LimitWindow {
  id: string;
  /** "5-hour", "Weekly", ... */
  label: string;
  usedPercent: number;
  /** Unix seconds when the window resets, when known. */
  resetsAt: number | null;
}

export interface LimitCredits {
  unit: 'credits';
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resetsAt: number | null;
}

export interface EngineLimits {
  available: boolean;
  engine: string;
  /** The plan's name, e.g. "Pro", "Max 5x", "Kiro Pro". */
  plan: string | null;
  windows: LimitWindow[];
  credits: LimitCredits | null;
  /** Why nothing is shown, or a remark to show with it. */
  note: string | null;
}

const unavailable = (engine: string, note: string): EngineLimits => ({ available: false, engine, plan: null, windows: [], credits: null, note });

const CACHE_MS = 60_000;
/** An answer read by a real (tiny) call is kept longer than one from a free lookup. */
const FALLBACK_CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: EngineLimits }>();

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const clampPct = (v: number): number => Math.max(0, Math.min(100, Math.round(v * 10) / 10));
/** An ISO time or an epoch (seconds or milliseconds) as Unix seconds. */
function toUnixSeconds(v: unknown): number | null {
  if (typeof v === 'string' && !/^\d+(\.\d+)?$/.test(v.trim())) { const t = Date.parse(v); return Number.isFinite(t) ? Math.floor(t / 1000) : null; }
  const n = num(v);
  if (n == null || n <= 0) return null;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}
const windowLabel = (mins: number | null, fallback: string): string => {
  if (mins == null) return fallback;
  if (mins <= 360) return `${Math.round(mins / 60)}-hour`;
  if (mins >= 9000 && mins <= 11000) return 'Weekly';
  if (mins >= 40000) return 'Monthly';
  return mins % 1440 === 0 ? `${mins / 1440}-day` : `${Math.round(mins / 60)}-hour`;
};

// ── Codex ─────────────────────────────────────────────────────────────────────

/** Turns the Codex app-server's account/rateLimits/read answer into windows. Exported for tests. */
export function parseCodexLimits(raw: unknown): EngineLimits {
  const r = (raw ?? {}) as Record<string, any>;
  const snap = (r.rateLimitsByLimitId && (r.rateLimitsByLimitId.codex ?? Object.values(r.rateLimitsByLimitId)[0])) || r.rateLimits;
  if (!snap || typeof snap !== 'object') return unavailable('codex', 'Codex did not report its limits.');
  const windows: LimitWindow[] = [];
  for (const [key, fallback] of [['primary', '5-hour'], ['secondary', 'Weekly']] as const) {
    const w = snap[key];
    const used = num(w?.usedPercent);
    if (!w || used == null) continue;
    const mins = num(w.windowDurationMins);
    windows.push({ id: key === 'primary' ? 'hourly' : 'weekly', label: windowLabel(mins, fallback), usedPercent: clampPct(used), resetsAt: toUnixSeconds(w.resetsAt) });
  }
  const plan = typeof snap.planType === 'string' && snap.planType !== 'unknown' ? snap.planType : null;
  const credits = snap.credits && typeof snap.credits === 'object' && !snap.credits.unlimited && num(snap.credits.balance) != null
    ? { unit: 'credits' as const, used: null, limit: null, remaining: num(snap.credits.balance), resetsAt: null } : null;
  const reached = typeof snap.rateLimitReachedType === 'string' ? 'A usage limit has been reached.' : null;
  if (!windows.length && !credits) return unavailable('codex', 'Codex reported no usage windows for this plan.');
  return { available: true, engine: 'codex', plan, windows, credits, note: reached };
}

async function codexLimits(userId: string): Promise<EngineLimits> {
  const { codexUsesCloud, openUserCodex } = await import('./codex-auth.ts');
  if (codexUsesCloud()) {
    const arn = process.env.PORTAL_CODEX_AGENTCORE_RUNTIME_ARN;
    if (!arn) return unavailable('codex', 'The Codex cloud runtime is not configured.');
    const { cloudCodexAuth } = await import('./codex-device.ts');
    const { invokeAgentCore } = await import('./agent/kiro-agentcore.ts');
    const auth = await cloudCodexAuth(userId);
    for await (const ev of invokeAgentCore(arn, 'codex-limits-' + randomUUID(), { mode: 'codex-limits', ...auth }, AbortSignal.timeout(45_000))) {
      const e = ev as unknown as Record<string, any>;
      if (e.type === 'limits') return parseCodexLimits(e.limits);
      if (e.type === 'error') return unavailable('codex', 'The Codex runner could not read the plan limits. Rebuild the Codex runner image if it is older than this feature.');
    }
    return unavailable('codex', 'The Codex runner returned no limits.');
  }
  const client = await openUserCodex(userId);
  try {
    const account = await client.request('account/read', { refreshToken: false });
    if (account.account?.type !== 'chatgpt') return unavailable('codex', 'Sign in to Codex in Connect > Agent sign-ins.');
    return parseCodexLimits(await client.request('account/rateLimits/read'));
  } finally { client.close(); }
}

// ── Claude plan ───────────────────────────────────────────────────────────────

/** Turns Anthropic's OAuth usage answer ({ five_hour: { utilization, resets_at }, seven_day: ... }) into windows. Exported for tests. */
export function parseClaudeUsage(raw: unknown): EngineLimits {
  const r = (raw ?? {}) as Record<string, any>;
  const windows: LimitWindow[] = [];
  for (const [key, id, label] of [['five_hour', 'hourly', '5-hour'], ['seven_day', 'weekly', 'Weekly'], ['seven_day_opus', 'weekly-opus', 'Weekly (Opus)'], ['seven_day_sonnet', 'weekly-sonnet', 'Weekly (Sonnet)']] as const) {
    const w = r[key];
    const used = num(w?.utilization);
    if (!w || used == null) continue;
    windows.push({ id, label, usedPercent: clampPct(used), resetsAt: toUnixSeconds(w.resets_at) });
  }
  if (!windows.length) return unavailable('claude-code', 'Claude did not report plan usage for this sign-in.');
  return { available: true, engine: 'claude-code', plan: null, windows, credits: null, note: null };
}

/**
 * Reads the plan windows from the rate-limit headers of a Messages answer (`anthropic-ratelimit-unified-5h-utilization`, `...-5h-reset`,
 * `...-7d-utilization`, ...). Utilization is a fraction (0-1); the reset is Unix seconds. Exported for tests.
 */
export function parseClaudeRateHeaders(headers: { forEach(cb: (value: string, key: string) => void): void }): EngineLimits {
  const util = new Map<string, number>();
  const reset = new Map<string, number | null>();
  headers.forEach((value, key) => {
    const m = /^anthropic-ratelimit-unified-([a-z0-9_]+?)-(utilization|reset)$/i.exec(key);
    if (!m) return;
    if (m[2].toLowerCase() === 'utilization') { const n = num(value); if (n != null) util.set(m[1].toLowerCase(), n); }
    else reset.set(m[1].toLowerCase(), toUnixSeconds(value));
  });
  const labels: Record<string, [string, string]> = { '5h': ['hourly', '5-hour'], '7d': ['weekly', 'Weekly'], '7d_opus': ['weekly-opus', 'Weekly (Opus)'], '7d_sonnet': ['weekly-sonnet', 'Weekly (Sonnet)'] };
  const windows: LimitWindow[] = [];
  for (const [key, [id, label]] of Object.entries(labels)) {
    const u = util.get(key);
    if (u != null) windows.push({ id, label, usedPercent: clampPct(u * 100), resetsAt: reset.get(key) ?? null });
  }
  if (!windows.length) return unavailable('claude-code', 'Claude did not report plan usage for this sign-in.');
  return { available: true, engine: 'claude-code', plan: null, windows, credits: null, note: null };
}

/**
 * A token made with `claude setup-token` is for running Claude only: the usage endpoint refuses it. Any answer to a real call
 * still carries the plan's windows in its headers (this is where Claude Code's own /usage looks too), so one tiny call on
 * the cheapest model reads them. It costs a few tokens, so the answer is kept longer than the other engines' (see FALLBACK_CACHE_MS).
 */
async function claudeLimitsFromHeaders(token: string): Promise<EngineLimits> {
  const model = planCheckModelIds()[0] ?? 'claude-haiku-4-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'user-agent': 'agent-portal' },
    body: JSON.stringify({ model, max_tokens: 1, system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(15_000),
  });
  // A 429 still carries the windows (the plan is at its limit), which is exactly when the person wants to see them.
  if (!res.ok && res.status !== 429) return unavailable('claude-code', "This Claude sign-in cannot read plan usage (its token is for running Claude only). Usage of this session is still shown.");
  const out = parseClaudeRateHeaders(res.headers);
  return out.available && res.status === 429 ? { ...out, note: 'A usage limit has been reached.' } : out;
}

async function claudeLimits(token: string): Promise<EngineLimits> {
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json', 'user-agent': 'agent-portal' },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401 || res.status === 403) return claudeLimitsFromHeaders(token);
  if (!res.ok) return unavailable('claude-code', `Claude plan usage is unavailable right now (HTTP ${res.status}).`);
  return parseClaudeUsage(await res.json().catch(() => null));
}

// ── Kiro ──────────────────────────────────────────────────────────────────────

/** Turns the Kiro GetUsageLimits answer (usageBreakdownList, subscriptionInfo) into credits. Exported for tests. */
export function parseKiroUsage(raw: unknown): EngineLimits {
  const r = (raw ?? {}) as Record<string, any>;
  const list: any[] = Array.isArray(r.usageBreakdownList) ? r.usageBreakdownList : [];
  const item = list.find((u) => String(u?.resourceType ?? '').toUpperCase() === 'CREDIT') ?? list[0];
  if (!item) return unavailable('kiro', 'Kiro did not report credit usage for this account.');
  const used = num(item.currentUsageWithPrecision) ?? num(item.currentUsage);
  const limit = num(item.usageLimitWithPrecision) ?? num(item.usageLimit);
  const resetsAt = toUnixSeconds(item.nextDateReset ?? r.nextDateReset);
  const plan = typeof r.subscriptionInfo?.subscriptionTitle === 'string' ? r.subscriptionInfo.subscriptionTitle : null;
  const remaining = used != null && limit != null ? Math.max(0, Math.round((limit - used) * 100) / 100) : null;
  const windows: LimitWindow[] = used != null && limit != null && limit > 0
    ? [{ id: 'monthly', label: 'Monthly', usedPercent: clampPct((used / limit) * 100), resetsAt }] : [];
  return { available: true, engine: 'kiro', plan, windows, credits: { unit: 'credits', used, limit, remaining, resetsAt }, note: null };
}

async function kiroLimits(env: Record<string, string>): Promise<EngineLimits> {
  const token = env[IDC_TOKEN_KEY];
  if (!token) return unavailable('kiro', 'Account credits can only be read for an AWS sign-in (Identity Center).');
  const region = env[IDC_REGION_KEY] || 'us-east-1';
  const profileArn = env[IDC_PROFILE_ARN_KEY];
  const q = new URLSearchParams({ origin: 'AI_EDITOR', resourceType: 'AGENTIC_REQUEST', isEmailRequired: 'false', ...(profileArn ? { profileArn } : {}) });
  const res = await fetch(`https://q.${region}.amazonaws.com/getUsageLimits?${q}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 403 || res.status === 401) {
    const body = await res.text().catch(() => '');
    return unavailable('kiro', /FEATURE_NOT_SUPPORTED/.test(body)
      ? 'Kiro does not report account credits for this (company-managed) sign-in. Credits used by this session are still shown.'
      : 'Kiro refused the credit lookup for this sign-in.');
  }
  if (!res.ok) return unavailable('kiro', `Kiro account credits are unavailable right now (HTTP ${res.status}).`);
  return parseKiroUsage(await res.json().catch(() => null));
}

// ── Entry point ───────────────────────────────────────────────────────────────

/** The plan limits for the sign-in a session runs on; null for engines with none (demo). Never throws. */
export async function getSessionLimits(w: { engine?: unknown; credential_id?: unknown; created_by?: unknown }): Promise<EngineLimits | null> {
  const engine = String(w.engine ?? '');
  if (engine !== 'codex' && engine !== 'claude-code' && engine !== 'kiro') return null;
  const owner = w.created_by ? String(w.created_by) : null;
  const credentialId = w.credential_id ? String(w.credential_id) : null;
  const key = `${engine}:${owner ?? ''}:${credentialId ?? ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.value.engine === 'claude-code' && hit.value.available ? FALLBACK_CACHE_MS : CACHE_MS)) return hit.value;

  let value: EngineLimits;
  try {
    if (!owner) value = unavailable(engine, 'No signed-in owner for this session.');
    else if (engine === 'codex') value = await codexLimits(owner);
    else if (engine === 'claude-code') {
      if (isBedrockRuntimeChoice(engine, credentialId)) value = unavailable(engine, 'This session runs on Amazon Bedrock, which has no plan limits.');
      else {
        const cred = credentialId ? await getCredentialsRepository().getByIdAndUser(credentialId, owner) : await findUserCredential(owner, engine);
        if (!cred || cred.mode !== 'subscription_token') value = unavailable(engine, cred ? 'Only a Claude Pro/Max plan sign-in has plan limits.' : 'No Claude plan sign-in for this session.');
        else {
          const env = await resolveCredentialEnv('claude-code', owner, String(cred.id));
          value = env.CLAUDE_CODE_OAUTH_TOKEN ? await claudeLimits(env.CLAUDE_CODE_OAUTH_TOKEN) : unavailable(engine, 'The plan token could not be read.');
        }
      }
    } else {
      const cred = credentialId ? await getCredentialsRepository().getByIdAndUser(credentialId, owner) : await findUserCredential(owner, 'kiro');
      value = cred ? await kiroLimits(await resolveCredentialEnv('kiro', owner, String(cred.id))) : unavailable(engine, 'No Kiro sign-in for this session.');
    }
  } catch (e) {
    console.warn(`[limits] ${engine} limits failed: ${e instanceof Error ? e.message.replace(/[A-Za-z0-9+/_-]{24,}/g, '***') : 'error'}`);
    value = unavailable(engine, 'Plan limits could not be read right now.');
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Test hook. */
export function _clearLimitsCache(): void { cache.clear(); }
