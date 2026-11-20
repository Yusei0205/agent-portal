/**
 * Chat notifier for the pipeline monitor: one Slack or Microsoft Teams incoming-webhook URL per project.
 * The URL lives in the secret store (`pipelines.chat.<projectId>`); only its host and last 4 characters are shown back.
 * The delivery status lives under the settings key `pipelines.chat_status.<projectId>` and never contains the URL.
 */

import { getDb } from '../db.ts';
import { getSetting, setSetting } from '../settings.ts';
import { setSecret, getSecret, deleteSecret } from '../secrets.ts';
import { getAuditRepository } from '../repositories/audit.ts';
import { badRequest, now } from '../util.ts';
import type { PipelineRun } from '../repositories/pipeline-runs.ts';

export type ChatKind = 'slack' | 'teams';
type Actor = { actorId: string | null; ip: string | null };

const MAX_URL = 2000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BACKOFF = [1000, 4000];

const secretName = (projectId: string) => `pipelines.chat.${projectId}`;
const statusKey = (projectId: string) => `pipelines.chat_status.${projectId}`;

let fetchImpl: typeof fetch | null = null;
let backoff: number[] = DEFAULT_BACKOFF;
let timeoutMs = DEFAULT_TIMEOUT_MS;
/** Test seam: replace the fetch used for delivery. */
export function _setChatFetch(fn: typeof fetch | null): void { fetchImpl = fn; }
/** Test seam: delays (ms) before the 2nd and 3rd try; null restores the defaults. */
export function _setChatBackoff(delays: number[] | null): void { backoff = delays ?? DEFAULT_BACKOFF; }

/** Test seam: per-try timeout in ms; null restores the default. */
export function _setChatTimeout(ms: number | null): void { timeoutMs = ms ?? DEFAULT_TIMEOUT_MS; }

function parse(url: string): { u: URL; kind: ChatKind } | string {
  if (typeof url !== 'string' || !url) return 'A chat webhook URL is required';
  if (url.length > MAX_URL) return 'The chat webhook URL is too long';
  if (/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(url)) return 'The chat webhook URL contains invalid characters';
  let u: URL;
  try { u = new URL(url); } catch { return 'The chat webhook URL is not a valid URL'; }
  if (u.protocol !== 'https:') return 'The chat webhook URL must use https';
  if (u.username || u.password) return 'The chat webhook URL must not contain credentials';
  if (u.port && u.port !== '443') return 'The chat webhook URL must not use a custom port';
  const host = u.hostname.toLowerCase();
  if (host === 'hooks.slack.com') return { u, kind: 'slack' };
  for (const suffix of ['.webhook.office.com', '.logic.azure.com']) {
    if (host.endsWith(suffix) && host.length > suffix.length) return { u, kind: 'teams' };
  }
  return 'Only Slack (hooks.slack.com), Microsoft Teams (webhook.office.com) or Power Automate (logic.azure.com) webhook URLs are allowed';
}

/** Null when the URL is allowed, otherwise a short reason. */
export function chatUrlProblem(url: string): string | null {
  const r = parse(url);
  return typeof r === 'string' ? r : null;
}

export async function getChatTarget(projectId: string): Promise<{ url: string; kind: ChatKind } | null> {
  const url = await getSecret(secretName(projectId));
  if (!url) return null;
  const r = parse(url);
  return typeof r === 'string' ? null : { url, kind: r.kind };
}

export async function setChatUrl(projectId: string, url: string | null, actor: Actor): Promise<void> {
  if (url === null) {
    await deleteSecret(secretName(projectId));
    await setSetting(getDb(), statusKey(projectId), '');
  } else {
    const problem = chatUrlProblem(url);
    if (problem) throw badRequest(problem);
    await setSecret(secretName(projectId), url);
    await setSetting(getDb(), statusKey(projectId), '');
  }
  await getAuditRepository().append({
    actorId: actor.actorId,
    action: 'pipelines.chat.update',
    target: projectId,
    detail: { configured: url !== null },
    ip: actor.ip,
  });
}

export async function chatUrlHint(projectId: string): Promise<{ host: string; last4: string } | null> {
  const t = await getChatTarget(projectId);
  if (!t) return null;
  return { host: new URL(t.url).hostname, last4: t.url.slice(-4) };
}

