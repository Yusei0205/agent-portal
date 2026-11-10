/**
 * Running the API cases of a case set and recording the outcome: the part shared by the Run button, the Compare view and
 * the schedule (api-schedule.ts).
 *
 * A run writes each case's Status (Pass / Fail) and a "Run [...]" line at the top of its Remarks, and adds one entry to
 * the test project's run history (newest first, the last 50 kept). Cases that need a person are skipped and left as they are.
 */

import { now } from '../util.ts';
import { getSetting, setSetting } from '../settings.ts';
import { getDb } from '../db.ts';
import { testingRepo } from '../testing/data.ts';
import { getSimulationRepository } from '../repositories/simulation.ts';
import type { TestProject } from '../testing/helpers.ts';
import { DEFAULT_TARGET, runApiCases } from './api-runner.ts';
import type { ApiTargetConfig, CaseInput, CaseOutcome, ErrorStyle, RunTarget, TargetApi } from './api-runner.ts';

const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const SECRET_HEADER_RE = /authorization|api[-_]?key|token|secret|cookie|password/i;
const HISTORY_KEEP = 50;

const targetKey = (tpid: string): string => `apitarget.${tpid}`;
const historyKey = (tpid: string): string => `apiruns.${tpid}`;

// ── Target settings ───────────────────────────────────────────────────────────

export function readApiTarget(testProjectId: string): ApiTargetConfig {
  try {
    const raw = getSetting(getDb(), targetKey(testProjectId));
    if (!raw) return { ...DEFAULT_TARGET };
    const v = JSON.parse(raw) as Partial<ApiTargetConfig>;
    return {
      apiIds: Array.isArray(v.apiIds) ? v.apiIds.map(String) : [],
      target: v.target === 'live' ? 'live' : 'simulation',
      errorStyle: v.errorStyle && v.errorStyle.kind === 'code' ? v.errorStyle : { kind: 'http' },
      liveHeaders: v.liveHeaders && typeof v.liveHeaders === 'object' ? v.liveHeaders : {},
    };
  } catch {
    return { ...DEFAULT_TARGET };
  }
}

export async function writeApiTarget(testProjectId: string, cfg: ApiTargetConfig): Promise<void> {
  await setSetting(getDb(), targetKey(testProjectId), JSON.stringify(cfg));
}

/** Validates a target config from a request body. Returns the config or a message. */
export function parseApiTarget(body: Record<string, unknown>): ApiTargetConfig | string {
  const apiIds = Array.isArray(body.apiIds) ? body.apiIds.map(String).slice(0, 50) : [];
  const target: RunTarget = body.target === 'live' ? 'live' : 'simulation';
  let errorStyle: ErrorStyle = { kind: 'http' };
  if (body.errorStyle && typeof body.errorStyle === 'object') {
    const e = body.errorStyle as Record<string, unknown>;
    if (e.kind === 'code') {
      const field = String(e.field ?? '').trim();
      const successValue = String(e.successValue ?? '').trim();
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(field)) return 'errorStyle.field must be a field name such as "code"';
      if (!successValue || successValue.length > 64) return 'errorStyle.successValue must be 1-64 characters, such as "00"';
      errorStyle = { kind: 'code', field, successValue };
    } else if (e.kind !== 'http') {
      return 'errorStyle.kind must be "http" or "code"';
    }
  }
  const liveHeaders: Record<string, string> = {};
  if (body.liveHeaders !== undefined) {
    if (!body.liveHeaders || typeof body.liveHeaders !== 'object' || Array.isArray(body.liveHeaders)) return 'liveHeaders must be an object';
    const entries = Object.entries(body.liveHeaders as Record<string, unknown>);
    if (entries.length > 10) return 'At most 10 live headers';
    for (const [k, v] of entries) {
      if (!HEADER_NAME_RE.test(k)) return `"${k}" is not a valid header name`;
      if (typeof v !== 'string' || v.length > 2000 || /[\r\n]/.test(v)) return `Header "${k}" has an invalid value`;
      // These settings are not encrypted, so a credential must be a reference to the vault, never the secret itself.
      if (SECRET_HEADER_RE.test(k) && !/\{\{vault\.[^.}]+\.(value|password|username)\}\}/.test(v)) {
        return `Header "${k}" looks like a credential. Store it in the Vault and enter {{vault.NAME.value}} here.`;
      }
      liveHeaders[k] = v;
    }
  }
  return { apiIds, target, errorStyle, liveHeaders };
}

