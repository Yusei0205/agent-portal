/**
 * The call log of a simulated API: what was asked of it, how it answered, and through which door (the hosted REST
 * address or the MCP tools). It exists for debugging, "why did the agent get a 400?", so it keeps only the newest few
 * hundred calls.
 *
 * Privacy: headers are never kept (they hold the portal token and the client's login). Request and response bodies are
 * kept, cut short and with anything that looks like a secret hidden, only for an API whose "keep bodies" switch is on.
 */

import { generateId, now } from '../util.ts';
import { getSimulationRepository } from '../repositories/simulation.ts';
import type { SimApiRecord } from '../repositories/simulation.ts';
import type { CallOutput } from './call.ts';

const MAX_BODY_CHARS = 2000;
const SECRET_KEY_RE = /pass(word)?|secret|token|authorization|api[-_]?key|cookie|credential/i;

/** The value with anything under a secret-looking key replaced, and long strings shortened. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '…';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([k, v]) => [k, SECRET_KEY_RE.test(k) ? '***' : redact(v, depth + 1)]));
  }
  if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 300)}…`;
  return value;
}

/** Text for the log from a JSON body or a text one; null when there is none. */
function bodyText(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let v: unknown = raw;
  if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch { return `${raw.slice(0, 200)}${raw.length > 200 ? '…' : ''}`; } }
  const text = JSON.stringify(redact(v));
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;
}

export interface LoggedCall {
  via: 'rest' | 'mcp';
  method: string;
  path: string;
  search: string;
  body: unknown;
}

/** Records one answered call. Never throws: a failing log must not fail the call. */
export async function recordCall(api: SimApiRecord, call: LoggedCall, out: CallOutput, ms: number): Promise<void> {
  try {
    const keep = api.log_bodies;
    await getSimulationRepository().appendCall({
      id: generateId(),
      api_id: api.id,
      at: now(),
      via: call.via,
      method: call.method.toUpperCase(),
      path: call.path.slice(0, 300),
      status: out.status,
      mode: out.mode,
      source: out.source,
      rule_id: out.ruleId ?? null,
      warnings: out.warnings,
      ms: Math.max(0, Math.round(ms)),
      request_text: keep ? bodyText(call.body) : null,
      response_text: keep ? bodyText(out.text) : null,
    });
  } catch (e) {
    console.error('[api-sim] could not write the call log:', e instanceof Error ? e.message : e);
  }
}
