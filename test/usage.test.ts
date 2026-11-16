/**
 * GET /api/usage: what the agents used, by project, person and day. Dollars (Claude) and credits (Kiro) stay apart; an admin sees
 * everything and the per-person table, anyone else only their own projects and no per-person table.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getDb } from '../server/db.ts';
import { now } from '../server/util.ts';
import { hashPassword } from '../server/auth.ts';
import { fillUsageDays } from '../server/usage.ts';
import { newUsageRow } from '../server/repositories/stats.ts';

let baseUrl: string;
let adminCookie: string;
let adminId: string;

before(async () => {
  ({ baseUrl } = await createTestServer());
  await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'admin@usage.test', password: 'adminpass1', name: 'Admin' } });
  const login = await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'admin@usage.test', password: 'adminpass1' } });
  adminCookie = login.cookie ?? '';
  adminId = String(getDb().prepare("SELECT id FROM users WHERE email = 'admin@usage.test'").get()?.id);
});
after(cleanup);

const rnd = (): string => Math.random().toString(36).slice(2, 8);
const seedProject = (name: string): string => {
  const id = `proj-us-${rnd()}`;
  getDb().prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(id, name, `slug-${id}`, now());
  return id;
};
const seedUser = async (tag: string): Promise<{ id: string; cookie: string }> => {
  const id = `user-us-${tag}-${rnd()}`;
  const email = `${id}@usage.test`;
  getDb().prepare("INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)")
    .run(id, email, `${tag} person`, hashPassword('memberpass1'), now());
  const login = await fetchJson(baseUrl, '/api/auth/login', { body: { email, password: 'memberpass1' } });
  return { id, cookie: login.cookie ?? '' };
};
const addMember = (projectId: string, userId: string): void => {
  getDb().prepare("INSERT OR IGNORE INTO project_members (project_id, user_id, access) VALUES (?, ?, 'editor')").run(projectId, userId);
};
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();
/** One usage record, as a finished run leaves it. */
const spend = (projectId: string, userId: string | null, u: { usd?: number; credits?: number; inT?: number; outT?: number; at?: string; provider?: string }): void => {
  getDb().prepare(
    'INSERT INTO budget_usage (user_id, project_id, cost_usd, credits, input_tokens, output_tokens, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(userId, projectId, u.usd ?? 0, u.credits ?? 0, u.inT ?? 0, u.outT ?? 0, u.provider ?? (u.credits ? 'kiro' : 'anthropic'), u.at ?? now());
};
type Totals = { runs: number; costUsd: number; credits: number; tokens: number };
type Row = Totals & { id: string; name: string; engines: Record<'claude' | 'kiro' | 'codex' | 'other', Totals> };
type Usage = { totals: Row; finishedRuns: number; byProject: Row[]; byUser: Row[] | null; byDay: Row[]; period: string };
const get = async (qs: string, cookie = adminCookie) => fetchJson(baseUrl, `/api/usage${qs}`, { cookie });

describe('GET /api/usage', () => {
  test('needs sign-in and a valid period', async () => {
    assert.equal((await fetchJson(baseUrl, '/api/usage')).status, 401);
    assert.equal((await get('?period=1y')).status, 400);
  });

  test('dollars, credits and tokens are totalled apart, by project, person and day', async () => {
    const a = seedProject('Usage Alpha');
    const b = seedProject('Usage Beta');
    const ann = await seedUser('ann');
    // Alpha: Claude $1.50 + $0.50 by ann today; Kiro 10.25 credits by the admin yesterday. Beta: Kiro 4 credits by ann 3 days ago.
    spend(a, ann.id, { usd: 1.5, inT: 1000, outT: 500 });
    spend(a, ann.id, { usd: 0.5, inT: 100, outT: 100 });
    spend(a, adminId, { credits: 10.25, at: daysAgo(1) });
    spend(b, ann.id, { credits: 4, at: daysAgo(3) });
    // Codex reports tokens only (no dollars), recorded under its own provider name.
    spend(b, adminId, { provider: 'codex-subscription', inT: 2000, outT: 500, at: daysAgo(4) });
    const r = await get(`?period=7d`);
    assert.equal(r.status, 200);
    const body = r.body as Usage;
    const alpha = body.byProject.find((p) => p.id === a)!;
    const beta = body.byProject.find((p) => p.id === b)!;
    assert.deepEqual([alpha.name, alpha.runs, alpha.costUsd, alpha.credits, alpha.tokens], ['Usage Alpha', 3, 2, 10.25, 1700]);
    assert.deepEqual([beta.runs, beta.costUsd, beta.credits, beta.tokens], [2, 0, 4, 2500]);
    // Each engine on its own: Claude's dollars, Kiro's credits, Codex's tokens (and no dollars).
    assert.deepEqual(alpha.engines.claude, { runs: 2, costUsd: 2, credits: 0, tokens: 1700 });
    assert.deepEqual(alpha.engines.kiro, { runs: 1, costUsd: 0, credits: 10.25, tokens: 0 });
    assert.equal(alpha.engines.codex.runs, 0);
    assert.deepEqual(beta.engines.codex, { runs: 1, costUsd: 0, credits: 0, tokens: 2500 });
    assert.deepEqual(beta.engines.kiro, { runs: 1, costUsd: 0, credits: 4, tokens: 0 });
    // Never added: the credits are not in the dollars, the Codex tokens are not Claude's.
    assert.equal(body.totals.costUsd, 2);
    assert.equal(body.totals.credits, 14.25);
    assert.equal(body.totals.runs, 5);
    assert.deepEqual([body.totals.engines.claude.tokens, body.totals.engines.codex.tokens, body.totals.engines.kiro.credits], [1700, 2500, 14.25]);
    // By person (admin only).
    const annRow = body.byUser!.find((u) => u.id === ann.id)!;
    assert.deepEqual([annRow.name, annRow.runs, annRow.costUsd, annRow.credits], ['ann person', 3, 2, 4]);
    assert.equal(body.byUser!.find((u) => u.id === adminId)!.credits, 10.25);
    // Biggest spender first (by dollars, then credits).
    assert.equal(body.byProject[0].id, a);
    // By day: every day of the window, oldest first, quiet days are zero.
    assert.equal(body.byDay.length, 7);
    assert.deepEqual([...body.byDay.map((d) => d.id)].sort(), body.byDay.map((d) => d.id));
    assert.equal(body.byDay[6].id, new Date().toISOString().slice(0, 10));
    const today = body.byDay[6];
    assert.deepEqual([today.runs, today.costUsd, today.credits], [2, 2, 0]);
    assert.equal(body.byDay.find((d) => d.id === daysAgo(1).slice(0, 10))!.credits, 10.25);
    assert.equal(body.byDay.find((d) => d.id === daysAgo(2).slice(0, 10))!.runs, 0);
    const codexDay = body.byDay.find((d) => d.id === daysAgo(4).slice(0, 10))!;
    assert.deepEqual([codexDay.engines.codex.tokens, codexDay.engines.claude.runs], [2500, 0], 'a day shows which engine used it');
  });

  test('the window: 30 days by default, usage older than the period is left out', async () => {
    const p = seedProject('Usage Window');
    spend(p, adminId, { credits: 5, at: daysAgo(2) });
    spend(p, adminId, { credits: 100, at: daysAgo(20) });
    const week = (await get(`?period=7d&projectId=${p}`)).body as Usage;
    assert.equal(week.totals.credits, 5);
    const month = (await get(`?projectId=${p}`)).body as Usage;
    assert.equal(month.period, '30d');
    assert.equal(month.byDay.length, 30);
    assert.equal(month.totals.credits, 105);
    assert.equal(((await get(`?period=90d&projectId=${p}`)).body as Usage).byDay.length, 90);
  });

  test('a project filter limits the project table, the per-person table and the totals', async () => {
    const p1 = seedProject('Usage Only One');
    const p2 = seedProject('Usage Not Chosen');
    spend(p1, adminId, { credits: 1 });
    spend(p2, adminId, { credits: 2 });
    const body = (await get(`?projectId=${p1}`)).body as Usage;
    assert.deepEqual(body.byProject.map((x) => x.id), [p1]);
    assert.equal(body.totals.credits, 1);
    // The per-person totals are for the chosen project only (not everything the person used).
    assert.equal(body.byUser!.find((u) => u.id === adminId)!.credits, 1);
  });

  test('runs that finished without reporting usage are told apart from a period with no runs', async () => {
    const p = seedProject('Usage Quiet');
    const wid = `wf-us-${rnd()}`;
    const ts = now();
    getDb().prepare("INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, lead_agent, created_at, updated_at) VALUES (?, ?, 'g', 'done', 'kiro', 0, 'default', ?, ?)").run(wid, p, ts, ts);
    getDb().prepare("INSERT INTO p6_runs (id, workflow_id, status, started_at, finished_at, cost_usd, input_tokens, output_tokens, created_at) VALUES (?, ?, 'done', ?, ?, 0, 0, 0, ?)").run(`run-us-${rnd()}`, wid, ts, ts, ts);
    const body = (await get(`?projectId=${p}`)).body as Usage;
    assert.deepEqual([body.totals.runs, body.totals.credits, body.totals.costUsd], [0, 0, 0]);
    assert.equal(body.finishedRuns, 1, 'one run finished, but none reported usage');
    const empty = (await get(`?projectId=${seedProject('Usage Empty')}`)).body as Usage;
    assert.equal(empty.finishedRuns, 0);
  });

  test('a member sees only their own projects and no per-person table; a project that is not theirs is refused', async () => {
    const mine = seedProject('Usage Mine');
    const theirs = seedProject('Usage Theirs');
    const me = await seedUser('mem');
    addMember(mine, me.id);
    spend(mine, me.id, { credits: 3 });
    spend(theirs, adminId, { credits: 50 });
    const r = await get('', me.cookie);
    assert.equal(r.status, 200);
    const body = r.body as Usage;
    assert.deepEqual(body.byProject.map((p) => p.id), [mine], 'only the project they belong to');
    assert.equal(body.totals.credits, 3);
    assert.equal(body.byUser, null, 'no per-person table: it would show what colleagues used');
    assert.equal(JSON.stringify(body).includes('Usage Theirs'), false, 'nothing about the other project leaks');
    assert.equal((await get(`?projectId=${theirs}`, me.cookie)).status, 403);
    const asAdmin = (await get(`?projectId=${theirs}`)).body as Usage;
    assert.equal(asAdmin.totals.credits, 50);
  });

  test('fillUsageDays gives every day and leaves the quiet ones at zero', () => {
    const day11 = newUsageRow('2026-11-11', '2026-11-11');
    day11.runs = 2;
    const out = fillUsageDays('2026-11-10', 3, [day11]);
    assert.deepEqual(out.map((d) => d.id), ['2026-11-10', '2026-11-11', '2026-11-12']);
    assert.deepEqual(out.map((d) => d.runs), [0, 2, 0]);
  });
});