// ── History ───────────────────────────────────────────────────────────────────

export interface RunHistoryEntry {
  id: string;
  at: string;
  caseSetId: string;
  caseSetName: string;
  /** What ran: the simulation, the live API, or both compared. */
  target: RunTarget | 'compare';
  trigger: 'manual' | 'schedule';
  total: number;
  pass: number;
  fail: number;
  skipped: number;
  /** Compare only: passes on the simulation, fails live. */
  mismatch?: number;
  error?: string;
}

export function readRunHistory(testProjectId: string): RunHistoryEntry[] {
  try {
    const raw = getSetting(getDb(), historyKey(testProjectId));
    return raw ? (JSON.parse(raw) as RunHistoryEntry[]) : [];
  } catch { return []; }
}

export async function addRunHistory(testProjectId: string, entry: RunHistoryEntry): Promise<void> {
  const list = [entry, ...readRunHistory(testProjectId)].slice(0, HISTORY_KEEP);
  await setSetting(getDb(), historyKey(testProjectId), JSON.stringify(list));
}

// ── Running ───────────────────────────────────────────────────────────────────

async function loadTargetApis(projectId: string, apiIds: string[]): Promise<TargetApi[]> {
  const repo = getSimulationRepository();
  const all = await repo.listApis(projectId);
  const chosen = apiIds.length > 0 ? all.filter((a) => apiIds.includes(a.id)) : all;
  const out: TargetApi[] = [];
  for (const api of chosen) {
    const ver = await repo.getVersion(api.id, api.approved_version > 0 ? api.approved_version : api.latest_version);
    if (ver) out.push({ api, spec: ver.spec, rules: await repo.listRules(api.id) });
  }
  return out;
}

export interface RunContext {
  tp: TestProject;
  caseSetId: string;
  caseSetName: string;
  rows: Array<{ id: string; test_id: string; scenario: string; request: string | null; response: string | null; remarks: string; ord: number }>;
  cfg: ApiTargetConfig;
  apis: TargetApi[];
  cases: CaseInput[];
}

/** Loads what a run needs. A string means "cannot run", with the reason. */
export async function loadRunContext(projectId: string, tp: TestProject, caseSetId: string, caseIds: string[] | null): Promise<RunContext | { error: string; status: number }> {
  const cs = await testingRepo().getCaseSetByTestProjectAndId(tp.id, caseSetId);
  if (!cs) return { error: 'Case set not found', status: 404 };
  const only = caseIds ? new Set(caseIds) : null;
  const rows = (await testingRepo().listCasesByCaseSet(cs.id)).sort((a, b) => a.ord - b.ord).filter((c) => !only || only.has(c.id));
  const cfg = readApiTarget(tp.id);
  const apis = await loadTargetApis(projectId, cfg.apiIds);
  if (apis.length === 0) return { error: 'There are no APIs to run against. Import one on the API simulation tab first.', status: 400 };
  const cases: CaseInput[] = rows.map((c) => ({ id: c.id, testId: c.test_id, scenario: c.scenario, request: c.request, response: c.response }));
  return { tp, caseSetId: cs.id, caseSetName: cs.name, rows, cfg, apis, cases };
}

export function summarise(results: CaseOutcome[]) {
  return {
    total: results.length,
    pass: results.filter((r) => r.outcome === 'pass').length,
    fail: results.filter((r) => r.outcome === 'fail').length,
    skipped: results.filter((r) => r.outcome === 'skipped').length,
  };
}

const label = (t: RunTarget): string => (t === 'live' ? 'Live API' : 'Simulation');

