/**
 * Running the API cases of a case set, against the simulation or the client's real API, and comparing the two.
 *
 *   GET  /api/projects/:pid/tests/:tpid/api-target
 *   PUT  /api/projects/:pid/tests/:tpid/api-target     {apiIds, target, errorStyle, liveHeaders}
 *   POST /api/projects/:pid/tests/:tpid/case-sets/:csid/api-runs     {target?, caseIds?}
 *   POST /api/projects/:pid/tests/:tpid/case-sets/:csid/api-compare  {caseIds?}
 *
 * A run writes each case's Status (Pass / Fail) and a "Run [...]" line at the top of its Remarks, so the sheet, its
 * Excel export and the agent runs keep working on the same rows. Cases that need a person (no request or expected
 * status) are skipped and left as they are.
 */

import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { now } from '../util.ts';
import { getSetting, setSetting } from '../settings.ts';
import { getDb } from '../db.ts';
import { auditRaw } from '../audit.ts';
import { testingRepo } from '../testing/data.ts';
import { requireTestProject, hasScope } from '../testing/helpers.ts';
import { getSimulationRepository } from '../repositories/simulation.ts';
import { DEFAULT_TARGET, runApiCases } from './api-runner.ts';
import type { ApiTargetConfig, CaseInput, CaseOutcome, ErrorStyle, RunTarget, TargetApi } from './api-runner.ts';

const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const SECRET_HEADER_RE = /authorization|api[-_]?key|token|secret|cookie|password/i;
const settingKey = (tpid: string): string => `apitarget.${tpid}`;

export function readApiTarget(testProjectId: string): ApiTargetConfig {
  try {
    const raw = getSetting(getDb(), settingKey(testProjectId));
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

function summarise(results: CaseOutcome[]) {
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

export function registerApiRunRoutes(): void {
  router.get('/api/projects/:pid/tests/:tpid/api-target', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'viewer');
    if (!tp) return;
    sendJson(res, 200, { target: readApiTarget(tp.id) });
  });

  router.put('/api/projects/:pid/tests/:tpid/api-target', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const cfg = parseApiTarget((req.body ?? {}) as Record<string, unknown>);
    if (typeof cfg === 'string') { sendJson(res, 400, { error: cfg }); return; }
    const known = new Set((await getSimulationRepository().listApis(req.params.pid)).map((a) => a.id));
    if (cfg.apiIds.some((id) => !known.has(id))) { sendJson(res, 400, { error: 'One of the chosen APIs is not in this project' }); return; }
    await setSetting(getDb(), settingKey(tp.id), JSON.stringify(cfg));
    auditRaw(req.user!.id, 'test_project.api_target', `test_project:${tp.id}`, { target: cfg.target, apis: cfg.apiIds.length });
    sendJson(res, 200, { target: cfg });
  });

  async function prepare(req: PortalRequest, res: PortalResponse) {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return null; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return null;
    const cs = await testingRepo().getCaseSetByTestProjectAndId(tp.id, req.params.csid);
    if (!cs) { sendJson(res, 404, { error: 'Case set not found' }); return null; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const only = Array.isArray(body.caseIds) ? new Set(body.caseIds.map(String)) : null;
    const rows = (await testingRepo().listCasesByCaseSet(cs.id)).sort((a, b) => a.ord - b.ord).filter((c) => !only || only.has(c.id));
    const cfg = readApiTarget(tp.id);
    const apis = await loadTargetApis(req.params.pid, cfg.apiIds);
    if (apis.length === 0) { sendJson(res, 400, { error: 'There are no APIs to run against. Import one on the API simulation tab first.' }); return null; }
    const cases: CaseInput[] = rows.map((c) => ({ id: c.id, testId: c.test_id, scenario: c.scenario, request: c.request, response: c.response }));
    return { tp, cs, rows, cfg, apis, cases, body };
  }

  router.post('/api/projects/:pid/tests/:tpid/case-sets/:csid/api-runs', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await prepare(req, res);
    if (!p) return;
    const target: RunTarget = p.body.target === 'live' ? 'live' : p.body.target === 'simulation' ? 'simulation' : p.cfg.target;
    const results = await runApiCases(p.cases, target, p.apis, p.cfg, p.tp.id);
    const byId = new Map(p.rows.map((r) => [r.id, r]));
    for (const r of results) {
      if (r.outcome === 'skipped') continue;
      const row = byId.get(r.caseId)!;
      await testingRepo().updateCase(r.caseId, {
        status: r.outcome === 'pass' ? 'Pass' : 'Fail',
        remarks: withRunLine(row.remarks, `Run [${label(target)}] ${r.outcome === 'pass' ? 'Pass' : 'Fail'}: ${r.reason}`),
        updated_at: now(),
      }, p.cs.id);
    }
    auditRaw(req.user!.id, 'test_case_set.api_run', `test_case_set:${p.cs.id}`, { target, ...summarise(results) });
    sendJson(res, 200, { target, summary: summarise(results), results });
  });

  router.post('/api/projects/:pid/tests/:tpid/case-sets/:csid/api-compare', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await prepare(req, res);
    if (!p) return;
    const sim = await runApiCases(p.cases, 'simulation', p.apis, p.cfg, p.tp.id);
    const live = await runApiCases(p.cases, 'live', p.apis, p.cfg, p.tp.id);
    const byId = new Map(p.rows.map((r) => [r.id, r]));

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
      }, p.cs.id);
    }
    const count = (v: string): number => rows.filter((r) => r.verdict === v).length;
    auditRaw(req.user!.id, 'test_case_set.api_compare', `test_case_set:${p.cs.id}`, { total: rows.length, mismatch: count('mismatch') });
    sendJson(res, 200, {
      summary: { total: rows.length, match: count('match'), mismatch: count('mismatch'), bothFail: count('both_fail'), liveOnly: count('live_only'), notRun: count('not_run') },
      simulation: summarise(sim),
      live: summarise(live),
      rows,
    });
  });
}
