/**
 * Knowledge built from a project's repositories: generated documents linked to Knowledge, kept in sync on every version,
 * the "Build from repositories" action, the per-document toggle, and unlinking when the Knowledge copy is deleted.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getDb } from '../server/db.ts';
import { now } from '../server/util.ts';
import { processDocOutput } from '../server/generated-docs.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('knowledge from code', () => {
  let baseUrl = '';
  let cookie = '';
  let projectId = '';
  const repoA = 'repo-kfc-a';
  const repoB = 'repo-kfc-b';

  before(async () => {
    ({ baseUrl } = await createTestServer());
    cookie = (await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'kfc@test.com', name: 'Admin', password: 'password1234', provider: 'demo' } })).cookie ?? '';
    const r = await fetchJson(baseUrl, '/api/projects', { body: { name: 'KFC project' }, cookie });
    projectId = ((r.body as Json).project as Json).id;
    const ins = getDb().prepare(`INSERT INTO repositories (id, project_id, name, url, provider, status, created_at) VALUES (?,?,?,?,'github','ready',?)`);
    ins.run(repoA, projectId, 'billing-api', 'http://x/a', now());
    ins.run(repoB, projectId, 'web-app', 'http://x/b', now());
  });
  after(cleanup);

  // A version's Markdown stays where the run wrote it (as on the portal's disk), so the folders are removed only at the end.
  const dirs: string[] = [];
  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  const finish = async (workflowId: string, markdown: string): Promise<void> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kfc-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'document.md'), markdown);
    await processDocOutput(workflowId, 'run-x', dir);
  };
  const knowledge = async (): Promise<Json[]> => ((await fetchJson(baseUrl, `/api/projects/${projectId}/knowledge`, { cookie })).body as Json).docs;
  const content = async (docId: string): Promise<string> => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/knowledge/docs/${docId}/content`, { cookie });
    return JSON.stringify(r.body);
  };

  let built: Json[] = [];

  it('build: one generated document per default type, reading the chosen repositories, linked to Knowledge', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/knowledge/build`, { body: { repoIds: [repoA, repoB] }, cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    built = (r.body as Json).docs;
    assert.deepEqual(built.map((d) => d.doc_type), ['overview', 'architecture', 'api', 'runbook']);
    for (const d of built) {
      assert.deepEqual(d.sources.repoIds, [repoA, repoB]);
      assert.equal(d.sources.knowledge.on, true);
      assert.ok(d.workflow_id, 'a run was started');
    }
    assert.equal(built[0].name, 'System overview · billing-api, web-app');
  });

  it('build: refuses no repositories, unknown repositories and unknown types', async () => {
    const post = (body: Json) => fetchJson(baseUrl, `/api/projects/${projectId}/knowledge/build`, { body, cookie });
    assert.equal((await post({ repoIds: [] })).status, 400);
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ repoIds: ['nope'] })).status, 400);
    assert.equal((await post({ repoIds: [repoA], types: ['poem'] })).status, 400);
  });

  it('a finished version lands in Knowledge as a ready, searchable document marked as generated; a refresh updates the same document', async () => {
    const d = built[0]!;
    await finish(d.workflow_id, '# Overview\n\nBilling API handles INVOICE-ALPHA.\n');
    let docs = await knowledge();
    const k = docs.find((x) => x.generated?.id === d.id);
    assert.ok(k, 'the Knowledge copy exists');
    assert.equal(k.status, 'ready');
    assert.equal(k.generated.name, d.name);
    assert.match(await content(k.id), /INVOICE-ALPHA/);
    const gen = ((await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs/${d.id}`, { cookie })).body as Json).doc;
    assert.equal(gen.sources.knowledge.docId, k.id);

    await finish(d.workflow_id, '# Overview\n\nNow INVOICE-BETA.\n');
    docs = await knowledge();
    const copies = docs.filter((x) => x.generated?.id === d.id);
    assert.equal(copies.length, 1, 'no duplicate on refresh');
    assert.equal(copies[0].id, k.id);
    const text = await content(k.id);
    assert.match(text, /INVOICE-BETA/);
    assert.doesNotMatch(text, /INVOICE-ALPHA/);
  });

  it('a generated document without the link does not reach Knowledge', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs`, { body: { name: 'Private notes', docType: 'runbook', sources: { repoIds: [repoA] } }, cookie });
    const b = r.body as Json;
    await finish(b.workflowId, '# Private\n\nSECRET-RUNBOOK\n');
    assert.ok(!(await knowledge()).some((x) => x.generated?.id === b.doc.id));
  });

  it('the toggle adds an existing document to Knowledge, and turning it off removes the copy', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs`, { body: { name: 'Toggle doc', docType: 'api', sources: { repoIds: [repoA] } }, cookie });
    const b = r.body as Json;
    await finish(b.workflowId, '# API\n\nTOGGLE-TEXT\n');
    const url = `/api/projects/${projectId}/generated-docs/${b.doc.id}/knowledge`;
    const on = await fetchJson(baseUrl, url, { method: 'PUT', body: { on: true }, cookie });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const k = (await knowledge()).find((x) => x.generated?.id === b.doc.id);
    assert.ok(k);
    assert.match(await content(k.id), /TOGGLE-TEXT/);
    assert.equal((await fetchJson(baseUrl, url, { method: 'PUT', body: { on: 'yes' }, cookie })).status, 400);
    const off = await fetchJson(baseUrl, url, { method: 'PUT', body: { on: false }, cookie });
    assert.equal(off.status, 200);
    assert.ok(!(await knowledge()).some((x) => x.id === k.id), 'the copy is gone');
  });

  it('deleting the Knowledge copy unlinks it: a later version does not bring it back', async () => {
    const d = built[1]!;
    await finish(d.workflow_id, '# Arch\n\nARCH-ONE\n');
    const k = (await knowledge()).find((x) => x.generated?.id === d.id)!;
    assert.equal((await fetchJson(baseUrl, `/api/projects/${projectId}/knowledge/${k.id}`, { method: 'DELETE', cookie })).status, 200);
    const gen = ((await fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs/${d.id}`, { cookie })).body as Json).doc;
    assert.equal(gen.sources.knowledge.on, false);
    await finish(d.workflow_id, '# Arch\n\nARCH-TWO\n');
    assert.ok(!(await knowledge()).some((x) => x.generated?.id === d.id));
  });
});
