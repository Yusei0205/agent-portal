/**
 * Scheduled API test runs, and the run history they and the Run button share.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { readSchedules, runDueSchedules, scheduleProblem } from '../server/api-sim/api-schedule.ts';
import { setSetting } from '../server/settings.ts';
import { getDb } from '../server/db.ts';
import { JOBS } from '../server/scheduled-jobs.ts';

describe('what a schedule may ask for', () => {
  test('the simulation may run every 5 minutes, the live API only every 15', () => {
    assert.equal(scheduleProblem('*/5 * * * *', 'simulation'), null);
    assert.equal(scheduleProblem('0 9 * * 1-5', 'compare'), null);
    assert.equal(scheduleProblem('*/15 * * * *', 'live'), null);
    assert.match(scheduleProblem('* * * * *', 'simulation')!, /1440 times a day|the limit is 288/);
    assert.match(scheduleProblem('*/5 * * * *', 'live')!, /the limit is 96/);
    assert.match(scheduleProblem('*/10 * * * *', 'compare')!, /the limit is 96/);
  });
  test('a bad expression or target says what is wrong', () => {
    assert.match(scheduleProblem('every day', 'simulation')!, /5 fields/);
    assert.match(scheduleProblem('61 * * * *', 'simulation')!, /outside/);
    assert.match(scheduleProblem('0 9 * * *', 'tomorrow')!, /target must be/);
  });
  test('the cloud job table has the job that the schedule calls', () => {
    assert.equal(typeof (JOBS as Record<string, unknown>)['api-test-runs'], 'function');
  });
});

