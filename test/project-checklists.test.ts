import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeRepository, generateChecklist } from '../server/project-checklist-analysis.ts';
import type { Checklist } from '../server/project-checklist-analysis.ts';
import { readChecklist, writeChecklist, ChecklistConflict } from '../server/repositories/project-checklists.ts';
import { config } from '../server/config.ts';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

type Json = Record<string, any>;
describe('project deployment and security checklists', () => {
  let baseUrl: string, cookie: string, projectId: string, slug: string, repoId: string, root: string;
  let viewerCookie: string, outsiderCookie: string, editorCookie: string;
  const url = () => `/api/projects/${projectId}/checklists`;
  const get = async () => (await fetchJson(baseUrl, url(), { cookie })).body as { checklist: Checklist };
  const generate = (revision: number) => fetchJson(baseUrl, `${url()}/generate`, { cookie, method: 'POST', body: { revision } });
  const save = (doc: Checklist) => fetchJson(baseUrl, url(), { cookie, method: 'PUT', body: doc });
  before(async () => {
    ({ baseUrl } = await createTestServer());
    cookie = (await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'check-admin@example.com', name: 'Admin', password: 'password1234', provider: 'demo' } })).cookie!;
    const p = (await fetchJson(baseUrl, '/api/projects', { cookie, body: { name: 'Checklist polyglot' } })).body as Json;
    projectId = p.project.id; slug = p.project.slug;
    const repo = (await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, { cookie, body: { name: 'service', url: 'https://github.com/example/service.git', provider: 'github' } })).body as Json;
    repoId = repo.repo.id;
    const { getGitReposRepository } = await import('../server/repositories/git-repos.ts');
    await getGitReposRepository().updateStatus(repoId, 'ready');
    root = path.join(config.dataDir, 'projects', slug, 'repos', 'service');
    await fs.mkdir(path.join(root, 'infra'), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(root, 'main.py'), 'import os\nurl = os.getenv("DATABASE_URL")\nprint("hello")'),
      fs.writeFile(path.join(root, 'main.go'), 'package main'),
      fs.writeFile(path.join(root, 'app.cs'), 'class App {}'),
      fs.writeFile(path.join(root, 'unknown.xyz'), 'arbitrary language'),
      fs.writeFile(path.join(root, 'infra', 'main.tf'), 'resource "aws_s3_bucket" "assets" {}\nresource "azurerm_storage_account" "archive" {}\nresource "google_storage_bucket" "backup" {}'),
      fs.writeFile(path.join(root, '.env'), 'DO_NOT_EXPORT=super-secret-value\nAWS_ACCESS_KEY_ID=secret'),
    ]);
    for (const [role, email] of [['viewer', 'check-view@example.com'], ['outsider', 'check-out@example.com'], ['editor', 'check-edit@example.com']]) {
      const r = await fetchJson(baseUrl, '/api/users', { cookie, body: { email, name: role, password: 'password1234', isAdmin: false } });
      const userId = (r.body as Json).user.id;
      const userCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email, password: 'password1234' } })).cookie!;
      if (role === 'viewer') viewerCookie = userCookie;
      if (role === 'outsider') outsiderCookie = userCookie;
      if (role === 'editor') editorCookie = userCookie;
      if (role !== 'outsider') {
        const added = await fetchJson(baseUrl, `/api/projects/${projectId}/members`, { cookie, body: { userId, role } });
        assert.equal(added.status, 201, JSON.stringify(added.body));
      }
    }
  });
  after(cleanup);

  it('analyzes multiple languages, infrastructure and providers without exposing secrets', async () => {
    assert.equal((await get()).checklist, null);
    const result = await generate(0);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const doc = (result.body as Json).checklist as Checklist;
    assert.deepEqual(doc.analysis[0].languages, ['C#', 'Go', 'Python']);
    assert.deepEqual(doc.targets.map((t) => t.provider).sort(), ['aws', 'azure', 'gcp']);
    assert.ok(doc.items.some((i) => i.kind === 'deployment' && i.resource === 'aws_s3_bucket.assets'));
    assert.ok(doc.items.some((i) => i.kind === 'security' && i.evidence.includes('service/infra/main.tf:2')));
    assert.ok(doc.items.every((i) => i.status === 'pending'));
    assert.ok(doc.items.some((i) => i.requirement.includes('DATABASE_URL') && i.evidence.includes('service/main.py:2')));
    assert.doesNotMatch(JSON.stringify(doc), /super-secret-value|AWS_ACCESS_KEY_ID|DO_NOT_EXPORT/);
    assert.equal(doc.analysis[0].files, 6);
  });

  it('saves categories, resources, requirements, evidence, custom providers and review status', async () => {
    const doc = (await get()).checklist;
    const row = doc.items[0];
    Object.assign(row, { category: 'Release', resource: 'Production runtime', requirement: 'Run migration before release', evidence: ['service/main.py:1', 'https://example.com/review'], status: 'approved', notes: 'Reviewed by operations' });
    doc.targets.push({ id: 'custom-service', provider: 'custom', name: 'External queue' });
    doc.items.push({ ...row, id: 'manual', targetId: 'custom-service', kind: 'security', requirement: 'Rotate service credential' });
    const r = await save(doc);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const stored = (await get()).checklist;
    assert.equal(stored.items[0].status, 'approved');
    assert.ok(stored.items[0].reviewedBy);
    assert.ok(stored.items[0].reviewedAt);
    assert.equal(stored.items.at(-1)?.targetId, 'custom-service');
  });

  it('regenerates with new findings while preserving edits, reviews, manual rows and deletions', async () => {
    let doc = (await get()).checklist;
    const preserved = structuredClone(doc.items[0]);
    const removed = doc.items[1].id;
    doc.items.splice(1, 1);
    assert.equal((await save(doc)).status, 200);
    doc = (await get()).checklist;
    await fs.appendFile(path.join(root, 'infra', 'main.tf'), '\nresource "aws_sqs_queue" "jobs" {}');
    assert.equal((await generate(doc.revision)).status, 200);
    const next = (await get()).checklist;
    assert.deepEqual(next.items.find((i) => i.id === preserved.id), preserved);
    assert.ok(next.items.some((i) => i.id === 'manual'));
    assert.ok(!next.items.some((i) => i.id === removed));
    assert.ok(next.suppressed.includes(removed));
    assert.ok(next.items.some((i) => i.resource === 'aws_sqs_queue.jobs'));
    assert.ok(next.items.some((i) => i.targetId === 'custom-service' && i.requirement.includes('service owner')));
    const count = next.items.length;
    assert.equal((await generate(next.revision)).status, 200);
    assert.equal((await get()).checklist.items.length, count);
  });

  it('rejects stale saves, stale generation and competing storage writes', async () => {
    const doc = (await get()).checklist;
    assert.equal((await save(doc)).status, 200);
    assert.equal((await save(doc)).status, 409);
    assert.equal((await generate(doc.revision)).status, 409);
    const current = await readChecklist(projectId);
    assert.ok(current);
    const next = { ...current, revision: current.revision + 1 };
    await writeChecklist(projectId, current, next);
    await assert.rejects(writeChecklist(projectId, current, next), ChecklistConflict);
  });

  it('exports saved JSON and Markdown with evidence, provider and review information', async () => {
    const json = await fetchJson(baseUrl, `${url()}/export?format=json`, { cookie });
    assert.equal(json.status, 200);
    assert.ok(json.headers.get('content-disposition')?.includes('checklists.json'));
    assert.equal((json.body as Checklist).items[0].status, 'approved');
    const markdown = await fetchJson(baseUrl, `${url()}/export?format=markdown`, { cookie });
    assert.equal(markdown.status, 200);
    assert.match(String(markdown.body), /# Deployment and security checklist/);
    assert.match(String(markdown.body), /\[x\] Release/);
    assert.match(String(markdown.body), /service\/main.py:1/);
    assert.match(String(markdown.body), /External queue \/ custom/);
    assert.doesNotMatch(String(markdown.body), /super-secret-value/);
    assert.equal((await fetchJson(baseUrl, `${url()}/export?format=html`, { cookie })).status, 400);
  });

  it('enforces project isolation and viewer/editor permissions for all endpoints', async () => {
    const doc = (await get()).checklist;
    for (const route of [url(), `${url()}/export?format=json`]) {
      assert.equal((await fetchJson(baseUrl, route)).status, 401);
      assert.equal((await fetchJson(baseUrl, route, { cookie: outsiderCookie })).status, 404);
      assert.equal((await fetchJson(baseUrl, route, { cookie: viewerCookie })).status, 200);
    }
    for (const [route, method, body] of [[url(), 'PUT', doc], [`${url()}/generate`, 'POST', { revision: doc.revision }]] as const) {
      assert.equal((await fetchJson(baseUrl, route, { method, body, cookie: viewerCookie })).status, 403);
      assert.equal((await fetchJson(baseUrl, route, { method, body, cookie: outsiderCookie })).status, 404);
      assert.equal((await fetchJson(baseUrl, route, { method, body })).status, 401);
    }
    assert.equal((await fetchJson(baseUrl, url(), { method: 'PUT', body: doc, cookie: editorCookie })).status, 200);
    const other = (await fetchJson(baseUrl, '/api/projects', { cookie, body: { name: 'Isolated checklist' } })).body as Json;
    assert.equal(((await fetchJson(baseUrl, `/api/projects/${other.project.id}/checklists`, { cookie })).body as Json).checklist, null);
  });

  it('rejects malformed documents without changing saved reviews', async () => {
    const doc = (await get()).checklist;
    const bad = [
      { ...doc, targets: [{ id: 'bad', provider: 'invalid', name: 'Bad' }] },
      { ...doc, items: [{ ...doc.items[0], status: 'complete' }] },
      { ...doc, items: [{ ...doc.items[0], targetId: 'other-project' }] },
      { ...doc, items: [{ ...doc.items[0], evidence: 'not-an-array' }] },
      { ...doc, items: [doc.items[0], doc.items[0]] },
      { ...doc, items: [{ ...doc.items[0], requirement: 'x'.repeat(4001) }] },
      { ...doc, targets: null },
    ];
    for (const input of bad) assert.equal((await fetchJson(baseUrl, url(), { cookie, method: 'PUT', body: input })).status, 400);
    assert.deepEqual((await get()).checklist, doc);
    assert.equal((await fetchJson(baseUrl, `${url()}/generate`, { cookie, body: null, method: 'POST' })).status, 400);
  });

  it('supports unknown languages, unreadable clones and repository statuses explicitly', async () => {
    const other = path.join(root, 'unclassified');
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'program.unknown'), 'custom language');
    const analysis = await analyzeRepository(other, { id: 'unknown', name: 'unknown', status: 'ready' });
    assert.equal(analysis.files, 1);
    const doc = generateChecklist(null, [analysis]);
    assert.ok(doc.items.some((i) => i.kind === 'security'));
    assert.equal(doc.targets[0].provider, 'custom');
    const unavailable = await analyzeRepository(path.join(root, 'missing'), { id: 'missing', name: 'missing', status: 'ready' });
    assert.equal(unavailable.files, 0);
    assert.ok(unavailable.warnings.length);
    const cloning = await analyzeRepository(root, { id: 'cloning', name: 'cloning', status: 'cloning' });
    assert.equal(cloning.files, 0);
    assert.match(cloning.warnings[0], /cloning/);
  });

  it('skips dependencies, binaries and large files', async () => {
    const isolated = path.join(root, 'bounded');
    await fs.mkdir(path.join(isolated, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(isolated, 'node_modules', 'aws.js'), '@aws-sdk');
    await fs.writeFile(path.join(isolated, 'binary.dat'), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(isolated, 'large.txt'), 'x'.repeat(130000));
    const analysis = await analyzeRepository(isolated, { id: 'bounded', name: 'bounded', status: 'ready' });
    assert.deepEqual(analysis.providers, []);
    assert.equal(analysis.files, 2);
    assert.ok(analysis.warnings.some((w) => w.includes('limits')));
  });
});

