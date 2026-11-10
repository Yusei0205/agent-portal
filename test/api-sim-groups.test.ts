/**
 * Groups: the APIs of one client or document, with a label on each version of the document, removed together.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { cleanGroup, sameGroup } from '../server/api-sim/import-drafts.ts';
import { getSimulationRepository } from '../server/repositories/simulation.ts';

const HEAD = ['NO.', 'FIELD NAME', '(M)andatory or (O)ptional or Conditional or Echo', 'Data Type', 'Data Length', 'FIELD NAME DESCRIPTION', 'REMARKS'];
async function workbook(sheetName: string, extra: string[][] = []): Promise<string> {
  const rows = [
    ['1. Request'], ['API Name', sheetName], ['Method', 'POST'], ['Authentication', 'None'], HEAD,
    ['1', 'applicationNumber', 'M', 'String', '20', 'Application number'], ...extra,
    ['2. Response'], ['API Name', sheetName], HEAD, ['1', 'id', 'M', 'String', '-', 'Request id'],
  ];
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

describe('group names', () => {
  test('are tidied, bounded and compared without regard to case', () => {
    assert.equal(cleanGroup('  Client   A \n'), 'Client A');
    assert.equal(cleanGroup(undefined), '');
    assert.equal(cleanGroup('x'.repeat(300)).length, 120);
    assert.equal(sameGroup('Flash', ' flash '), true);
    assert.equal(sameGroup('Flash', 'Flash 2'), false);
    assert.equal(sameGroup('', ''), true);
  });
});

describe('a database that skipped the migration', () => {
  test('is repaired when opened: the simulation tables and the group and label columns come back', async () => {
    const { openDb, closeDb, isDbOpen } = await import('../server/db.ts');
    const { DatabaseSync } = await import('node:sqlite');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const file = path.join(os.tmpdir(), `sim-schema-${Date.now()}.db`);
    if (isDbOpen()) closeDb();

    openDb(file); // a normal start creates everything
    closeDb();

    // What a database looks like when another branch had already claimed this migration number
    const raw = new DatabaseSync(file);
    raw.exec('DROP INDEX IF EXISTS sim_apis_group; ALTER TABLE sim_apis DROP COLUMN group_name; ALTER TABLE sim_spec_versions DROP COLUMN label; DROP TABLE sim_rules;');
    const cols = (t: string): string[] => (raw.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!cols('sim_apis').includes('group_name'));
    raw.close();

    openDb(file);
    closeDb();
    const again = new DatabaseSync(file);
    const names = (t: string): string[] => (again.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(names('sim_apis').includes('group_name'));
    assert.ok(names('sim_spec_versions').includes('label'));
    assert.ok(names('sim_rules').includes('rule_json'));
    // and opening it a third time changes nothing
    again.close();
    openDb(file);
    closeDb();
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(file + ext, { force: true });
  });
});

describe('groups of APIs', () => {
  let baseUrl: string;
  let cookie: string;
  let outsider: string;
  let pid: string;
  const m = (p: string) => `/api/projects/${pid}/sim${p}`;
  const imp = async (sheet: string, group: string | undefined, label?: string, extra: string[][] = []) => {
    const r = await fetchJson(baseUrl, m('/import'), { body: { kind: 'xlsx', contentBase64: await workbook(sheet, extra), ...(group !== undefined ? { group } : {}), ...(label ? { label } : {}) }, cookie });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return (r.body as { created: Array<{ id: string; name: string; version: number; isNew: boolean; group: string }> }).created[0];
  };
  const list = async () => ((await fetchJson(baseUrl, m('/apis'), { cookie })).body as { apis: Array<{ id: string; name: string; group: string }> }).apis;

  before(async () => {
    baseUrl = (await createTestServer()).baseUrl;
    await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'a@groups.test', password: 'adminpassword1', name: 'A' } });
    cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'a@groups.test', password: 'adminpassword1' } })).cookie ?? '';
    await fetchJson(baseUrl, '/api/users', { method: 'POST', body: { email: 'o@groups.test', name: 'O', password: 'outsiderpass1', isAdmin: false }, cookie });
    outsider = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'o@groups.test', password: 'outsiderpass1' } })).cookie ?? '';
    pid = ((await fetchJson(baseUrl, '/api/projects', { body: { name: 'G' }, cookie })).body as { project: { id: string } }).project.id;
  });
  after(cleanup);

  let flashId: string;

  test('an import goes into the group it is given, with a label on its version', async () => {
    const a = await imp('Login', 'Flash', 'v1.9');
    flashId = a.id;
    assert.equal(a.group, 'Flash');
    assert.equal(a.isNew, true);
    const detail = (await fetchJson(baseUrl, m(`/apis/${a.id}`), { cookie })).body as { api: { group: string }; versions: Array<{ version: number; label: string }> };
    assert.equal(detail.api.group, 'Flash');
    assert.deepEqual(detail.versions.map((v) => [v.version, v.label]), [[1, 'v1.9']]);
  });

  test('reading the document again into the same group adds a labelled version, whatever the case of the name', async () => {
    const a = await imp('Login', ' flash ', 'v2.0', [['2', 'action', 'M', 'String', '20', 'Action']]);
    assert.equal(a.id, flashId);
    assert.equal(a.version, 2);
    assert.equal(a.isNew, false);
    const detail = (await fetchJson(baseUrl, m(`/apis/${flashId}`), { cookie })).body as { versions: Array<{ version: number; label: string }> };
    assert.deepEqual(detail.versions.map((v) => [v.version, v.label]), [[1, 'v1.9'], [2, 'v2.0']]);
  });

  test('the same document in ANOTHER group is a separate copy, not a new version', async () => {
    const copy = await imp('Login', 'Flash UAT', 'v1.9');
    assert.notEqual(copy.id, flashId);
    assert.equal(copy.isNew, true);
    assert.equal(copy.version, 1);
  });

  test('APIs with no group are possible, and do not match a grouped one', async () => {
    const loose = await imp('Login', undefined);
    assert.equal(loose.isNew, true);
    assert.equal(loose.group, '');
    await imp('Other', 'Flash');
    const apis = await list();
    assert.deepEqual(apis.map((a) => `${a.group}|${a.name}`).sort(), ['Flash UAT|Login', 'Flash|Login', 'Flash|Other', '|Login'].sort());
  });

  test('the groups are listed with how many APIs each holds', async () => {
    const g = (await fetchJson(baseUrl, m('/groups'), { cookie })).body as { groups: Array<{ name: string; count: number }> };
    assert.deepEqual(g.groups.map((x) => `${x.name || '(none)'}:${x.count}`), ['(none):1', 'Flash:2', 'Flash UAT:1']);
  });

  test('an API can be moved to another group', async () => {
    const apis = await list();
    const loose = apis.find((a) => a.group === '')!;
    const r = await fetchJson(baseUrl, m(`/apis/${loose.id}`), { method: 'PUT', body: { group: 'Flash UAT' }, cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((r.body as { api: { group: string } }).api.group, 'Flash UAT');
  });

  test('a group can be renamed', async () => {
    assert.equal((await fetchJson(baseUrl, m('/groups'), { method: 'PUT', body: { from: 'Nope', to: 'X' }, cookie })).status, 404);
    assert.equal((await fetchJson(baseUrl, m('/groups'), { method: 'PUT', body: { from: 'Flash', to: ' ' }, cookie })).status, 400);
    const r = await fetchJson(baseUrl, m('/groups'), { method: 'PUT', body: { from: 'flash UAT', to: 'Flash (UAT)' }, cookie });
    assert.equal((r.body as { renamed: number }).renamed, 2);
    assert.deepEqual((await list()).filter((a) => a.group === 'Flash (UAT)').length, 2);
  });

  test('removing a group removes every API in it, with their versions and rules, and leaves the others', async () => {
    const repo = getSimulationRepository();
    await fetchJson(baseUrl, m(`/apis/${flashId}/rules/r1`), { method: 'PUT', body: { operationId: 'login', name: 'x', failure: 'timeout' }, cookie });
    assert.equal((await repo.listRules(flashId)).length, 1);
    assert.equal((await repo.listVersions(flashId)).length, 2);

    const r = await fetchJson(baseUrl, m('/groups?name=FLASH'), { method: 'DELETE', cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((r.body as { removed: number }).removed, 2);
    assert.deepEqual(await repo.listRules(flashId), []);
    assert.deepEqual(await repo.listVersions(flashId), []);
    assert.equal(await repo.getApi(pid, flashId), null);
    assert.deepEqual((await list()).map((a) => a.group), ['Flash (UAT)', 'Flash (UAT)']);
  });

  test('"no group" is not a group that can be removed, an unknown group is a 404, and only members may', async () => {
    assert.equal((await fetchJson(baseUrl, m('/groups?name='), { method: 'DELETE', cookie })).status, 400);
    assert.equal((await fetchJson(baseUrl, m('/groups'), { method: 'DELETE', cookie })).status, 400);
    assert.equal((await fetchJson(baseUrl, m('/groups?name=Ghost'), { method: 'DELETE', cookie })).status, 404);
    assert.equal((await fetchJson(baseUrl, m('/groups?name=Flash%20(UAT)'), { method: 'DELETE', cookie: outsider })).status, 404);
    assert.equal((await list()).length, 2);
  });
});