/** Puts one "Run [...]" line on top of a case's remarks, replacing the one from the last run. */
function withRunLine(existing: string, line: string): string {
  const kept = (existing || '').split('\n').filter((l) => !l.startsWith('Run ['));
  return [line, ...kept].join('\n').trim().slice(0, 4000);
}

export async function performRun(ctx: RunContext, target: RunTarget, trigger: RunHistoryEntry['trigger']) {
  const results = await runApiCases(ctx.cases, target, ctx.apis, ctx.cfg, ctx.tp.id);
  const byId = new Map(ctx.rows.map((r) => [r.id, r]));
  for (const r of results) {
    if (r.outcome === 'skipped') continue;
    const row = byId.get(r.caseId)!;
    await testingRepo().updateCase(r.caseId, {
      status: r.outcome === 'pass' ? 'Pass' : 'Fail',
      remarks: withRunLine(row.remarks, `Run [${label(target)}] ${r.outcome === 'pass' ? 'Pass' : 'Fail'}: ${r.reason}`),
      updated_at: now(),
    }, ctx.caseSetId);
  }
  const summary = summarise(results);
  await addRunHistory(ctx.tp.id, { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: now(), caseSetId: ctx.caseSetId, caseSetName: ctx.caseSetName, target, trigger, ...summary });
  return { target, summary, results };
}

export async function performCompare(ctx: RunContext, trigger: RunHistoryEntry['trigger']) {
  const sim = await runApiCases(ctx.cases, 'simulation', ctx.apis, ctx.cfg, ctx.tp.id);
  const live = await runApiCases(ctx.cases, 'live', ctx.apis, ctx.cfg, ctx.tp.id);
  const byId = new Map(ctx.rows.map((r) => [r.id, r]));

  const rows = sim.map((s, i) => {
    const l = live[i];
    let verdict: 'match' | 'mismatch' | 'both_fail' | 'live_only' | 'not_run';
    if (s.outcome === 'skipped' && l.outcome === 'skipped') verdict = 'not_run';
    else if (s.outcome === 'pass' && l.outcome === 'pass') verdict = 'match';
    else if (s.outcome === 'pass' && l.outcome === 'fail') verdict = 'mismatch';
    else if (s.outcome === 'fail' && l.outcome === 'fail') verdict = 'both_fail';
    else if (s.outcome === 'fail' && l.outcome === 'pass') verdict = 'live_only';
    else verdict = l.outcome === 'skipped' ? 'not_run' : 'match';
    return { caseId: s.caseId, testId: s.testId, scenario: s.scenario, verdict, simulation: s, live: l };
  });

  for (const r of rows) {
    if (r.verdict === 'not_run') continue;
    const row = byId.get(r.caseId)!;
    const decisive = r.live.outcome !== 'skipped' ? r.live : r.simulation;
    await testingRepo().updateCase(r.caseId, {
      status: decisive.outcome === 'pass' ? 'Pass' : 'Fail',
      remarks: withRunLine(row.remarks, `Run [Compare] Simulation: ${r.simulation.outcome}; Live: ${r.live.outcome}${r.live.outcome === 'fail' ? ` (${r.live.reason})` : ''}`),
      updated_at: now(),
    }, ctx.caseSetId);
  }
  const count = (v: string): number => rows.filter((r) => r.verdict === v).length;
  const summary = { total: rows.length, match: count('match'), mismatch: count('mismatch'), bothFail: count('both_fail'), liveOnly: count('live_only'), notRun: count('not_run') };
  const liveSummary = summarise(live);
  await addRunHistory(ctx.tp.id, {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: now(), caseSetId: ctx.caseSetId, caseSetName: ctx.caseSetName,
    target: 'compare', trigger, total: rows.length, pass: summary.match, fail: summary.mismatch + summary.bothFail + summary.liveOnly, skipped: summary.notRun, mismatch: summary.mismatch,
  });
  return { summary, simulation: summarise(sim), live: liveSummary, rows };
}
