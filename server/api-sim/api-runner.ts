/**
 * Runs the API cases of a case set without a browser: against the simulation (in-process, no network) or against the
 * client's real API (HTTP, SSRF-checked). The same cases and the same checks are used for both, so a case that passes
 * on the simulation and fails on the live API is a place where the client's API differs from their own document.
 *
 * Checks per case: the status (exact on the simulation; tolerant on the live API, where the document does not say how
 * errors are reported), and for a successful call the response body against the specification's response fields.
 */

import { getSetting } from '../settings.ts';
import { getDb } from '../db.ts';
import { fetchWithSsrfCheck } from '../testing/runner.ts';
import { resolveVaultRefs } from '../testing/vault.ts';
import type { SimApiRecord } from '../repositories/simulation.ts';
import { handleMockRequest, locateOperation } from './mock-engine.ts';
import { validateValue } from './schema.ts';
import type { ApiSpec, MockRule, Schema } from './types.ts';

export type RunTarget = 'simulation' | 'live';
export type ErrorStyle = { kind: 'http' } | { kind: 'code'; field: string; successValue: string };

export interface ApiTargetConfig {
  /** Empty means every API of the project. */
  apiIds: string[];
  target: RunTarget;
  /** How the client's real API reports a rejected request. Unknown until someone says. */
  errorStyle: ErrorStyle;
  /** Replace the case's header of the same name when calling the live API (values may use {{vault.NAME.value}}). */
  liveHeaders: Record<string, string>;
}

export const DEFAULT_TARGET: ApiTargetConfig = { apiIds: [], target: 'simulation', errorStyle: { kind: 'http' }, liveHeaders: {} };

export interface TargetApi { api: SimApiRecord; spec: ApiSpec; rules: MockRule[] }

export interface CaseInput { id: string; testId: string; scenario: string; request: string | null; response: string | null }

export interface CaseOutcome {
  caseId: string;
  testId: string;
  scenario: string;
  outcome: 'pass' | 'fail' | 'skipped';
  reason: string;
  expectedStatus: number | null;
  actualStatus: number | null;
  durationMs: number;
}

interface Called { status: number; body: unknown }

const LIVE_TIMEOUT_MS = 15_000;
const LIVE_CONCURRENCY = 4;

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function partsOf(url: string): { path: string; search: string; query: Record<string, string> } {
  try {
    const u = new URL(url, 'http://placeholder.invalid');
    return { path: u.pathname, search: u.search, query: Object.fromEntries(u.searchParams) };
  } catch { return { path: url, search: '', query: {} }; }
}

function responseSchemaOf(spec: ApiSpec, method: string, path: string): Schema | null {
  const found = locateOperation(spec, method, path);
  if (!found) return null;
  const code = Object.keys(found.operation.responses).filter((c) => /^2\d\d$/.test(c)).sort()[0];
  return (code && found.operation.responses[code]?.content?.['application/json']?.schema) || null;
}

function schemaProblems(body: unknown, schema: Schema | null): string | null {
  if (!schema || !schema.properties || Object.keys(schema.properties).length === 0) return null;
  if (body === null || typeof body !== 'object') return 'The response is not a JSON object.';
  const errors = validateValue(body, schema, 'response').errors;
  if (errors.length === 0) return null;
  return `The response does not match the specification: ${errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}${errors.length > 3 ? ` (+${errors.length - 3} more)` : ''}.`;
}

/** Whether what came back is what the case expects. Exported for tests. */
export function judgeResponse(a: {
  target: RunTarget; expected: number; actual: number; body: unknown; errorStyle: ErrorStyle; schema: Schema | null;
}): { ok: boolean; reason: string } {
  const { target, expected, actual, body, errorStyle, schema } = a;
  const code = errorStyle.kind === 'code' && body && typeof body === 'object' ? (body as Record<string, unknown>)[errorStyle.field] : undefined;
  const reportsError = errorStyle.kind === 'code' && code !== undefined && String(code) !== errorStyle.successValue;

  if (target === 'simulation') {
    if (actual !== expected) return { ok: false, reason: `Expected HTTP ${expected}, the simulation answered ${actual}.` };
  } else if (expected === 401) {
    if (actual !== 401 && actual !== 403) return { ok: false, reason: `Expected the request to be refused (401), the API answered ${actual}.` };
    return { ok: true, reason: `Refused with ${actual}.` };
  } else if (expected < 300) {
    if (actual < 200 || actual > 299) return { ok: false, reason: `Expected success (HTTP ${expected}), the API answered ${actual}.` };
    if (reportsError) return { ok: false, reason: `The API answered ${actual} but reported an error: ${errorStyle.kind === 'code' ? `${errorStyle.field} = ${String(code)}` : ''}.` };
  } else if (expected >= 400 && expected < 500) {
    const rejected = (actual >= 400 && actual < 500) || (actual >= 200 && actual < 300 && reportsError);
    if (!rejected) {
      return { ok: false, reason: actual >= 200 && actual < 300
        ? `The API accepted a request that should be rejected (HTTP ${actual}${errorStyle.kind === 'code' ? `, ${errorStyle.field} = ${String(code ?? 'missing')}` : ''}).`
        : `Expected the request to be rejected (4xx), the API answered ${actual}.` };
    }
    return { ok: true, reason: `Rejected as expected (${actual}${reportsError ? `, ${(errorStyle as { field: string }).field} = ${String(code)}` : ''}).` };
  } else if (actual !== expected) {
    return { ok: false, reason: `Expected HTTP ${expected}, the API answered ${actual}.` };
  }

  if (expected < 300) {
    const problem = schemaProblems(body, schema);
    if (problem) return { ok: false, reason: problem };
  }
  return { ok: true, reason: `HTTP ${actual} as expected${expected < 300 && schema ? ', and the response matches the specification' : ''}.` };
}

