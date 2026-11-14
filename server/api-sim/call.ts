/**
 * Answering one call to a simulated API: simulated by the engine, or forwarded to the client's real API, depending on
 * the API's mode. Shared by the hosted REST endpoint and the MCP tools, so both behave the same.
 *
 * The portal's own API token never gets here: callers pass the headers the *client's* API should see, with the client's
 * credential already moved into `authorization`.
 */

import { assertNotBlocked } from '../testing/ssrf.ts';
import { guardedFetch } from '../testing/guarded-fetch.ts';
import type { SimApiRecord, SimVersionRecord } from '../repositories/simulation.ts';
import { handleMockRequest, locateOperation } from './mock-engine.ts';
import type { MockRule } from './types.ts';
import { readLiveHeaders } from './live-credentials.ts';
import { getSimulationRepository } from '../repositories/simulation.ts';

export interface CallInput {
  method: string;
  /** Path below the API's base, starting with "/". */
  path: string;
  /** Including the leading "?", or empty. */
  search: string;
  headers: Record<string, string>;
  rawBody: Buffer;
  /** The body as JSON, when it is JSON. */
  body: unknown;
}

export interface CallOutput {
  status: number;
  headers: Record<string, string>;
  text: string;
  mode: 'mock' | 'live';
  delayMs: number;
  warnings: number;
  ruleId?: string;
  source: string;
}

const HOP = new Set(['host', 'connection', 'content-length', 'cookie', 'x-requested-with', 'transfer-encoding', 'accept-encoding', 'authorization', 'x-sim-authorization']);

/** Headers safe to hand to the client's API: nothing hop-by-hop, nothing of the portal's, and the client's login as `authorization`. */
export function clientHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (HOP.has(k.toLowerCase()) || v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  const clientAuth = raw['x-sim-authorization'];
  if (typeof clientAuth === 'string' && clientAuth) out['authorization'] = clientAuth;
  return out;
}

/** Calls through the hosted address and the MCP tools never reach private addresses. Test hook only. */
let allowPrivateAddresses = false;
export function _allowPrivateAddressesForTests(allow: boolean): void { allowPrivateAddresses = allow; }

async function forwardLive(base: string, input: CallInput): Promise<{ status: number; type: string; text: string }> {
  const url = base.replace(/\/+$/, '') + input.path + input.search;
  await assertNotBlocked(url, allowPrivateAddresses);
  const res = await guardedFetch(url, {
    method: input.method,
    headers: input.headers,
    body: input.rawBody.length > 0 && input.method !== 'GET' && input.method !== 'HEAD' ? new Uint8Array(input.rawBody) : undefined,
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  }, allowPrivateAddresses);
  return { status: res.status, type: res.headers.get('content-type') ?? 'application/json', text: await res.text() };
}

const json = (status: number, body: unknown, source: string, mode: 'mock' | 'live'): CallOutput => ({
  status, headers: { 'Content-Type': 'application/json', 'x-sim-source': source }, text: JSON.stringify(body), mode, delayMs: 0, warnings: 0, source,
});

export async function answerCall(api: SimApiRecord, ver: SimVersionRecord, rules: MockRule[], input: CallInput, opts: { persist?: boolean } = {}): Promise<CallOutput> {
  const loc = locateOperation(ver.spec, input.method, input.path);
  const mode: 'mock' | 'live' = api.mode === 'live' ? 'live' : api.mode === 'hybrid' && loc ? (api.operation_modes[loc.operation.operationId] ?? 'mock') : 'mock';

  if (mode === 'live') {
    if (!api.live_base_url) return json(409, { error: 'LIVE_NOT_CONFIGURED', message: 'This API is set to live but has no live address.' }, 'live', 'live');
    try {
      // The login stored for this API is used where the caller sent none of its own (a caller's header of the same name wins).
      const stored = readLiveHeaders(api.live_headers_enc);
      const have = new Set(Object.keys(input.headers).map((h) => h.toLowerCase()));
      const headers = { ...Object.fromEntries(Object.entries(stored).filter(([k]) => !have.has(k.toLowerCase()))), ...input.headers };
      const r = await forwardLive(api.live_base_url, { ...input, headers });
      return { status: r.status, headers: { 'Content-Type': r.type, 'x-sim-source': 'live' }, text: r.text, mode, delayMs: 0, warnings: 0, source: 'live' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json(502, { error: 'LIVE_CALL_FAILED', message: msg.replace(/https?:\/\/\S+/g, '[url]').slice(0, 200) }, 'live', 'live');
    }
  }

  // Records are only read when some rule uses them.
  const usesStore = rules.some((r) => r.store);
  const data = usesStore ? await getSimulationRepository().loadRecords(api.id) : undefined;
  const { authorization, ...others } = input.headers;
  const result = handleMockRequest(ver.spec, rules, {
    method: input.method,
    path: input.path,
    query: Object.fromEntries(new URLSearchParams(input.search)),
    headers: { ...others, ...(authorization ? { authorization } : {}) },
    body: input.body,
  }, { requireExplicitRule: api.require_explicit_rule, data });
  if (usesStore && result.changes?.length && opts.persist !== false) await getSimulationRepository().applyChanges(api.id, result.changes);
  const headers = { ...result.headers };
  if (result.warnings.length > 0) headers['x-mock-warnings'] = String(result.warnings.length);
  return {
    status: result.status,
    headers,
    text: typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? null),
    mode,
    delayMs: result.delayMs,
    warnings: result.warnings.length,
    ruleId: result.ruleId,
    source: result.source,
  };
}