const HEAD = ['NO.', 'FIELD NAME', '(M)andatory or (O)ptional or Conditional or Echo', 'Data Type', 'Data Length', 'FIELD NAME DESCRIPTION', 'REMARKS'];
async function workbook(): Promise<string> {
  const rows = [
    ['1. Request'], ['API Name', 'UpdateFlash'], ['Method', 'POST'], ['Authentication', 'None'], HEAD,
    ['1', 'applicationNumber', 'M', 'String', '20', 'Application number'],
    ['2. Response'], ['API Name', 'UpdateFlash'], HEAD, ['1', 'id', 'M', 'String', '-', 'Request id'],
  ];
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('UpdateFlash');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

describe('schedules and the run history', () => {
  let baseUrl: string;
  let cookie: string;
  let outsider: string;
  let pid: string;
  let tpid: string;
  let csId: string;
  const t = () => `/api/projects/${pid}/tests/${tpid}`;
  const history = async () => ((await fetchJson(baseUrl, `${t()}/api-runs`, { cookie })).body as { runs: Array<{ trigger: string; target: string; pass: number; fail: number; total: number; error?: string; mismatch?: number }> }).runs;
  const at = (hh: number, mm: number) => new Date(Date.UTC(2026, 0, 5, hh, mm, 0));

  before(async () => {
    baseUrl = (await createTestServer()).baseUrl;
    await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'a@sched.test', password: 'adminpassword1', name: 'A' } });
    cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'a@sched.test', password: 'adminpassword1' } })).cookie ?? '';
    await fetchJson(baseUrl, '/api/users', { method: 'POST', body: { email: 'o@sched.test', name: 'O', password: 'outsiderpass1', isAdmin: false }, cookie });
    outsider = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'o@sched.test', password: 'outsiderpass1' } })).cookie ?? '';
    pid = ((await fetchJson(baseUrl, '/api/projects', { body: { name: 'S' }, cookie })).body as { project: { id: string } }).project.id;
    tpid = ((await fetchJson(baseUrl, `/api/projects/${pid}/tests`, { body: { name: 'T', appUrl: 'https://app.example' }, cookie })).body as { testProject: { id: string } }).testProject.id;
    const imp = await fetchJson(baseUrl, `/api/projects/${pid}/sim/import`, { body: { kind: 'xlsx', contentBase64: await workbook(), paths: { UpdateFlash: '/flash/update' } }, cookie });
    const apiId = (imp.body as { created: Array<{ id: string }> }).created[0].id;
    await fetchJson(baseUrl, `/api/projects/${pid}/sim/apis/${apiId}/versions/1/approve`, { body: {}, cookie });
    const gen = await fetchJson(baseUrl, `${t()}/case-sets/from-api`, { body: { source: { kind: 'sim', apiIds: [apiId] } }, cookie });
    csId = (gen.body as { caseSet: { id: string } }).caseSet.id;
  });
  after(cleanup);

  const put = (body: unknown, cookieOverride = cookie) => fetchJson(baseUrl, `${t()}/case-sets/${csId}/api-schedule`, { method: 'PUT', body, cookie: cookieOverride });

  test('a schedule is validated, saved, and listed; saving again keeps the same one', async () => {
    assert.equal((await put({ cron: '* * * * *', target: 'simulation' })).status, 400);
    assert.equal((await put({ cron: '*/5 * * * *', target: 'live' })).status, 400);
    assert.equal((await put({ cron: '*/5 * * * *', target: 'simulation' }, outsider)).status, 404);
    const ok = await put({ cron: '*/5 * * * *', target: 'simulation' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const id = (ok.body as { schedule: { id: string } }).schedule.id;
    const again = await put({ cron: '*/10 * * * *', target: 'simulation', enabled: true });
    assert.equal((again.body as { schedule: { id: string; cron: string } }).schedule.id, id);
    const list = (await fetchJson(baseUrl, `${t()}/api-schedules`, { cookie })).body as { schedules: Array<{ cron: string; caseSetId: string }> };
    assert.deepEqual(list.schedules.map((s) => [s.caseSetId, s.cron]), [[csId, '*/10 * * * *']]);
    assert.equal(readSchedules().length, 1);
  });

  test('at a matching minute the cases run once, as a scheduled run, and the sheet and the history show it', async () => {
    await put({ cron: '*/5 * * * *', target: 'simulation' });
    assert.deepEqual(await runDueSchedules(at(10, 7)), []); // not a matching minute
    const ran = await runDueSchedules(at(10, 5));
    assert.equal(ran.length, 1);
    assert.match(ran[0].result, /^simulation: \d+ pass, 0 fail/);
    assert.deepEqual(await runDueSchedules(at(10, 5)), []); // the same minute is not run twice

    const h = await history();
    assert.equal(h[0].trigger, 'schedule');
    assert.equal(h[0].target, 'simulation');
    assert.ok(h[0].pass >= 4, `only ${h[0].pass} cases passed`);
    assert.equal(h[0].fail, 0);
    const sheet = (await fetchJson(baseUrl, `${t()}/case-sets/${csId}`, { cookie })).body as { cases: Array<{ status: string; remarks: string }> };
    assert.equal(sheet.cases[0].status, 'Pass');
    assert.match(sheet.cases[0].remarks, /^Run \[Simulation\] Pass/);
    assert.ok(readSchedules()[0].lastRunAt, 'the time of the run was not kept');
  });

  test('the Run button writes to the same history, as a manual run', async () => {
    const r = await fetchJson(baseUrl, `${t()}/case-sets/${csId}/api-runs`, { body: { target: 'simulation' }, cookie });
    assert.equal(r.status, 200);
    const h = await history();
    assert.deepEqual(h.slice(0, 2).map((x) => x.trigger), ['manual', 'schedule']);
  });

  test('a compare schedule runs both and records how many cases differ', async () => {
    await put({ cron: '0 13 * * 1', target: 'compare' }); // Mondays 13:00 UTC; 2026-01-05 is a Monday, and this is after the last run
    const ran = await runDueSchedules(at(13, 0));
    assert.equal(ran.length, 1);
    assert.match(ran[0].result, /^compare: /);
    const top = (await history())[0];
    assert.equal(top.target, 'compare');
    assert.equal(top.mismatch, 0); // no live address, so nothing could differ
  });

  test('a disabled schedule does not run', async () => {
    await put({ cron: '*/5 * * * *', target: 'simulation', enabled: false });
    assert.deepEqual(await runDueSchedules(at(14, 0)), []);
  });

  test('a schedule whose owner is no longer an editor is skipped, and the history says so', async () => {
    const list = readSchedules();
    list[0].enabled = true;
    list[0].runAs = 'a-person-who-left';
    list[0].lastRunAt = null;
    await setSetting(getDb(), 'apischedules', JSON.stringify(list));
    const before = (await history()).length;
    const ran = await runDueSchedules(at(15, 0));
    assert.match(ran[0].result, /no longer an editor/);
    const h = await history();
    assert.equal(h.length, before + 1);
    assert.match(String(h[0].error), /no longer an editor/);
    assert.equal(h[0].total, 0);
  });

  test('deleting the schedule removes it; deleting a missing one is a 404', async () => {
    const del = (cookieOverride = cookie) => fetchJson(baseUrl, `${t()}/case-sets/${csId}/api-schedule`, { method: 'DELETE', cookie: cookieOverride });
    assert.equal((await del(outsider)).status, 404);
    assert.equal((await del()).status, 200);
    assert.equal((await del()).status, 404);
    assert.deepEqual(readSchedules(), []);
  });
});
