/**
 * Test case runs by an agent: an agent performs the cases of a case set in a browser against the app, and the
 * portal turns what it reports into results, a CSV, and a history with pass and fail counts.
 *
 *   POST /api/projects/:pid/tests/:tpid/case-sets/:csid/agent-runs      start a run (202)
 *   GET  /api/projects/:pid/tests/:tpid/case-sets/:csid/agent-runs      history, with the sheet's current counts
 *   GET  /api/projects/:pid/tests/:tpid/agent-runs/:rid/results.csv     one run's results
 *   GET  /api/projects/:pid/tests/:tpid/case-sets/:csid/results.csv     the sheet as it stands (status and remarks)
 *
 * A run is an ordinary agent session (the person's Kiro or Claude sign-in, with the cloud browser tools). The agent
 * writes results.csv in its run folder; when the session ends the portal reads it, writes each case's Status and
 * Remarks into the sheet, builds its own results CSV, and records the run in the history. The history is a list in
 * the settings (newest first, up to 100 runs per test project); the CSV files live next to the project's other files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { getDb } from '../db.ts';
import { config } from '../config.ts';
import { getSetting, setSetting } from '../settings.ts';
import { persistFile, restoreFile, restoreTree } from '../durable-files.ts';
import { refreshSnapshotIfStale } from '../repositories/settings.ts';
import { newId, now } from '../util.ts';
import { getProjectRow } from '../project-access.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';
import { resolveCreateAi } from '../create-ai.ts';
import { auditRaw } from '../audit.ts';
import { testingRepo } from './data.ts';
import { requireTestProject, hasScope } from './helpers.ts';
import type { TestProject } from './helpers.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CaseRunSummary {
  id: string;
  caseSetId: string;
  caseSetName: string;
  workflowId: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  startedBy: string;
  engine: string;
  model: string;
  total: number;
  pass: number;
  fail: number;
  blocked: number;
  notRun: number;
  error: string | null;
  hasCsv: boolean;
}

interface CaseRow {
  id: string;
  test_id: string;
  category: string;
  scenario: string;
  precondition: string;
  steps: string;
  expected_result: string;
  status: string;
  remarks: string;
  ord: number;
}

export const MAX_CASES_PER_RUN = 60;
const HISTORY_LIMIT = 100;
const historyKey = (tpId: string): string => `tests.caseruns.${tpId}`;
const linkKey = (workflowId: string): string => `tests.caserun.wf.${workflowId}`;

// ── Pure helpers (tested) ─────────────────────────────────────────────────────

export type CaseStatus = 'Pass' | 'Fail' | 'Blocked' | 'Not Run';

/** What an agent wrote in the Status column, as one of the sheet's statuses. */
export function normaliseStatus(raw: string): CaseStatus {
  const s = String(raw ?? '').trim().toLowerCase();
  if (/^(pass|passed|ok|success|successful)\b/.test(s)) return 'Pass';
  if (/^(fail|failed|failure|error)\b/.test(s)) return 'Fail';
  if (/^(blocked|skipped|skip|unable|cannot|can't)\b/.test(s)) return 'Blocked';
  return 'Not Run';
}

/** RFC 4180 reader: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** A CSV field, quoted when needed. A leading = + - @ is defused so a spreadsheet never runs it as a formula. */
export function csvField(v: unknown): string {
  let s = String(v ?? '').replace(/\r\n?/g, '\n');
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface AgentResult { testId: string; status: CaseStatus; remarks: string; evidence: string }

/** The rows of the agent's results.csv, found by header name (any order, any case). */
export function parseAgentResults(text: string): AgentResult[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]): number => head.findIndex((h) => names.includes(h));
  const iId = col('test id', 'testid', 'test_id', 'id');
  const iStatus = col('status', 'result');
  const iRemarks = col('remarks', 'remark', 'notes', 'comment', 'comments');
  const iEvidence = col('evidence', 'screenshot', 'url');
  if (iId < 0 || iStatus < 0) return [];
  return rows.slice(1).map((r) => ({
    testId: (r[iId] ?? '').trim(),
    status: normaliseStatus(r[iStatus] ?? ''),
    remarks: (iRemarks >= 0 ? r[iRemarks] ?? '' : '').trim(),
    evidence: (iEvidence >= 0 ? r[iEvidence] ?? '' : '').trim(),
  })).filter((r) => r.testId);
}

export function tally(statuses: string[]): Pick<CaseRunSummary, 'total' | 'pass' | 'fail' | 'blocked' | 'notRun'> {
  const t = { total: statuses.length, pass: 0, fail: 0, blocked: 0, notRun: 0 };
  for (const s of statuses) {
    if (s === 'Pass') t.pass++;
    else if (s === 'Fail') t.fail++;
    else if (s === 'Blocked') t.blocked++;
    else t.notRun++;
  }
  return t;
}

/** Which cases a run covers: by what they have so far, and optionally one category. */
export function selectCases<T extends { status: string; category: string }>(all: T[], scope: string, category: string): T[] {
  let list = category ? all.filter((c) => c.category === category) : all;
  if (scope === 'notPassed') list = list.filter((c) => c.status !== 'Pass');
  else if (scope === 'notRun') list = list.filter((c) => !c.status || c.status === 'Not Run');
  return list;
}

/** The prompt that makes an agent perform the cases and report in a fixed CSV. */
export function buildRunPrompt(tp: { app_url: string; api_base_url: string | null; rules_for_ai: string }, cases: CaseRow[], instructions: string): string {
  const list = cases.map((c) => [
    `[${c.test_id}] ${c.category ? `${c.category}: ` : ''}${c.scenario}`,
    c.precondition ? `  Precondition: ${c.precondition}` : '',
    `  Steps: ${c.steps}`,
    `  Expected result: ${c.expected_result}`,
  ].filter(Boolean).join('\n')).join('\n\n');
  return [
    'Test execution request',
    `You are a QA tester. Perform the test cases below against the application at ${tp.app_url}, using the browser tools: open pages, click, type, and read what is on the screen.`,
    tp.api_base_url ? `The application's API is at ${tp.api_base_url}.` : '',
    tp.rules_for_ai?.trim() ? `Rules from the team:\n${tp.rules_for_ai.trim()}` : '',
    instructions.trim() ? `Instructions for this run:\n${instructions.trim()}` : '',
    '',
    'For each test case: follow its steps in order, compare what you see with its expected result, and decide:',
    '- Pass: the expected result is what you saw.',
    '- Fail: something differs from the expected result. Say exactly what you saw instead.',
    '- Blocked: you could not perform the case (a login you were not given, a page that does not load, a precondition you cannot create). Say why.',
    'Never invent a result. Do not change data beyond what a case\'s steps ask. If the application cannot be reached at all, mark every case Blocked.',
    '',
    'When you have finished every case, save results.csv in your run folder (the folder you were told to put files in).',
    'Its first line must be exactly: Test ID,Status,Remarks,Evidence',
    'Then one line per test case listed below, in the same order. Status is exactly Pass, Fail or Blocked. Remarks is one or two sentences about what you saw.',
    'Evidence is the page address where you saw it. Put double quotes around any field that contains a comma or a quote.',
    'Reply with one line "Results: results.csv" and then the totals: how many Pass, Fail and Blocked.',
    '',
    `Test cases (${cases.length}):`,
    '',
    list,
  ].filter((l) => l !== null).join('\n');
}

/** The portal's own results CSV for a run: what was executed and how it went. */
export function buildResultsCsv(runId: string, date: string, cases: Array<Pick<CaseRow, 'test_id' | 'category' | 'scenario' | 'expected_result' | 'status' | 'remarks'>>): string {
  const head = ['Run ID', 'Date', 'Test ID', 'Category', 'Scenario', 'Expected Result', 'Status', 'Remarks'];
  const lines = [head.join(',')];
  for (const c of cases) {
    lines.push([runId, date, c.test_id, c.category, c.scenario, c.expected_result, c.status || 'Not Run', c.remarks].map(csvField).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ── History in the settings ───────────────────────────────────────────────────

function readHistory(tpId: string): CaseRunSummary[] {
  try {
    const raw = getSetting(getDb(), historyKey(tpId));
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function writeHistory(tpId: string, list: CaseRunSummary[]): Promise<void> {
  await setSetting(getDb(), historyKey(tpId), JSON.stringify(list.slice(0, HISTORY_LIMIT)));
}

async function patchRun(tpId: string, runId: string, patch: Partial<CaseRunSummary>): Promise<CaseRunSummary | null> {
  const list = readHistory(tpId);
  const i = list.findIndex((r) => r.id === runId);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch };
  await writeHistory(tpId, list);
  return list[i];
}

interface RunLink { tpId: string; runId: string; projectId: string; caseSetId: string; caseIds: string[] }

function readLink(workflowId: string): RunLink | null {
  try {
    const raw = getSetting(getDb(), linkKey(workflowId));
    return raw ? (JSON.parse(raw) as RunLink) : null;
  } catch {
    return null;
  }
}

export function csvPath(slug: string, tpId: string, runId: string): string {
  return path.join(config.dataDir, 'projects', slug, 'tests', tpId, 'case-runs', `${runId}.csv`);
}

// ── Session end: read what the agent reported ─────────────────────────────────

function findResultsFile(dir: string, depth = 0): string | null {
  if (!dir || depth > 3 || !fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'repos' || e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isFile() && /^results\.csv$/i.test(e.name)) return full;
    if (e.isDirectory()) { const f = findResultsFile(full, depth + 1); if (f) return f; }
  }
  return null;
}

/**
 * Whether a session is a case run. The settings are cached per server instance and refreshed at the start of a web
 * request; a session that ends in the background must refresh first, or it cannot see what another instance wrote.
 */
export async function isCaseRunWorkflow(workflowId: string): Promise<boolean> {
  await refreshSnapshotIfStale().catch(() => {});
  return readLink(workflowId) !== null;
}

/** The agent's session ended: write the results into the sheet, build the CSV, and close the run in the history. */
export async function finishCaseRun(workflowId: string, workDir: string, outcome: 'done' | 'failed' | 'cancelled'): Promise<void> {
  await refreshSnapshotIfStale().catch(() => {});
  const link = readLink(workflowId);
  if (!link) return;
  // Closed already (by the session hook or by the history page): never process a run twice.
  if (readHistory(link.tpId).find((r) => r.id === link.runId)?.status !== 'running') return;
  const finishedAt = now();
  const repo = testingRepo();
  try {
    if (outcome !== 'done') {
      await patchRun(link.tpId, link.runId, { status: outcome, finishedAt, error: outcome === 'cancelled' ? 'The run was stopped.' : 'The agent session failed. Open the run to see why.' });
      return;
    }
    // The files the agent sent back are kept on the instance that received them and in storage; fetch them here.
    if (workDir) await restoreTree(workDir).catch(() => {});
    const file = findResultsFile(workDir);
    const results = file ? parseAgentResults(fs.readFileSync(file, 'utf8')) : [];
    const byId = new Map(results.map((r) => [r.testId.toLowerCase(), r]));
    const cases = ((await repo.listCasesByCaseSet(link.caseSetId)) as unknown as CaseRow[]).filter((c) => link.caseIds.includes(c.id)).sort((a, b) => a.ord - b.ord);

    const finalCases: CaseRow[] = [];
    for (const c of cases) {
      const r = byId.get(String(c.test_id).toLowerCase());
      const status: CaseStatus = r ? r.status : 'Not Run';
      const remarks = r ? [r.remarks, r.evidence ? `(${r.evidence})` : ''].filter(Boolean).join(' ') : 'The agent did not report this case.';
      await repo.updateCase(c.id, { status, remarks, updated_at: now() } as never, link.caseSetId);
      finalCases.push({ ...c, status, remarks });
    }

    const project = await getProjectRow(link.projectId);
    const t = tally(finalCases.map((c) => c.status));
    let hasCsv = false;
    if (project && finalCases.length) {
      const abs = csvPath(String(project.slug), link.tpId, link.runId);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buildResultsCsv(link.runId, finishedAt, finalCases), 'utf8');
      await persistFile(abs, 'text/csv');
      hasCsv = true;
    }
    await patchRun(link.tpId, link.runId, {
      status: 'done', finishedAt, hasCsv, ...t,
      error: !file ? 'The agent finished without writing results.csv, so no case has a result. Open the run to see what it did.' : null,
    });
  } catch (e) {
    await patchRun(link.tpId, link.runId, { status: 'failed', finishedAt, error: String((e as Error)?.message ?? e).slice(0, 300) }).catch(() => {});
  }
}

/** A run whose session has ended but was not closed (a lost hook): close it now. */
async function reconcileRuns(tpId: string): Promise<void> {
  for (const r of readHistory(tpId).filter((x) => x.status === 'running')) {
    // A session needs a little while to appear as finished; do not judge a run that has only just started.
    if (Date.now() - Date.parse(r.startedAt) < 30_000) continue;
    const wf = await getSessionsRepository().getWorkflowById(r.workflowId).catch(() => null) as unknown as { status?: string; work_dir?: string } | null;
    if (!wf) continue;
    const st = String(wf.status ?? '');
    if (st === 'done') await finishCaseRun(r.workflowId, String(wf.work_dir ?? ''), 'done');
    else if (st === 'failed' || st === 'error') await finishCaseRun(r.workflowId, '', 'failed');
    else if (st === 'cancelled' || st === 'stopped') await finishCaseRun(r.workflowId, '', 'cancelled');
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

async function caseSetOf(req: PortalRequest, res: PortalResponse, tp: TestProject): Promise<{ id: string; name: string } | null> {
  const cs = (await testingRepo().getCaseSetByTestProjectAndId(tp.id, req.params.csid)) as unknown as { id: string; name: string } | null;
  if (!cs) { sendJson(res, 404, { error: 'Case set not found' }); return null; }
  return cs;
}

function sendCsv(res: PortalResponse, filename: string, body: string): void {
  const buf = Buffer.from(body, 'utf8');
  const r = res as unknown as { writeHead: (c: number, h: Record<string, string | number>) => void; end: (b: Buffer) => void };
  r.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]+/g, '_')}"`,
    'Content-Length': buf.length,
  });
  r.end(buf);
}