async function callLive(t: TargetApi, testProjectId: string, cfg: ApiTargetConfig, method: string, path: string, search: string, headers: Record<string, string>, body: unknown): Promise<Called> {
  const base = t.api.live_base_url;
  const url = base.replace(/\/+$/, '') + path + search;
  const out: Record<string, string> = { 'Content-Type': 'application/json' };
  for (const [k, v] of Object.entries(headers)) out[k] = v;
  // A live header replaces the case's header of the same name (the placeholder token becomes the real one). It is not
  // added to a case that does not send it, or the "no login token" case would carry a token and could never fail.
  for (const [k, v] of Object.entries(cfg.liveHeaders)) {
    const present = Object.keys(out).find((h) => h.toLowerCase() === k.toLowerCase());
    if (present) out[present] = await resolveVaultRefs(v, testProjectId);
  }
  const allowPrivate = getSetting(getDb(), 'test.allowPrivateNetworks') !== 'false';
  const resp = await fetchWithSsrfCheck(url, method, out, body !== undefined ? JSON.stringify(body) : undefined, LIVE_TIMEOUT_MS, allowPrivate);
  const text = await resp.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* leave as text */ }
  return { status: resp.status, body: parsed };
}

async function runOne(c: CaseInput, target: RunTarget, apis: TargetApi[], cfg: ApiTargetConfig, testProjectId: string): Promise<CaseOutcome> {
  const started = Date.now();
  const base = { caseId: c.id, testId: c.testId, scenario: c.scenario };
  const skip = (reason: string, expected: number | null = null): CaseOutcome => ({ ...base, outcome: 'skipped', reason, expectedStatus: expected, actualStatus: null, durationMs: Date.now() - started });

  const req = parseJson<{ method?: string; url?: string; headers?: Record<string, string>; body?: unknown }>(c.request);
  const res = parseJson<{ status?: number | null }>(c.response);
  if (!req?.url || !req.method) return skip('No request is written for this case, so it needs a person.');
  if (res?.status === undefined || res?.status === null) return skip('No expected status is written for this case, so it needs a person.');
  const expected = Number(res.status);
  const method = req.method.toUpperCase();
  const { path, search, query } = partsOf(req.url);

  const t = apis.find((x) => locateOperation(x.spec, method, path));
  if (!t) return skip(`No API in the target handles ${method} ${path}. If the API's path changed since these cases were made, generate them again.`, expected);

  try {
    let called: Called;
    if (target === 'simulation') {
      const r = handleMockRequest(t.spec, t.rules, { method, path, query, headers: req.headers ?? {}, body: req.body }, { requireExplicitRule: t.api.require_explicit_rule });
      called = { status: r.status, body: r.body };
    } else {
      if (!t.api.live_base_url) return skip(`${t.api.name} has no live address. Set it on the API simulation tab, under Settings.`, expected);
      called = await callLive(t, testProjectId, cfg, method, path, search, req.headers ?? {}, req.body);
    }
    const verdict = judgeResponse({ target, expected, actual: called.status, body: called.body, errorStyle: cfg.errorStyle, schema: responseSchemaOf(t.spec, method, path) });
    return { ...base, outcome: verdict.ok ? 'pass' : 'fail', reason: verdict.reason, expectedStatus: expected, actualStatus: called.status, durationMs: Date.now() - started };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...base, outcome: 'fail', reason: `The call failed: ${msg.replace(/https?:\/\/\S+/g, '[url]').slice(0, 160)}`, expectedStatus: expected, actualStatus: null, durationMs: Date.now() - started };
  }
}

/** Runs the cases (a few at a time against a live API, one by one in-process). Order of results follows the input. */
export async function runApiCases(cases: CaseInput[], target: RunTarget, apis: TargetApi[], cfg: ApiTargetConfig, testProjectId: string): Promise<CaseOutcome[]> {
  const results: CaseOutcome[] = new Array(cases.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= cases.length) return;
      results[i] = await runOne(cases[i], target, apis, cfg, testProjectId);
    }
  };
  await Promise.all(Array.from({ length: target === 'live' ? LIVE_CONCURRENCY : 1 }, worker));
  return results;
}
