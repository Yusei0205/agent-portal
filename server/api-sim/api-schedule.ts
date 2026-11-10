/**
 * Scheduled API test runs: a case set run against the simulation, the live API, or both, on a cron schedule, with the
 * outcome in the test project's run history. This is how the API tests become part of the overall test automation.
 *
 *   GET    /api/projects/:pid/tests/:tpid/api-schedules
 *   PUT    /api/projects/:pid/tests/:tpid/case-sets/:csid/api-schedule    {enabled, cron, target}
 *   DELETE /api/projects/:pid/tests/:tpid/case-sets/:csid/api-schedule
 *
 * Schedules are held in one list (`apischedules` setting) so a tick does not have to look through every project. A tick
 * (the `api-test-runs` job, once a minute: EventBridge Scheduler on AWS, a timer locally) runs the schedules whose cron
 * matches the current minute. A run is made as the person who set the schedule up, and only while they are still an
 * editor or owner of the project; otherwise the run is skipped and the history says so. Nothing is kept between ticks,
 * so a missed tick just skips that firing.
 */

import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { generateId, now } from '../util.ts';
import { getSetting, setSetting } from '../settings.ts';
import { getDb, isDbOpen } from '../db.ts';
import { auditRaw } from '../audit.ts';
import { getProjectRepository } from '../repositories/projects.ts';
import { testingRepo } from '../testing/data.ts';
import { requireTestProject, hasScope } from '../testing/helpers.ts';
import type { TestProject } from '../testing/helpers.ts';
import { parseCron } from '../loop-triggers.ts';
import { addRunHistory, loadRunContext, performCompare, performRun } from './api-run-core.ts';

export interface ApiSchedule {
  id: string;
  projectId: string;
  testProjectId: string;
  caseSetId: string;
  cron: string;
  target: 'simulation' | 'live' | 'compare';
  enabled: boolean;
  runAs: string;
  lastRunAt: string | null;
}

const KEY = 'apischedules';
const MAX_SCHEDULES = 100;
/** How many times a day a schedule may fire: the simulation is free, the live API is somebody else's server. */
const MAX_PER_DAY = { simulation: 288, live: 96, compare: 96 } as const;

export function readSchedules(): ApiSchedule[] {
  try {
    const raw = getSetting(getDb(), KEY);
    return raw ? (JSON.parse(raw) as ApiSchedule[]) : [];
  } catch { return []; }
}

async function writeSchedules(list: ApiSchedule[]): Promise<void> { await setSetting(getDb(), KEY, JSON.stringify(list)); }

/** Null when the schedule is acceptable; otherwise what is wrong with it. */
export function scheduleProblem(cron: string, target: string): string | null {
  if (!['simulation', 'live', 'compare'].includes(target)) return 'target must be "simulation", "live" or "compare".';
  let matches: (d: Date) => boolean;
  try { matches = parseCron(cron); } catch (e) { return (e as Error).message; }
  // Count the firings in one day. A fixed Monday, so a cron limited to a day of the week is counted fairly.
  let n = 0;
  const start = Date.UTC(2026, 0, 5, 0, 0, 0);
  for (let m = 0; m < 1440; m++) if (matches(new Date(start + m * 60_000))) n++;
  const limit = MAX_PER_DAY[target as keyof typeof MAX_PER_DAY];
  if (n > limit) return `That fires up to ${n} times a day. For ${target === 'simulation' ? 'the simulation' : 'the live API'} the limit is ${limit} (every ${Math.round(1440 / limit)} minutes).`;
  return null;
}

/** Runs one schedule now, as its owner. Returns a short text for the log. */
async function fire(s: ApiSchedule): Promise<string> {
  const role = await getProjectRepository().roleOf(s.projectId, s.runAs);
  const allowed = role === 'owner' || role === 'editor';
  const tp = (await testingRepo().getTestProjectByProjectAndId(s.projectId, s.testProjectId)) as unknown as TestProject | null;
  const cs = tp ? await testingRepo().getCaseSetByTestProjectAndId(tp.id, s.caseSetId) : null;

  const skip = async (error: string): Promise<string> => {
    if (tp) await addRunHistory(tp.id, { id: generateId(), at: now(), caseSetId: s.caseSetId, caseSetName: cs?.name ?? '', target: s.target, trigger: 'schedule', total: 0, pass: 0, fail: 0, skipped: 0, error });
    return error;
  };
  if (!allowed) return skip('Skipped: the person who set this schedule up is no longer an editor of the project.');
  if (!tp || !cs) return skip('Skipped: the test project or case set no longer exists.');

  const ctx = await loadRunContext(s.projectId, tp, s.caseSetId, null);
  if ('error' in ctx) return skip(`Skipped: ${ctx.error}`);
  if (s.target === 'compare') {
    const r = await performCompare(ctx, 'schedule');
    return `compare: ${r.summary.match} same, ${r.summary.mismatch} differ`;
  }
  const r = await performRun(ctx, s.target, 'schedule');
  return `${s.target}: ${r.summary.pass} pass, ${r.summary.fail} fail`;
}