export function registerCaseRunRoutes(): void {
  // Start
  router.post('/api/projects/:pid/tests/:tpid/case-sets/:csid/agent-runs', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const cs = await caseSetOf(req, res, tp);
    if (!cs) return;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const all = ((await testingRepo().listCasesByCaseSet(cs.id)) as unknown as CaseRow[]).sort((a, b) => a.ord - b.ord);
    const matching = selectCases(all, String(body.scope ?? (body.onlyNotPassed === true ? 'notPassed' : 'all')), typeof body.category === 'string' ? body.category : '');
    if (!matching.length) { sendJson(res, 400, { error: all.length ? 'No case matches that choice, so there is nothing to run.' : 'This case set has no cases yet.' }); return; }
    // A run is one agent session, so it takes a batch; run again for the next one ("not run yet" picks up where this stopped).
    const cases = matching.slice(0, MAX_CASES_PER_RUN);
    const instructions = typeof body.instructions === 'string' ? body.instructions.slice(0, 4000) : '';
    const ai = await resolveCreateAi(req.user!.id, body);

    const runId = newId('cr_');
    const workflowId = newId('w_');
    const ts = now();
    await getSessionsRepository().createWorkflow({
      id: workflowId,
      project_id: req.params.pid,
      goal: buildRunPrompt(tp, cases, instructions),
      status: 'pending',
      engine: ai.engine,
      trust_tools: 1,
      lead_agent: null,
      workspace_id: null,
      output_files_enabled: 0,
      repo_ids: '[]',
      iteration_count: 0,
      max_iterations: 1,
      credential_id: ai.credential_id,
      model: ai.model,
      created_by: req.user!.id,
      created_at: ts,
      updated_at: ts,
    });

    const summary: CaseRunSummary = {
      id: runId, caseSetId: cs.id, caseSetName: cs.name, workflowId, status: 'running', startedAt: ts, finishedAt: null,
      startedBy: String((req.user as { email?: string }).email ?? req.user!.id), engine: ai.engine, model: ai.model,
      ...tally(cases.map(() => 'Not Run')), error: null, hasCsv: false,
    };
    await writeHistory(tp.id, [summary, ...readHistory(tp.id)]);
    const link: RunLink = { tpId: tp.id, runId, projectId: req.params.pid, caseSetId: cs.id, caseIds: cases.map((c) => c.id) };
    await setSetting(getDb(), linkKey(workflowId), JSON.stringify(link));
    auditRaw(req.user!.id, 'test_case_run.start', `test_case_run:${runId}`, { caseSetId: cs.id, cases: cases.length });

    setTimeout(async () => {
      try {
        const { startRun } = await import('../workflows/driver.ts');
        await startRun(workflowId);
      } catch (e) {
        await patchRun(tp.id, runId, { status: 'failed', finishedAt: now(), error: `The agent could not start: ${String((e as Error)?.message ?? e).slice(0, 200)}` }).catch(() => {});
      }
    }, 0);

    sendJson(res, 202, { runId, workflowId, cases: cases.length, matching: matching.length });
  });

  // History
  router.get('/api/projects/:pid/tests/:tpid/case-sets/:csid/agent-runs', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'viewer');
    if (!tp) return;
    const cs = await caseSetOf(req, res, tp);
    if (!cs) return;
    await reconcileRuns(tp.id).catch((e) => console.warn('[case-runs] reconcile failed:', e instanceof Error ? e.message : e));
    const runs = readHistory(tp.id).filter((r) => r.caseSetId === cs.id);
    const cases = (await testingRepo().listCasesByCaseSet(cs.id)) as unknown as CaseRow[];
    const done = runs.filter((r) => r.status === 'done');
    sendJson(res, 200, {
      runs,
      current: tally(cases.map((c) => c.status)),
      totals: {
        runs: runs.length,
        finished: done.length,
        failedRuns: runs.filter((r) => r.status === 'failed' || r.status === 'cancelled').length,
        casesPassed: done.reduce((n, r) => n + r.pass, 0),
        casesFailed: done.reduce((n, r) => n + r.fail, 0),
        casesBlocked: done.reduce((n, r) => n + r.blocked, 0),
      },
    });
  });

  // One run's CSV
  router.get('/api/projects/:pid/tests/:tpid/agent-runs/:rid/results.csv', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'viewer');
    if (!tp) return;
    const run = readHistory(tp.id).find((r) => r.id === req.params.rid);
    const project = await getProjectRow(req.params.pid);
    if (!run || !project) { sendJson(res, 404, { error: 'Run not found' }); return; }
    const abs = csvPath(String(project.slug), tp.id, run.id);
    if (!run.hasCsv || !(await restoreFile(abs))) { sendJson(res, 404, { error: 'This run has no results file.' }); return; }
    sendCsv(res, `${run.caseSetName}-results-${run.startedAt.slice(0, 10)}.csv`, fs.readFileSync(abs, 'utf8'));
  });

  // The sheet as it stands
  router.get('/api/projects/:pid/tests/:tpid/case-sets/:csid/results.csv', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'viewer');
    if (!tp) return;
    const cs = await caseSetOf(req, res, tp);
    if (!cs) return;
    const cases = ((await testingRepo().listCasesByCaseSet(cs.id)) as unknown as CaseRow[]).sort((a, b) => a.ord - b.ord);
    sendCsv(res, `${cs.name}-results-${now().slice(0, 10)}.csv`, buildResultsCsv('current', now(), cases));
  });
}