export async function chatStatus(projectId: string): Promise<{ lastFailureAt: string | null; lastError: string | null }> {
  const none = { lastFailureAt: null, lastError: null };
  const raw = getSetting(getDb(), statusKey(projectId));
  if (!raw) return none;
  try {
    const d = JSON.parse(raw) as { lastFailureAt?: unknown; lastError?: unknown };
    if (typeof d.lastFailureAt !== 'string') return none;
    return { lastFailureAt: d.lastFailureAt, lastError: typeof d.lastError === 'string' ? d.lastError : null };
  } catch {
    return none;
  }
}

const escSlack = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escTeams = (t: string) => t.replace(/[\\[\]()*_`#]/g, '\\$&').replace(/:\/\//g, ':\\/\\/');

/**
 * Message text for one target kind. Workflow, repo, branch, sha and actor are attacker-influenced, so they are escaped
 * (Slack: `&`, `<`, `>`; Teams: markdown link/emphasis characters, `#`, and `://` so nothing autolinks). The run URL is kept raw.
 */
export function buildChatMessage(kind: 'failed' | 'recovered', run: PipelineRun, target: ChatKind): string {
  const esc = target === 'slack' ? escSlack : escTeams;
  const head = kind === 'failed' ? 'Deploy failed' : 'Deploy recovered';
  return `${head}: ${esc(run.workflow_name)} on ${esc(run.repo_full_name)}@${esc(run.branch)} (${esc(run.head_sha.slice(0, 7))}) by ${esc(run.actor)}. ${run.html_url}`;
}

function body(kind: ChatKind, text: string): string {
  if (kind === 'slack') return JSON.stringify({ text });
  return JSON.stringify({
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: { type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text, wrap: true }] },
    }],
  });
}

/** One try; returns null on success or a short generic error (never containing the URL). */
async function attempt(target: { url: string; kind: ChatKind }, text: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await (fetchImpl ?? fetch)(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body(target.kind, text),
      redirect: 'manual',
      signal: ctrl.signal,
    });
    try { await res.body?.cancel(); } catch { /* ignore */ }
    if (res.status >= 300 && res.status < 400) return 'redirect refused';
    if (res.status >= 200 && res.status < 300) return null;
    return `HTTP ${res.status}`;
  } catch (e) {
    return ctrl.signal.aborted || (e as Error)?.name === 'AbortError' ? 'timeout' : 'network error';
  } finally {
    clearTimeout(timer);
  }
}

/** A 4xx other than 408 and 429 will not get better by retrying. */
function isPermanent(error: string): boolean {
  const m = /^HTTP (\d+)$/.exec(error);
  if (!m) return false;
  const n = Number(m[1]);
  return n >= 400 && n < 500 && n !== 408 && n !== 429;
}

async function deliver(projectId: string, target: { url: string; kind: ChatKind }, text: string): Promise<boolean> {
  try {
    let error: string | null = 'network error';
    for (let i = 0; i < 3; i++) {
      if (i > 0 && backoff[i - 1] > 0) await new Promise((r) => setTimeout(r, backoff[i - 1]));
      error = await attempt(target, text);
      if (error === null || isPermanent(error)) break;
    }
    const value = error === null ? '' : JSON.stringify({ lastFailureAt: now(), lastError: error });
    if (error === null && !getSetting(getDb(), statusKey(projectId))) return true;
    await setSetting(getDb(), statusKey(projectId), value);
    return error === null;
  } catch {
    return false;
  }
}

/**
 * Posts static text (the plain test message, no dynamic fields) to the project's chat webhook. 3 tries; never throws.
 * Do NOT pass run data here: use notifyRunChat, which escapes for the target kind.
 */
export async function sendChat(projectId: string, text: string): Promise<boolean> {
  try {
    const target = await getChatTarget(projectId);
    return target ? await deliver(projectId, target, text) : false;
  } catch {
    return false;
  }
}

/** Resolves the target once, builds the message escaped for that target's kind, and sends it. Never throws. */
export async function notifyRunChat(projectId: string, kind: 'failed' | 'recovered', run: PipelineRun): Promise<boolean> {
  try {
    const target = await getChatTarget(projectId);
    return target ? await deliver(projectId, target, buildChatMessage(kind, run, target.kind)) : false;
  } catch {
    return false;
  }
}
