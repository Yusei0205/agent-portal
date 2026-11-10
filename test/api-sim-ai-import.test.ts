/**
 * Reading Word and Excel documents of any layout with AI (a stand-in model here), and saving what it finds as drafts.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import {
  API_SYSTEM, OUTLINE_SYSTEM, compactMarkdown, extractApis, extractJsonObject, normalizeExtractedApi, parseOutline, splitSections,
} from '../server/api-sim/ai-extract.ts';
import { _setImportModel, pickLiveBaseUrl } from '../server/api-sim/ai-import.ts';
import { getAiAttachmentRepository } from '../server/repositories/ai-attachments.ts';
import { convertToMarkdown } from '../server/convert.ts';
import type { ModelCall } from '../server/api-sim/ai-extract.ts';
import type { ApiSpec, Operation } from '../server/api-sim/types.ts';

const opOf = (spec: ApiSpec): { path: string; method: string; op: Operation } => {
  const [path, item] = Object.entries(spec.paths)[0];
  const [method, op] = Object.entries(item)[0];
  return { path, method, op: op! };
};

describe('document text', () => {
  test('sections follow the headings, and a heading inside a code block is not one', () => {
    const s = splitSections('intro\n\n# A\ntext\n```\n# not a heading\n```\n## B\nmore');
    assert.deepEqual(s.map((x) => `${x.level}:${x.title}`), ['0:(start of document)', '1:A', '2:B']);
    assert.match(s[1].body, /not a heading/);
  });

  test('spreadsheet noise is removed: empty trailing columns, empty rows, made-up column names', () => {
    const md = ['| Column 1 | Column 2 | Column 3 |', '| --- | --- | --- |', '| API Name | Login |  |', '|  |  |  |', '| a | b | c |'].join('\n');
    assert.equal(compactMarkdown(md), ['| API Name | Login |', '| a | b | c |'].join('\n'));
    const nbsp = String.fromCharCode(0xa0);
    const glyph = String.fromCharCode(0xec02);
    assert.equal(compactMarkdown(`## ${glyph}Generate${nbsp}Token`), `## Generate${nbsp}Token`); // symbol-font glyphs are dropped
    assert.equal(splitSections(`## Generate${nbsp}Token\nx`)[0].title, 'Generate Token'); // and a non-breaking space is a space
  });

  test('a JSON answer is found inside fences or chatter', () => {
    assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJsonObject('Sure! Here it is: {"a":{"b":2}} hope that helps'), { a: { b: 2 } });
    assert.equal(extractJsonObject('no json here'), null);
  });
});

describe('the outline', () => {
  test('keeps real section ids, gives each section to one API only, and drops bad addresses', () => {
    const { outline, problems } = parseOutline({
      shared: [0, 1, 99, 'x'],
      apis: [{ name: 'A', sections: [2, 3, 3, 99] }, { name: 'B', sections: [3, 4] }, { name: '', sections: [5] }, { name: 'C', sections: [] }],
      baseUrls: [{ label: 'UAT', url: 'https://x.example/uat' }, { label: 'bad', url: 'javascript:alert(1)' }, { label: 'no', url: 'ftp://x' }],
      notes: ['one', 5],
    }, 6);
    // null, an empty string and false are not section 0
    assert.deepEqual(parseOutline({ apis: [{ name: 'N', sections: [null, '', false, '3', 2] }] }, 6).outline!.apis, [{ name: 'N', sections: [2, 3] }]);
    assert.deepEqual(outline!.shared, [0, 1]);
    assert.deepEqual(outline!.apis, [{ name: 'A', sections: [2, 3] }, { name: 'B', sections: [4] }]);
    assert.deepEqual(outline!.baseUrls, [{ label: 'UAT', url: 'https://x.example/uat' }]);
    assert.deepEqual(outline!.notes, ['one']);
    assert.equal(problems.length, 2);
  });

  test('nothing usable', () => {
    assert.equal(parseOutline('text', 3).outline, null);
    assert.match(parseOutline({ apis: [] }, 3).problems[0], /no APIs/);
  });

  test('the live address offered is a test one when there is a choice, and only https', () => {
    assert.equal(pickLiveBaseUrl([{ label: 'PROD', url: 'https://prod.example/' }, { label: 'UAT', url: 'https://uat.example/api/' }]), 'https://uat.example/api');
    assert.equal(pickLiveBaseUrl([{ label: 'UAT', url: 'http://plain.example' }]), '');
    assert.equal(pickLiveBaseUrl([{ label: '', url: 'https://user:pw@evil.example' }]), '');
  });
});

describe('what the model says about one API is checked and rebuilt', () => {
  const norm = (raw: unknown, taken = new Set<string>()) => {
    const r = normalizeExtractedApi(raw, 'Fallback', taken);
    assert.ok(!('error' in r), JSON.stringify(r));
    return r as Exclude<typeof r, { error: string }>;
  };
  const full = {
    name: 'Update Flash', description: 'd', method: 'post', path: 'application/update_flash?x=1', auth: 'bearer',
    headers: [{ name: 'X-Source-Id', required: true, description: 'Source' }, { name: 'Content-Type', required: true }, { name: 'bad header', required: true }],
    query: [{ name: 'dry', type: 'boolean', required: false }],
    request: { fields: [
      { name: 'applicationNumber', type: 'String', required: true, maxLength: 20, description: 'No.' },
      { name: 'action', type: 'string', required: true, allowed: ['141', '142'] },
      { name: 'comments', type: 'string', required: false, conditional: 'Mandatory when action = 142' },
      { name: 'items', type: 'List', itemType: 'object', children: [{ name: 'qty', type: 'Int', required: true }] },
      { name: 'applicationNumber', type: 'string' },
      { name: 'weird', type: 'blob' },
    ] },
    responses: [
      { status: 200, description: 'ok', fields: [{ name: 'code', type: 'string', required: true }], example: { code: '00' } },
      { status: 404, description: 'missing', fields: null, example: { code: '99', message: 'Record not found' } },
      { status: 'x' }, { status: 99 },
    ],
    notes: ['check the 142 rule'],
  };

  test('a full description becomes a draft specification', () => {
    const { spec } = norm(full);
    const { path, method, op } = opOf(spec);
    assert.equal(path, '/application/update_flash');
    assert.equal(method, 'post');
    assert.deepEqual(op.parameters!.map((p) => `${p.in}:${p.name}`), ['query:dry', 'header:X-Source-Id']);
    assert.ok(op.security);
    const body = op.requestBody!.content['application/json'].schema;
    assert.deepEqual(body.required, ['applicationNumber', 'action']);
    assert.equal(body.properties!.applicationNumber.maxLength, 20);
    assert.deepEqual(body.properties!.action.enum, ['141', '142']);
    assert.equal(body.properties!.items.items!.properties!.qty.type, 'integer');
    assert.match(body.properties!.comments['x-conditional']!, /action = 142/);
    assert.equal(body.properties!.weird.type, 'string');
    assert.deepEqual(Object.keys(op.responses).sort(), ['200', '404']);
    assert.deepEqual(op.responses['200'].content!['application/json'].example, { code: '00' });
    const codes = op['x-flags']!.map((f) => f.code);
    for (const c of ['TYPE_ASSUMED', 'CONDITIONAL_RULE', 'ERROR_SAMPLES', 'AI_EXTRACTED', 'AI_NOTE']) assert.ok(codes.includes(c), `missing ${c}`);
    assert.ok(!codes.includes('MISSING_PATH'));
    assert.ok(!codes.includes('REQUIRED_UNKNOWN'));
  });

  test('the draft behaves: it answers with the sample from the document', async () => {
    const { handleMockRequest } = await import('../server/api-sim/mock-engine.ts');
    const { spec } = norm(full);
    const r = handleMockRequest(spec, [], { method: 'POST', path: '/application/update_flash', headers: { authorization: 'x', 'x-source-id': 's' }, body: { applicationNumber: 'A', action: '141' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { code: '00' });
  });

  test('paths are cleaned: host, query, <id> and :id', () => {
    const p = (path: unknown) => Object.keys(norm({ name: 'x', method: 'GET', path, responses: [{ status: 200, example: { a: 1 } }] }).spec.paths)[0];
    assert.equal(p('https://api.example.com/v1/pets/<id>?x=1'), '/v1/pets/{id}');
    assert.equal(p('/pets/:id/'), '/pets/{id}/');
    assert.equal(p('pets//list'), '/pets/list');
  });

  test('no usable path, no method, no success response, no required information: all said plainly', () => {
    const r = norm({ name: 'Lost', path: 'not a path!', fields: [], request: { fields: [{ name: 'a', type: 'string' }] }, responses: [{ status: 500, example: { e: 1 } }] });
    const codes = opOf(r.spec).op['x-flags']!.map((f) => f.code);
    for (const c of ['MISSING_PATH', 'NO_METHOD', 'NO_RESPONSE', 'REQUIRED_UNKNOWN']) assert.ok(codes.includes(c), `missing ${c}`);
    assert.equal(Object.keys(r.spec.paths)[0], '/lost');
    assert.equal(opOf(r.spec).method, 'post');
  });

  test('a GET with request fields makes them query parameters', () => {
    const { spec } = norm({ name: 'g', method: 'GET', path: '/g', request: { fields: [{ name: 'id', type: 'string', required: true }] }, responses: [{ status: 200, example: { ok: true } }] });
    const { op } = opOf(spec);
    assert.equal(op.requestBody, undefined);
    assert.deepEqual(op.parameters!.map((p) => `${p.in}:${p.name}:${p.required}`), ['query:id:true']);
  });

  test('fields given only as an example are inferred and flagged', () => {
    const { spec } = norm({ name: 'e', method: 'POST', path: '/e', request: { fields: [], example: { a: 1, b: { c: 'x' } } }, responses: [{ status: 200, example: { id: 'z' } }] });
    const { op } = opOf(spec);
    assert.equal(op.requestBody!.content['application/json'].schema.properties!.b.type, 'object');
    assert.ok(op['x-flags']!.some((f) => f.code === 'SCHEMA_INFERRED'));
  });

  test('operation ids stay unique across APIs', () => {
    const taken = new Set<string>();
    const a = norm({ name: 'Same Name', path: '/a', method: 'GET', responses: [] }, taken);
    const b = norm({ name: 'Same Name', path: '/b', method: 'GET', responses: [] }, taken);
    assert.notEqual(opOf(a.spec).op.operationId, opOf(b.spec).op.operationId);
  });

  test('rubbish in, an error out (nothing thrown); hostile sizes are bounded', () => {
    assert.ok('error' in normalizeExtractedApi('text', 'x', new Set()));
    assert.ok('error' in normalizeExtractedApi([1], 'x', new Set()));
    const fields = Array.from({ length: 900 }, (_, i) => ({ name: `f${i}`, type: 'string' }));
    const r = norm({ name: 'big', method: 'POST', path: '/big', request: { fields }, responses: [{ status: 200, example: { a: 1 } }] });
    assert.equal(Object.keys(opOf(r.spec).op.requestBody!.content['application/json'].schema.properties!).length, 800);
    assert.ok(opOf(r.spec).op['x-flags']!.some((f) => f.code === 'TOO_MANY_FIELDS'));
    const deep: Record<string, unknown> = { name: 'd', type: 'object', children: [] };
    let cur = deep;
    for (let i = 0; i < 30; i++) { const n = { name: 'd', type: 'object', children: [] as unknown[] }; (cur.children as unknown[]).push(n); cur = n as unknown as Record<string, unknown>; }
    assert.ok(!('error' in normalizeExtractedApi({ name: 'deep', path: '/d', method: 'POST', request: { fields: [deep] }, responses: [] }, 'x', new Set())));
  });
});

// ── A stand-in model ──────────────────────────────────────────────────────────

const DOC = [
  '# API Configuration', '', '| Configuration | Value |', '| --- | --- |', '| Endpoint | UAT: https://uat.example.com/api<br>PROD: https://prod.example.com |', '',
  '## Get Pet', '', 'Gets a pet.', '', '### Schema', '', '| Endpoint Path | pets/get |', '| --- | --- |', '| Method | GET |', '',
  '## Make Pet', '', 'Creates a pet.', '', '### Schema', '', '| Endpoint Path | pets/make |', '| --- | --- |', '| Method | POST |', '',
  '## Broken One', '', 'The model will fail on this.', '',
].join('\n');

const PET = (path: string, name = 'Get Pet') => ({
  name, description: 'd', method: 'GET', path, auth: 'bearer', headers: [], query: [{ name: 'id', type: 'string', required: true }], request: null,
  responses: [{ status: 200, description: 'ok', fields: [{ name: 'name', type: 'string', required: true }], example: { name: 'Rex' } }], notes: [],
});

/** Answers the way a sensible model would for DOC; `calls` records what it was asked. */
function standIn(calls: Array<{ system: string; user: string }>, overrides: Partial<Record<string, unknown>> = {}): ModelCall {
  return async (system, user) => {
    calls.push({ system, user });
    if (system === OUTLINE_SYSTEM) {
      const ids = Object.fromEntries([...user.matchAll(/\[(\d+)\] #+ ([^·]+?) ·/g)].map((m) => [m[2].trim(), Number(m[1])]));
      return JSON.stringify({
        shared: [ids['API Configuration']],
        apis: [
          { name: 'Get Pet', sections: [ids['Get Pet'], ids['Schema']].filter((x) => x !== undefined).slice(0, 1).concat([ids['Get Pet'] + 1]) },
          { name: 'Make Pet', sections: [ids['Make Pet'], ids['Make Pet'] + 1] },
          { name: 'Broken One', sections: [ids['Broken One']] },
        ],
        baseUrls: [{ label: 'UAT', url: 'https://uat.example.com/api' }, { label: 'PROD', url: 'https://prod.example.com' }],
        notes: ['Looks like a small document.'],
      });
    }
    assert.equal(system, API_SYSTEM);
    if (user.includes('"Broken One"')) return 'I am sorry, I cannot read this.';
    if (user.includes('"Make Pet"')) return '```json\n' + JSON.stringify({ ...PET('pets/make', 'Make Pet'), method: 'POST', ...(overrides.make as object ?? {}) }) + '\n```';
    return JSON.stringify({ ...PET('pets/get'), ...(overrides.get as object ?? {}) });
  };
}

describe('reading a whole document', () => {
  test('outline, one call per API, a retry for a bad answer, and what failed is reported', async () => {
    const calls: Array<{ system: string; user: string }> = [];
    const progress: string[] = [];
    const r = await extractApis(DOC, standIn(calls), (p) => { progress.push(`${p.phase}:${p.done}/${p.total}`); });
    assert.deepEqual(r.drafts.map((d) => d.name), ['Get Pet', 'Make Pet']);
    assert.deepEqual(r.drafts.map((d) => d.key), ['ai:getPet', 'ai:makePet']);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].api, 'Broken One');
    assert.equal(calls.filter((c) => c.system === API_SYSTEM && c.user.includes('"Broken One"')).length, 2); // tried twice
    assert.equal(calls.length, 1 + 1 + 1 + 2);
    assert.equal(r.baseUrls.length, 2);
    assert.ok(progress[0].startsWith('outline'));
    assert.ok(progress.includes('extract:0/3') && progress.includes('extract:3/3'));
  });

  test('each API is read from its own sections plus the general information, and from nothing else', async () => {
    const calls: Array<{ system: string; user: string }> = [];
    await extractApis(DOC, standIn(calls));
    const get = calls.find((c) => c.system === API_SYSTEM && c.user.includes('"Get Pet"'))!.user;
    assert.match(get, /UAT: https:\/\/uat\.example\.com\/api/);
    assert.match(get, /pets\/get/);
    assert.doesNotMatch(get, /pets\/make/);
  });

  test('a model that cannot be used gives an error, not an exception', async () => {
    const r = await extractApis(DOC, async () => { throw new Error('credentials expired'); });
    assert.equal(r.drafts.length, 0);
    assert.match(r.errors[0].message, /credentials expired/);
    assert.equal((await extractApis('', async () => '{}')).errors.length, 1);
  });
});

// ── End to end ────────────────────────────────────────────────────────────────

async function docxBuffer(petPath: string, fieldName: string): Promise<Buffer> {
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell } = await import('docx');
  const cell = (t: string) => new TableCell({ children: [new Paragraph(t)] });
  const row = (...c: string[]) => new TableRow({ children: c.map(cell) });
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: 'API Configuration', heading: HeadingLevel.HEADING_1 }),
        new Table({ rows: [row('Configuration', 'Value'), row('Endpoint', 'UAT: https://uat.example.com/api')] }),
        new Paragraph({ text: 'Get Pet', heading: HeadingLevel.HEADING_2 }),
        new Paragraph('Gets a pet.'),
        new Paragraph({ text: 'Schema', heading: HeadingLevel.HEADING_3 }),
        new Table({ rows: [row('Endpoint Path', petPath), row('Method', 'GET'), row('Field', fieldName)] }),
        new Paragraph({ text: 'Make Pet', heading: HeadingLevel.HEADING_2 }),
        new Paragraph('Creates a pet.'),
        new Paragraph({ text: 'Schema', heading: HeadingLevel.HEADING_3 }),
        new Table({ rows: [row('Endpoint Path', 'pets/make'), row('Method', 'POST')] }),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

