/**
 * Running the API cases of a case set, against the simulation or the client's real API, and comparing the two.
 *
 *   GET  /api/projects/:pid/tests/:tpid/api-target
 *   PUT  /api/projects/:pid/tests/:tpid/api-target     {apiIds, target, errorStyle, liveHeaders}
 *   POST /api/projects/:pid/tests/:tpid/case-sets/:csid/api-runs     {target?, caseIds?}
 *   POST /api/projects/:pid/tests/:tpid/case-sets/:csid/api-compare  {caseIds?}
 *   GET  /api/projects/:pid/tests/:tpid/api-runs                     the run history, newest first
 *
 * The work is in api-run-core.ts, shared with the schedule (api-schedule.ts).
 */

import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { auditRaw } from '../audit.ts';
import { requireTestProject, hasScope } from '../testing/helpers.ts';
import { getSimulationRepository } from '../repositories/simulation.ts';
import type { RunTarget } from './api-runner.ts';
import { loadRunContext, parseApiTarget, performCompare, performRun, readApiTarget, readRunHistory, writeApiTarget } from './api-run-core.ts';

export { readApiTarget, parseApiTarget };

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
    await writeApiTarget(tp.id, cfg);
    auditRaw(req.user!.id, 'test_project.api_target', `test_project:${tp.id}`, { target: cfg.target, apis: cfg.apiIds.length });
    sendJson(res, 200, { target: cfg });
  });

  router.get('/api/projects/:pid/tests/:tpid/api-runs', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'viewer');
    if (!tp) return;
    sendJson(res, 200, { runs: readRunHistory(tp.id) });
  });

  async function prepare(req: PortalRequest, res: PortalResponse) {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return null; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return null;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ctx = await loadRunContext(req.params.pid, tp, req.params.csid, Array.isArray(body.caseIds) ? body.caseIds.map(String) : null);
    if ('error' in ctx) { sendJson(res, ctx.status, { error: ctx.error }); return null; }
    return { ctx, body, tp };
  }

  router.post('/api/projects/:pid/tests/:tpid/case-sets/:csid/api-runs', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await prepare(req, res);
    if (!p) return;
    const target: RunTarget = p.body.target === 'live' ? 'live' : p.body.target === 'simulation' ? 'simulation' : p.ctx.cfg.target;
    const out = await performRun(p.ctx, target, 'manual');
    auditRaw(req.user!.id, 'test_case_set.api_run', `test_case_set:${p.ctx.caseSetId}`, { target, ...out.summary });
    sendJson(res, 200, out);
  });

  router.post('/api/projects/:pid/tests/:tpid/case-sets/:csid/api-compare', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const p = await prepare(req, res);
    if (!p) return;
    const out = await performCompare(p.ctx, 'manual');
    auditRaw(req.user!.id, 'test_case_set.api_compare', `test_case_set:${p.ctx.caseSetId}`, { total: out.summary.total, mismatch: out.summary.mismatch });
    sendJson(res, 200, out);
  });
}