it('DynamoDB checklist storage uses consistent reads and conditional revisions', async (t) => {
  const { getDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');
  const { read, write } = await import('../server/repositories/project-checklists-dynamodb.ts');
  const client = getDynamoDbClient();
  const commands: any[] = [];
  let stored: any;
  t.mock.method(client, 'send', async (command: any) => {
    const input = command.input;
    commands.push(input);
    if (command.constructor.name === 'GetItemCommand') return { Item: stored };
    const revision = stored?.revision?.N;
    const expected = input.ExpressionAttributeValues?.[':previous']?.N;
    if ((expected && revision !== expected) || (!expected && stored)) throw Object.assign(new Error('Conflict'), { name: 'ConditionalCheckFailedException' });
    stored = input.Item;
    return {};
  });
  assert.equal(await read('dynamo-project'), null);
  const first = generateChecklist(null, []);
  await write('dynamo-project', null, first);
  assert.deepEqual(await read('dynamo-project'), first);
  assert.equal(commands[0].ConsistentRead, true);
  assert.equal(commands[1].ConditionExpression, 'attribute_not_exists(PK)');
  const second = { ...first, revision: 2 };
  await write('dynamo-project', first, second);
  assert.equal(commands.at(-1).ExpressionAttributeValues[':previous'].N, '1');
  await assert.rejects(write('dynamo-project', first, second), ChecklistConflict);
  assert.equal((await read('dynamo-project'))?.revision, 2);
});
