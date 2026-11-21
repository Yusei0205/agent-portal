/**
 * Checks a Claude plan token (from `claude setup-token`) with a real one-turn call: no tools, the cheapest model, and an
 * empty home folder so nothing from this computer's own Claude sign-in can answer in its place.
 * A plan token cannot list models or be inspected, so a reply is the only proof that it works.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PlanTokenCheck {
  /** true: the token answered. false: it was refused or the call failed. null: the check could not be run here. */
  ok: boolean | null;
  message: string;
}

const CHECK_TIMEOUT_MS = 60_000;

/** Paste mistakes show up before any call: plan tokens start with sk-ant-oat. */
export function planTokenShapeProblem(token: string): string | null {
  const t = token.trim();
  if (/\s/.test(t)) return 'The token has spaces or line breaks in it. Copy it again as one line.';
  if (t.startsWith('sk-ant-api')) return 'This is an Anthropic API key, not a Claude plan token. Add it as an API key instead.';
  return null;
}

/** Turns what Claude said into a short reason the user can act on. */
export function planTokenFailureMessage(raw: string, model?: string): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  if (/invalid|authenticat|unauthori|401|expired|revoked|oauth/i.test(s)) {
    return 'Claude refused this token (it is invalid, expired or revoked). Run `claude setup-token` again and paste the new token.';
  }
  if (/rate limit|usage limit|limit reached|429|overloaded|credits/i.test(s)) {
    return 'The token is accepted, but the plan is at its usage limit right now. It will work again after the limit resets.';
  }
  return s ? `Claude could not run${model ? ` ${model}` : ''} with this token: ${s.slice(0, 200)}` : 'Claude did not accept this token.';
}

/** A refusal of the token itself (no point trying another model) versus of one model (try the next). */
function isTokenRefusal(raw: string): boolean {
  return /invalid|authenticat|unauthori|401|expired|revoked|oauth|rate limit|usage limit|429/i.test(raw);
}

/** Tries the plan's models in the order given (cheapest first) and stops at the first that answers. */
export async function checkClaudePlanToken(token: string, models: string[]): Promise<PlanTokenCheck> {
  const shape = planTokenShapeProblem(token);
  if (shape) return { ok: false, message: shape };

  const pkg = process.env.PORTAL_SDK_MODULE ?? '@anthropic-ai/claude-agent-sdk';
  let sdk: Record<string, any>;
  try {
    sdk = await (Function('m', 'return import(m)')(pkg) as Promise<Record<string, any>>);
  } catch {
    return { ok: null, message: 'Saved. The Claude engine is not available on this server to test it, so the first session will tell.' };
  }
  if (typeof sdk.query !== 'function') {
    return { ok: null, message: 'Saved. The Claude engine is not available on this server to test it, so the first session will tell.' };
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-plan-check-'));
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) delete env[k];
  env.CLAUDE_CODE_OAUTH_TOKEN = token.trim();
  env.HOME = home;
  env.USERPROFILE = home;
  env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';

  try {
    let last: PlanTokenCheck = { ok: false, message: 'No model is listed for the Claude plan.' };
    for (const model of models.slice(0, 4)) {
      last = await tryModel(sdk, env, home, model);
      if (last.ok !== false || isTokenRefusal(last.message) || /setup-token|usage limit/.test(last.message)) return last;
    }
    return last;
  } finally {
    fs.rm(home, { recursive: true, force: true }, () => {});
  }
}

async function tryModel(sdk: Record<string, any>, env: Record<string, string>, home: string, model: string): Promise<PlanTokenCheck> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), CHECK_TIMEOUT_MS);
  try {
    const q = sdk.query({
      prompt: 'Reply with OK',
      options: { cwd: home, model, env, abortController, tools: [], allowedTools: [], settingSources: [], maxTurns: 1, permissionMode: 'default' },
    });
    let failure = '';
    for await (const msg of q as AsyncIterable<Record<string, any>>) {
      if (msg.type === 'assistant' && msg.error) failure = String(msg.error);
      if (msg.type === 'result') {
        if (!msg.is_error && msg.subtype === 'success') return { ok: true, message: `Works. Claude answered with this plan token (${model}).` };
        failure = String(msg.result ?? failure ?? msg.subtype ?? '');
        break;
      }
    }
    return { ok: false, message: planTokenFailureMessage(failure, model) };
  } catch (e) {
    if (abortController.signal.aborted) return { ok: null, message: 'Saved. Claude did not answer within a minute, so the first session will tell.' };
    return { ok: false, message: planTokenFailureMessage(String((e as Error)?.message ?? e), model) };
  } finally {
    clearTimeout(timer);
  }
}