/** The once-a-minute job: run every enabled schedule whose cron matches this minute. */
export async function runDueSchedules(at: Date = new Date()): Promise<Array<{ id: string; result: string }>> {
  const out: Array<{ id: string; result: string }> = [];
  const minute = Math.floor(at.getTime() / 60_000);
  const list = readSchedules();
  let changed = false;
  for (const s of list) {
    if (!s.enabled) continue;
    let due = false;
    try { due = parseCron(s.cron)(at); } catch { due = false; }
    if (!due) continue;
    if (s.lastRunAt && Math.floor(Date.parse(s.lastRunAt) / 60_000) >= minute) continue; // this minute was already handled
    s.lastRunAt = at.toISOString();
    changed = true;
    try { out.push({ id: s.id, result: await fire(s) }); } catch (e) {
      out.push({ id: s.id, result: `failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}` });
    }
  }
  if (changed) await writeSchedules(list);
  return out;
}

/** Started once from index.ts for a local portal; on Lambda the `api-test-runs` schedule calls runDueSchedules. */
export function startScheduleTimer(onLambda: boolean): void {
  const t = setInterval(() => {
    if (!onLambda && isDbOpen()) void runDueSchedules().catch((e) => console.error('[api-schedule] tick failed:', e));
  }, 60_000);
  t.unref();
}

const view = (s: ApiSchedule) => ({ id: s.id, caseSetId: s.caseSetId, cron: s.cron, target: s.target, enabled: s.enabled, lastRunAt: s.lastRunAt });

export function registerApiScheduleRoutes(): void {
  router.get('/api/projects/:pid/tests/:tpid/api-schedules', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'viewer');
    if (!tp) return;
    sendJson(res, 200, { schedules: readSchedules().filter((s) => s.testProjectId === tp.id).map(view) });
  });

  router.put('/api/projects/:pid/tests/:tpid/case-sets/:csid/api-schedule', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const cs = await testingRepo().getCaseSetByTestProjectAndId(tp.id, req.params.csid);
    if (!cs) { sendJson(res, 404, { error: 'Case set not found' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cron = String(body.cron ?? '').trim();
    const target = String(body.target ?? 'simulation');
    const problem = scheduleProblem(cron, target);
    if (problem) { sendJson(res, 400, { error: problem }); return; }

    const list = readSchedules();
    const existing = list.find((s) => s.testProjectId === tp.id && s.caseSetId === cs.id);
    if (!existing && list.length >= MAX_SCHEDULES) { sendJson(res, 400, { error: `At most ${MAX_SCHEDULES} schedules.` }); return; }
    const s: ApiSchedule = {
      id: existing?.id ?? generateId(), projectId: req.params.pid, testProjectId: tp.id, caseSetId: cs.id, cron,
      target: target as ApiSchedule['target'], enabled: body.enabled !== false, runAs: req.user!.id, lastRunAt: existing?.lastRunAt ?? null,
    };
    await writeSchedules([...list.filter((x) => x.id !== s.id), s]);
    auditRaw(req.user!.id, 'test_case_set.api_schedule', `test_case_set:${cs.id}`, { cron, target, enabled: s.enabled });
    sendJson(res, 200, { schedule: view(s) });
  });

  router.delete('/api/projects/:pid/tests/:tpid/case-sets/:csid/api-schedule', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const list = readSchedules();
    const next = list.filter((s) => !(s.testProjectId === tp.id && s.caseSetId === req.params.csid));
    if (next.length === list.length) { sendJson(res, 404, { error: 'No schedule for this case set' }); return; }
    await writeSchedules(next);
    sendJson(res, 200, { ok: true });
  });
}
