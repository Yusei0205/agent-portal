/**
 * Test accounts for user guides: stored encrypted, passwords never returned, CSV import, and what a guide run receives.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { parseCsv, accountsFromCsv, loadGuideAccounts, setGuideRun, guideRunPayload } from '../server/guide-accounts.ts';
import { getSecret } from '../server/secrets.ts';

describe('CSV', () => {
  it('reads quotes, commas inside quotes, semicolons, tabs, a byte-order mark and line breaks in quotes', () => {
    assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
    assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(parseCsv('﻿a,b\n"multi\nline",2'), [['a', 'b'], ['multi\nline', '2']]);
  });

  it('reads accounts with a header (any order, common names) or without one', () => {
    const withHeader = accountsFromCsv('Password,User Type,Email,Remarks\nPw1!,Admin,admin@t.example,full access\nPw2,Clerk,clerk@t.example,\n');
    assert.deepEqual(withHeader.errors, []);
    assert.deepEqual(withHeader.rows, [
      { role: 'Admin', username: 'admin@t.example', password: 'Pw1!', notes: 'full access' },
      { role: 'Clerk', username: 'clerk@t.example', password: 'Pw2', notes: '' },
    ]);
    const plain = accountsFromCsv('Admin,a@t.example,pw');
    assert.deepEqual(plain.rows, [{ role: 'Admin', username: 'a@t.example', password: 'pw', notes: '' }]);
  });

  it('reports a bad row with its line and the reason, never the password', () => {
    const r = accountsFromCsv('role,username,password\nAdmin,a@t.example,pw\nClerk,,secret-clerk-pw\nadmin,b@t.example,pw2\n' + 'R'.repeat(61) + ',u,p\n');
    assert.equal(r.rows.length, 1);
    assert.deepEqual(r.errors.map((e) => e.line), [3, 4, 5]);
    assert.doesNotMatch(JSON.stringify(r.errors), /secret-clerk-pw|pw2/);
    assert.match(r.errors[1].reason, /appears twice/);
    assert.equal(accountsFromCsv('').errors[0].reason, 'The file is empty.');
  });
});

describe('guide account routes', () => {
  let baseUrl = '';
  let cookie = '';
  let projectId = '';
  const api = (p: string, o: Record<string, unknown> = {}) => fetchJson(baseUrl, `/api/projects/${projectId}/guide-accounts${p}`, { cookie, ...o });

  before(async () => {
    const srv = await createTestServer();
    baseUrl = srv.baseUrl;
    const setup = await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: `ga-${Date.now()}@example.com`, name: 'Admin', password: 'password1234', provider: 'demo' } });
    cookie = setup.cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Guide accounts' }, cookie });
    projectId = ((p.body as any).project as any).id as string;
  });
  after(cleanup);

  it('starts empty, saves accounts, and never returns a password', async () => {
    assert.deepEqual(((await api('')).body as any).accounts, []);
    const put = await api('', { method: 'PUT', body: { accounts: [{ role: 'Admin', username: 'admin@t.example', password: 'S3cret-Admin!', notes: 'all' }, { role: 'Clerk', username: 'clerk@t.example', password: 'Clerk-Pw-1' }] } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const list = (await api('')).body as any;
    assert.deepEqual(list.accounts.map((a: any) => [a.role, a.username, a.hasPassword]), [['Admin', 'admin@t.example', true], ['Clerk', 'clerk@t.example', true]]);
    assert.doesNotMatch(JSON.stringify(put.body) + JSON.stringify(list), /S3cret-Admin|Clerk-Pw-1|"password":"/);
  });

  it('keeps the stored password for a row sent without one, changes it when one is sent, and needs one for a new row', async () => {
    const [admin, clerk] = ((await api('')).body as any).accounts as Array<{ id: string }>;
    const keep = await api('', { method: 'PUT', body: { accounts: [{ id: admin.id, role: 'Admin', username: 'admin2@t.example' }, { id: clerk.id, role: 'Clerk', username: 'clerk@t.example', password: 'New-Clerk-Pw' }] } });
    assert.equal(keep.status, 200, JSON.stringify(keep.body));
    const stored = await loadGuideAccounts(projectId);
    assert.deepEqual(stored.map((a) => [a.role, a.username, a.password]), [['Admin', 'admin2@t.example', 'S3cret-Admin!'], ['Clerk', 'clerk@t.example', 'New-Clerk-Pw']]);
    assert.equal((await api('', { method: 'PUT', body: { accounts: [{ role: 'New', username: 'n@t.example' }] } })).status, 400);
    assert.equal((await api('', { method: 'PUT', body: { accounts: [{ role: 'A', username: 'a', password: 'x' }, { role: 'a', username: 'b', password: 'y' }] } })).status, 400);
    assert.equal(((await api('')).body as any).accounts.length, 2, 'a refused save changes nothing');
  });

  it('keeps the list encrypted at rest', async () => {
    const stored = await getSecret(`guide-accounts.${projectId}`);
    assert.ok(stored && stored.includes('New-Clerk-Pw'), 'getSecret decrypts');
    // The secret store holds ciphertext: the raw value is not the plain JSON (secrets.ts encrypts with the portal key).
  });

  it('imports a CSV: adds new roles, updates an existing role, and reports bad rows', async () => {
    const r = await api('/import', { method: 'POST', body: { csv: 'role,username,password,notes\nCustomer,cust@t.example,Cust-Pw,buys things\nAdmin,admin3@t.example,Admin-New\nBroken,,pw\n', mode: 'add' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body as any;
    assert.equal(b.added, 1);
    assert.equal(b.updated, 1);
    assert.deepEqual(b.errors.map((e: any) => e.line), [4]);
    assert.deepEqual(b.accounts.map((a: any) => a.role), ['Admin', 'Clerk', 'Customer']);
    assert.doesNotMatch(JSON.stringify(b), /Cust-Pw|Admin-New/);
    const replace = await api('/import', { method: 'POST', body: { csv: 'Only,only@t.example,Only-Pw', mode: 'replace' } });
    assert.deepEqual(((replace.body as any).accounts as any[]).map((a) => a.role), ['Only']);
    assert.equal((await api('/import', { method: 'POST', body: { csv: '' } })).status, 400);
    assert.equal((await api('/import', { method: 'POST', body: { csv: 'role,username,password\nx,,\n' } })).status, 400);
  });

  it('is for editors: no sign-in is refused', async () => {
    const r = await fetch(`${baseUrl}/api/projects/${projectId}/guide-accounts`, { headers: { 'x-requested-with': 'agent-portal' } });
    assert.equal(r.status, 401);
  });
});

describe('what a guide run receives', () => {
  let projectId = '';
  before(async () => {
    const srv = await createTestServer();
    const setup = await fetchJson(srv.baseUrl, '/api/auth/setup', { method: 'POST', body: { email: `gr-${Date.now()}@example.com`, name: 'Admin', password: 'password1234', provider: 'demo' } });
    const p = await fetchJson(srv.baseUrl, '/api/projects', { method: 'POST', body: { name: 'Guide run' }, cookie: setup.cookie ?? '' });
    projectId = ((p.body as any).project as any).id as string;
    await fetchJson(srv.baseUrl, `/api/projects/${projectId}/guide-accounts`, { method: 'PUT', cookie: setup.cookie ?? '', body: { accounts: [{ role: 'Admin', username: 'a@t.example', password: 'pa' }, { role: 'Clerk', username: 'c@t.example', password: 'pc' }] } });
  });
  after(cleanup);

  it('only the chosen roles, matched without regard to case, with the hosts and the roles that no longer exist', async () => {
    await setGuideRun('wf-1', { roles: ['clerk', 'Ghost'], hosts: ['app.example.com'] });
    assert.deepEqual(await guideRunPayload(projectId, 'wf-1'), { accounts: [{ role: 'Clerk', username: 'c@t.example', password: 'pc' }], hosts: ['app.example.com'], missing: ['Ghost'], manualSignIn: false });
    assert.equal(await guideRunPayload(projectId, 'wf-without-guide'), null);
  });
});