describe('importing a Word document with AI', () => {
  let baseUrl: string;
  let cookie: string;
  let outsider: string;
  let pid: string;
  const m = (p: string) => `/api/projects/${pid}/sim${p}`;
  const seen: Array<{ model: string | null; credentialId: string | null }> = [];
  let calls: Array<{ system: string; user: string }> = [];
  let overrides: Partial<Record<string, unknown>> = {};
  let failModel = false;

  async function upload(buf: Buffer, name: string): Promise<string> {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(buf)]), name);
    const res = await fetch(`${baseUrl}/api/projects/${pid}/ai-attachments`, { method: 'POST', headers: { 'X-Requested-With': 'agent-portal', Cookie: cookie }, body: fd });
    assert.equal(res.status, 201, await res.clone().text());
    return ((await res.json()) as { attachment: { id: string } }).attachment.id;
  }

  async function runImport(attachmentId: string, extra: Record<string, unknown> = {}) {
    const started = await fetchJson(baseUrl, m('/import-ai'), { body: { attachmentId, ...extra }, cookie });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const jobId = (started.body as { jobId: string }).jobId;
    for (let i = 0; i < 100; i++) {
      const j = (await fetchJson(baseUrl, m(`/import-jobs/${jobId}`), { cookie })).body as { job: { status: string } & Record<string, unknown> };
      if (j.job.status !== 'running') return { jobId, job: j.job };
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the job did not finish');
  }

  before(async () => {
    _setImportModel((job) => {
      seen.push({ model: job.model, credentialId: job.credentialId });
      return async (s, u, t) => { if (failModel) throw new Error('the model is unavailable'); return standIn(calls, overrides)(s, u, t); };
    });
    baseUrl = (await createTestServer()).baseUrl;
    await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'a@aiimp.test', password: 'adminpassword1', name: 'A' } });
    cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'a@aiimp.test', password: 'adminpassword1' } })).cookie ?? '';
    await fetchJson(baseUrl, '/api/users', { method: 'POST', body: { email: 'o@aiimp.test', name: 'O', password: 'outsiderpass1', isAdmin: false }, cookie });
    outsider = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'o@aiimp.test', password: 'outsiderpass1' } })).cookie ?? '';
    pid = ((await fetchJson(baseUrl, '/api/projects', { body: { name: 'AI import' }, cookie })).body as { project: { id: string } }).project.id;
  });
  after(async () => { _setImportModel(null); await cleanup(); });

  test('the Word converter keeps headings and tables, which is all the reader needs', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(os.tmpdir(), `aiimp-${Date.now()}.docx`);
    await fs.writeFile(file, await docxBuffer('pets/get', 'id'));
    const md = await convertToMarkdown(file, '');
    await fs.rm(file);
    assert.deepEqual(splitSections(md).map((s) => `${s.level}:${s.title}`), ['1:API Configuration', '2:Get Pet', '3:Schema', '2:Make Pet', '3:Schema']);
  });

  test('upload, read with the chosen model, and get drafts, notes, a live address and no leftover document', async () => {
    const att = await upload(await docxBuffer('pets/get', 'id'), 'spec.docx');
    const { job } = await runImport(att, { model: 'my-model', credentialId: 'cred-9', group: 'Pet store', label: 'v1' });
    assert.equal(job.status, 'done', JSON.stringify(job));
    const j = job as unknown as { created: Array<{ id: string; name: string; isNew: boolean }>; errors: Array<{ api: string }>; liveBaseUrl: string; notes: string[] };
    assert.deepEqual(j.created.map((c) => c.name).sort(), ['Get Pet', 'Make Pet']);
    assert.ok(j.created.every((c) => c.isNew));
    assert.deepEqual(j.errors, []);
    assert.equal(j.liveBaseUrl, 'https://uat.example.com/api');
    assert.ok(j.notes.some((n) => /live address/.test(n)));
    assert.deepEqual(seen.at(-1), { model: 'my-model', credentialId: 'cred-9' });
    assert.equal(await getAiAttachmentRepository().getById(att), null);
    assert.ok(j.created.every((c) => (c as { group?: string }).group === 'Pet store'));

    const list = (await fetchJson(baseUrl, m('/apis'), { cookie })).body as { apis: Array<{ name: string; liveBaseUrl: string; approvedVersion: number; operations: Array<{ path: string }>; flags: { total: number } }> };
    const get = list.apis.find((a) => a.name === 'Get Pet')!;
    assert.equal(get.liveBaseUrl, 'https://uat.example.com/api');
    assert.equal(get.approvedVersion, 0);
    assert.deepEqual(get.operations.map((o) => o.path), ['/pets/get']);
    assert.ok(get.flags.total >= 1);
  });

  test('reading an updated document adds a version to the same API, even if the API was renamed in it', async () => {
    overrides = { get: { name: 'Fetch A Pet', path: 'pets/get', responses: [{ status: 200, fields: [{ name: 'name', type: 'string' }, { name: 'age', type: 'integer' }], example: { name: 'Rex', age: 3 } }] } };
    const att = await upload(await docxBuffer('pets/get', 'id, age'), 'spec-v2.docx');
    const { job } = await runImport(att, { group: 'pet STORE', label: 'v2' }); // the group is matched without regard to case
    const j = job as unknown as { created: Array<{ id: string; name: string; version: number; isNew: boolean }> };
    const get = j.created.find((c) => c.name === 'Get Pet')!;
    assert.equal(get.isNew, false, JSON.stringify(j.created));
    assert.equal(get.version, 2);
    const apis = (await fetchJson(baseUrl, m('/apis'), { cookie })).body as { apis: unknown[] };
    assert.equal(apis.apis.length, 2);
    const diff = (await fetchJson(baseUrl, m(`/apis/${get.id}/diff?from=1&to=2`), { cookie })).body as { changes: Array<{ details: string[] }> };
    assert.match(diff.changes[0].details.join('\n'), /field "age" added/);
    overrides = {};
  });

  test('a model that fails makes a failed job with the reason, and the document is still removed', async () => {
    failModel = true;
    const att = await upload(await docxBuffer('pets/get', 'id'), 'spec3.docx');
    const { job } = await runImport(att);
    failModel = false;
    assert.equal(job.status, 'failed');
    assert.match(String(job.error), /model is unavailable/);
    assert.equal(await getAiAttachmentRepository().getById(att), null);
  });

  test('only people in the project can see a job; a missing upload is refused', async () => {
    const att = await upload(await docxBuffer('pets/get', 'id'), 'spec4.docx');
    const { jobId } = await runImport(att);
    assert.equal((await fetchJson(baseUrl, m(`/import-jobs/${jobId}`), { cookie: outsider })).status, 404);
    assert.equal((await fetchJson(baseUrl, m('/import-ai'), { body: {}, cookie })).status, 400);
    assert.equal((await fetchJson(baseUrl, m('/import-ai'), { body: { attachmentId: 'nope' }, cookie })).status, 400);
  });
});

const REAL_DOCX = 'C:/Users/tanch/Downloads/api spec.docx';
describe('a real client document', { skip: !existsSync(REAL_DOCX) && 'sample document not on this machine' }, () => {
  test('is cut into the sections an outline needs', async () => {
    const sections = splitSections(compactMarkdown(await convertToMarkdown(REAL_DOCX, '')));
    const titles = sections.map((s) => s.title);
    for (const t of ['API Configuration', 'GetApplicationRecord', 'Generate Token', 'Query External Record']) assert.ok(titles.includes(t), `missing ${t}`);
    assert.ok(sections.length >= 30);
  });
});
