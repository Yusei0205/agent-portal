/**
 * Business rules: stated in words in the client's document, suggested as checks by the AI step, confirmed by a person,
 * then enforced by the simulation and turned into test cases.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { checkRules, sanitizeAiRules, listFields } from '../server/api-sim/rules.ts';
import { handleMockRequest } from '../server/api-sim/mock-engine.ts';
import { generateApiCases } from '../server/api-sim/test-cases.ts';
import { setCallTextModelOverride } from '../server/testing/model-provider.ts';
import type { ApiSpec, BusinessRule, Schema } from '../server/api-sim/types.ts';

const bodySchema: Schema = {
  type: 'object',
  required: ['applicationNumber', 'action'],
  properties: {
    applicationNumber: { type: 'string', maxLength: 20 },
    action: { type: 'string', enum: ['141', '142', '143'] },
    comment: { type: 'object', properties: { comments: { type: 'string', 'x-conditional': 'Mandatory when Action Code = 142' } } },
    items: { type: 'array', items: { type: 'object', properties: { qty: { type: 'integer' } } } },
  },
};

const rule = (over: Partial<BusinessRule> = {}): BusinessRule => ({
  id: 'r1', description: 'Comments are mandatory when action is 142', status: 'confirmed', source: 'ai',
  when: [{ field: 'action', op: 'equals', value: '142' }], requires: ['comment.comments'], ...over,
});

describe('rule checks', () => {
  test('a confirmed rule requires the field only when its condition holds', () => {
    assert.equal(checkRules([rule()], { action: '142', comment: {} }).length, 1);
    assert.equal(checkRules([rule()], { action: '142', comment: { comments: 'x' } }).length, 0);
    assert.equal(checkRules([rule()], { action: '141', comment: {} }).length, 0);
    assert.equal(checkRules([rule()], { action: '142' })[0].path, 'body.comment.comments');
  });

  test('a suggested rule is shown, not applied', () => {
    assert.equal(checkRules([rule({ status: 'suggested' })], { action: '142' }).length, 0);
  });

  test('the other tests: in, not_equals, present, absent', () => {
    const r = (when: BusinessRule['when']) => checkRules([rule({ when })], { action: '143', applicationNumber: 'A' }).length;
    assert.equal(r([{ field: 'action', op: 'in', value: ['142', '143'] }]), 1);
    assert.equal(r([{ field: 'action', op: 'not_equals', value: '141' }]), 1);
    assert.equal(r([{ field: 'applicationNumber', op: 'present' }]), 1);
    assert.equal(r([{ field: 'comment', op: 'absent' }]), 1);
    assert.equal(r([{ field: 'action', op: 'equals', value: '142' }, { field: 'applicationNumber', op: 'present' }]), 0); // all must hold
  });
});

describe('checking what the AI suggests', () => {
  let n = 0;
  const id = () => `id${++n}`;
  const good = { description: 'Comments needed for 142', when: [{ field: 'action', op: 'equals', value: 142 }], requires: ['comment.comments'] };

  test('keeps a well formed rule, as suggested, with values as text', () => {
    const r = sanitizeAiRules([good], bodySchema, id);
    assert.equal(r.rejected.length, 0);
    assert.equal(r.rules[0].status, 'suggested');
    assert.equal(r.rules[0].source, 'ai');
    assert.deepEqual(r.rules[0].when, [{ field: 'action', op: 'equals', value: '142' }]);
  });

  test('drops anything that names a field that is not there, or is badly formed', () => {
    const r = sanitizeAiRules([
      { ...good, requires: ['nope'] },
      { ...good, when: [{ field: 'ghost', op: 'equals', value: 'x' }] },
      { ...good, when: [{ field: 'action', op: 'matches', value: 'x' }] },
      { ...good, when: [{ field: 'action', op: 'equals' }] },
      { ...good, when: [] },
      { ...good, requires: ['items[0].qty'] },
      { ...good, description: '' },
      'text',
      good,
    ], bodySchema, id);
    assert.equal(r.rules.length, 1);
    assert.equal(r.rejected.length, 8);
  });

  test('not a list at all', () => {
    assert.equal(sanitizeAiRules({ rules: [] }, bodySchema, id).rules.length, 0);
    assert.match(sanitizeAiRules('x', bodySchema, id).rejected[0], /did not return a list/);
  });

  test('listFields skips lists and reports rules in words', () => {
    const f = listFields(bodySchema);
    assert.ok(f.some((x) => x.path === 'comment.comments' && x.conditional));
    assert.ok(!f.some((x) => x.path.startsWith('items.')));
  });
});

const spec = (rules: BusinessRule[]): ApiSpec => ({
  openapi: '3.0.3', info: { title: 'T', version: '1' },
  paths: { '/flash/update': { post: { operationId: 'updateFlash', summary: 'UpdateFlash', requestBody: { required: true, content: { 'application/json': { schema: bodySchema } } }, responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } }, 'x-rules': rules } } },
});

describe('the engine and the test generator use confirmed rules', () => {
  const req = (body: unknown) => ({ method: 'POST', path: '/flash/update', body });

  test('the simulation refuses a request that breaks a confirmed rule, and names the field', () => {
    const s = spec([rule()]);
    const bad = handleMockRequest(s, [], req({ applicationNumber: 'A', action: '142' }));
    assert.equal(bad.status, 400);
    assert.deepEqual((bad.body as { errors: Array<{ path: string }> }).errors.map((e) => e.path), ['body.comment.comments']);
    assert.equal(handleMockRequest(s, [], req({ applicationNumber: 'A', action: '142', comment: { comments: 'x' } })).status, 200);
    assert.equal(handleMockRequest(s, [], req({ applicationNumber: 'A', action: '141' })).status, 200);
  });

  test('an unconfirmed rule changes nothing, and the "may be required" warning stays', () => {
    const r = handleMockRequest(spec([rule({ status: 'suggested' })]), [], req({ applicationNumber: 'A', action: '142', comment: {} }));
    assert.equal(r.status, 200);
    assert.ok(r.warnings.some((w) => w.code === 'CONDITIONAL_RULE'));
  });

  test('once confirmed, the warning for that field is gone (the rule now covers it)', () => {
    const r = handleMockRequest(spec([rule()]), [], req({ applicationNumber: 'A', action: '141', comment: {} }));
    assert.equal(r.warnings.length, 0);
  });

  test('test cases come from the confirmed rule and replace the manual case for that field', () => {
    const s = spec([rule()]);
    const { cases } = generateApiCases(s);
    const rules = cases.filter((c) => c.kind === 'rule');
    assert.equal(rules.length, 3); // accepted when met, rejected when missing, accepted when the condition is not met
    assert.equal(cases.filter((c) => c.kind === 'conditional').length, 0);
    assert.deepEqual(rules.map((c) => c.step!.expectedStatus), [200, 400, 200]);
    // and without confirmation the manual case is still there
    assert.equal(generateApiCases(spec([rule({ status: 'suggested' })])).cases.filter((c) => c.kind === 'conditional').length, 1);
  });

  test('every generated case, rule cases included, gets the status it expects from the engine', () => {
    const s = spec([rule(), rule({ id: 'r2', description: 'Number needed when action is in 141 or 143', when: [{ field: 'action', op: 'in', value: ['141', '143'] }], requires: ['applicationNumber'] })]);
    const { cases } = generateApiCases(s);
    assert.ok(cases.filter((c) => c.kind === 'rule').length >= 4); // the second rule's field is already required by the schema, so only its "condition met" case adds anything
    for (const c of cases.filter((x) => x.step)) {
      const st = c.step!;
      const r = handleMockRequest(s, [], { method: st.method, path: st.path, headers: st.headers, body: st.body });
      assert.equal(r.status, st.expectedStatus, `${c.scenario}: expected ${st.expectedStatus}, engine said ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
  });
});

// ── Routes with a stand-in model ──────────────────────────────────────────────

const HEAD = ['NO.', 'FIELD NAME', '(M)andatory or (O)ptional or Conditional or Echo', 'Data Type', 'Data Length', 'FIELD NAME DESCRIPTION', 'REMARKS'];
const SHEET = [
  ['1. Request'], ['API Name', 'UpdateFlash'], ['Method', 'POST'], ['Authentication', 'None'],
  HEAD,
  ['1', 'applicationNumber', 'M', 'String', '20', 'Application number'],
  ['2', 'action', 'M', 'String', '20', 'Action', 'Valid Values:\n141 - Submit\n142 - Reject'],
  ['3', 'comments', 'CM', 'String', '2000', 'Comments', 'Mandatory when Action Code = 142'],
  ['2. Response'], ['API Name', 'UpdateFlash'], HEAD,
  ['1', 'id', 'M', 'String', '-', 'Request id'], ['2', 'code', 'M', 'String', '10', 'Response code'],
];

async function workbookBase64(): Promise<string> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('UpdateFlash');
  for (const r of SHEET) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

describe('AI rule suggestions end to end', () => {
  let baseUrl: string;
  let cookie: string;
  let pid: string;
  let apiId: string;
  let tpid: string;
  const seen: Array<{ system: string; user: string; opts: { credentialId?: string | null; model?: string | null; createdBy?: string | null } }> = [];
  let answer = '';
  const m = (p: string) => `/api/projects/${pid}/sim/apis/${apiId}${p}`;

  before(async () => {
    setCallTextModelOverride(async (system, user, opts) => { seen.push({ system, user, opts }); return answer; });
    baseUrl = (await createTestServer()).baseUrl;
    await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'a@rules.test', password: 'adminpassword1', name: 'A' } });
    cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'a@rules.test', password: 'adminpassword1' } })).cookie ?? '';
    pid = ((await fetchJson(baseUrl, '/api/projects', { body: { name: 'R' }, cookie })).body as { project: { id: string } }).project.id;
    tpid = ((await fetchJson(baseUrl, `/api/projects/${pid}/tests`, { body: { name: 'T', appUrl: 'https://app.example' }, cookie })).body as { testProject: { id: string } }).testProject.id;
    const imp = await fetchJson(baseUrl, `/api/projects/${pid}/sim/import`, { body: { kind: 'xlsx', contentBase64: await workbookBase64(), paths: { UpdateFlash: '/flash/update' } }, cookie });
    apiId = (imp.body as { created: Array<{ id: string }> }).created[0].id;
  });

  after(async () => { setCallTextModelOverride(null); await cleanup(); });

  test('garbage from the model makes no new version and says why', async () => {
    answer = 'Sorry, I cannot help with that.';
    const r = await fetchJson(baseUrl, m('/versions/1/ai-rules'), { body: {}, cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body as { version: number | null; accepted: number; rejected: string[] };
    assert.equal(b.version, null);
    assert.equal(b.accepted, 0);
    assert.ok(b.rejected.length >= 1);
    const detail = (await fetchJson(baseUrl, m(''), { cookie })).body as { versions: unknown[] };
    assert.equal(detail.versions.length, 1);
  });

  test('a good answer becomes a new draft version with a suggested rule; the chosen model is used; bad parts are reported', async () => {
    seen.length = 0;
    answer = '```json\n' + JSON.stringify([
      { description: 'Comments are mandatory when action is 142', when: [{ field: 'action', op: 'equals', value: '142' }], requires: ['comments'] },
      { description: 'Made-up', when: [{ field: 'ghost', op: 'equals', value: 'x' }], requires: ['comments'] },
    ]) + '\n```';
    const r = await fetchJson(baseUrl, m('/versions/1/ai-rules'), { body: { credentialId: 'cred-1', model: 'test-model' }, cookie });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const b = r.body as { version: number; accepted: number; rejected: string[] };
    assert.equal(b.version, 2);
    assert.equal(b.accepted, 1);
    assert.ok(b.rejected.some((x) => /ghost/.test(x)));
    // the dropdown's choice reached the model call; the prompt carries the field list and the rule in words
    assert.equal(seen[0].opts.credentialId, 'cred-1');
    assert.equal(seen[0].opts.model, 'test-model');
    assert.match(seen[0].user, /Mandatory when Action Code = 142/);
    assert.match(seen[0].user, /"path":"applicationNumber"/);

    const v2 = (await fetchJson(baseUrl, m('?version=2'), { cookie })).body as { version: { status: string }; spec: ApiSpec; flags: Array<{ code: string }> };
    assert.equal(v2.version.status, 'draft');
    const rules = v2.spec.paths['/flash/update'].post!['x-rules']!;
    assert.equal(rules.length, 1);
    assert.equal(rules[0].status, 'suggested');
    assert.ok(v2.flags.some((f) => f.code === 'AI_RULE'));
    // version 1 is untouched
    const v1 = (await fetchJson(baseUrl, m('?version=1'), { cookie })).body as { spec: ApiSpec };
    assert.equal(v1.spec.paths['/flash/update'].post!['x-rules'], undefined);
  });

  test('a suggested rule does nothing until confirmed; confirming clears the AI note', async () => {
    const spec2 = ((await fetchJson(baseUrl, m('?version=2'), { cookie })).body as { spec: ApiSpec }).spec;
    const rid = spec2.paths['/flash/update'].post!['x-rules']![0].id;
    const tryIt = (body: unknown) => fetchJson(baseUrl, m('/try'), { body: { method: 'POST', path: '/flash/update', version: 2, body }, cookie });
    const bad = { applicationNumber: 'A1', action: '142' };
    assert.equal(((await tryIt(bad)).body as { result: { status: number } }).result.status, 200);

    const c = await fetchJson(baseUrl, m(`/versions/2/rules/${rid}`), { method: 'PUT', body: { status: 'confirmed' }, cookie });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const after = ((await fetchJson(baseUrl, m('?version=2'), { cookie })).body as { spec: ApiSpec; flags: Array<{ code: string }> });
    assert.equal(after.spec.paths['/flash/update'].post!['x-rules']![0].status, 'confirmed');
    assert.ok(!after.flags.some((f) => f.code === 'AI_RULE'));
    const rejected = (await tryIt(bad)).body as { result: { status: number; body: { errors: Array<{ path: string }> } } };
    assert.equal(rejected.result.status, 400);
    assert.equal(rejected.result.body.errors[0].path, 'body.comments');
    assert.equal(((await tryIt({ ...bad, comments: 'because' })).body as { result: { status: number } }).result.status, 200);

    assert.equal((await fetchJson(baseUrl, m('/versions/2/rules/nope'), { method: 'PUT', body: { status: 'confirmed' }, cookie })).status, 404);
    assert.equal((await fetchJson(baseUrl, m(`/versions/2/rules/${rid}`), { method: 'PUT', body: { status: 'maybe' }, cookie })).status, 400);
  });

  test('approved: test cases are made from the rule and all pass on the simulation', async () => {
    assert.equal((await fetchJson(baseUrl, m('/versions/2/approve'), { body: {}, cookie })).status, 200);
    // an approved version is frozen
    const spec2 = ((await fetchJson(baseUrl, m('?version=2'), { cookie })).body as { spec: ApiSpec }).spec;
    const rid = spec2.paths['/flash/update'].post!['x-rules']![0].id;
    assert.equal((await fetchJson(baseUrl, m(`/versions/2/rules/${rid}`), { method: 'PUT', body: { status: 'removed' }, cookie })).status, 409);

    const gen = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/from-api`, { body: { source: { kind: 'sim', apiIds: [apiId] } }, cookie });
    const cs = gen.body as { caseSet: { id: string }; manualCases: number };
    assert.equal(cs.manualCases, 0); // the rule in words is now a check, so no manual case is left
    const run = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${cs.caseSet.id}/api-runs`, { body: { target: 'simulation' }, cookie });
    const b = run.body as { summary: { pass: number; fail: number; skipped: number }; results: Array<{ outcome: string; scenario: string; reason: string }> };
    assert.equal(b.summary.fail, 0, JSON.stringify(b.results.filter((x) => x.outcome === 'fail')));
    assert.ok(b.results.some((x) => /Rule "/.test(x.scenario) && x.outcome === 'pass'));
  });
});
