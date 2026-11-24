/**
 * The portal's own data for agents (portal-data-mcp.ts): run tokens, who may read what, and each tool over the real endpoint.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getDb } from '../server/db.ts';
import { now, generateId } from '../server/util.ts';
import { config } from '../server/config.ts';
import { hashPassword } from '../server/auth.ts';
import { getKnowledgeRepository } from '../server/repositories/knowledge.ts';
import { getVaultFilesRepository } from '../server/repositories/vault-files.ts';
import { issuePortalDataToken, verifyPortalDataToken, portalDataMcpSpec } from '../server/portal-data-mcp.ts';
import { buildRunnerMcpServers } from '../server/agent/runner-integrations.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

describe('portal data for agents (Knowledge and Vault)', () => {
  let baseUrl = '';
  let adminId = '';
  let projectId = '';
  let otherProjectId = '';
  const memberId = 'user-pd-member';
  const outsiderId = 'user-pd-outsider';

  const call = async (token: string, name: string, args: object = {}): Promise<{ status: number; text: string; isError: boolean }> => {
    const resp = await fetch(`${baseUrl}/api/mcp/portal-data`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const raw = await resp.text();
    if (resp.status !== 200) return { status: resp.status, text: raw, isError: true };
    const m = raw.match(/^data:\s*(.+)$/m);
    const env = JSON.parse(m ? m[1]! : raw) as Json;
    return { status: 200, text: String(env.result?.content?.[0]?.text ?? ''), isError: Boolean(env.result?.isError) };
  };

  before(async () => {
    ({ baseUrl } = await createTestServer());
    const setup = await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'pd-admin@test.com', name: 'Admin', password: 'password1234', provider: 'demo' } });
    adminId = String(((setup.body as Json).user as Json)?.id ?? getDb().prepare("SELECT id FROM users WHERE email = 'pd-admin@test.com'").get()!['id' as never]);
    const db = getDb();
    for (const id of [memberId, outsiderId]) {
      db.prepare('INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)').run(id, `${id}@test.com`, id, hashPassword('password1234'), now());
    }
    projectId = `proj-pd-${generateId()}`;
    otherProjectId = `proj-pd-other-${generateId()}`;
    for (const [id, slug] of [[projectId, `pd-${Date.now()}`], [otherProjectId, `pd-other-${Date.now()}`]]) {
      db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(id, id, slug, now());
    }
    db.prepare('INSERT INTO project_members (project_id, user_id, access, role) VALUES (?, ?, ?, ?)').run(projectId, memberId, 'write', 'member');

    // A ready Knowledge document in the project.
    const slug = String((db.prepare('SELECT slug FROM projects WHERE id = ?').get(projectId) as Json).slug);
    const docId = generateId();
    const kRepo = getKnowledgeRepository();
    await kRepo.createDoc({ id: docId, project_id: projectId, name: 'runbook.md', original_name: 'Runbook.md', mime_type: 'text/markdown', size_bytes: 50, status: 'processing', uploaded_by: memberId, created_at: now() });
    const md = path.join(config.dataDir, 'projects', slug, `docs/md/${docId}.md`);
    fs.mkdirSync(path.dirname(md), { recursive: true });
    const text = '# Runbook\n\n## Deploys\n\nDeploys go through the main_v3 branch and the PORTAL-PIPELINE-X.\n';
    fs.writeFileSync(md, text);
    await kRepo.indexDoc(docId, projectId, text);
    await kRepo.updateDoc(docId, { status: 'ready', markdown_path: md, error: null });

    // Vault: a team file, the member's own file, the outsider's own file, and an image.
    const vRepo = getVaultFilesRepository();
    const put = async (id: string, userId: string | null, name: string, body: string, mime: string) => {
      const rel = path.join('vault-test', id, name);
      fs.mkdirSync(path.join(config.dataDir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(config.dataDir, rel), body);
      await vRepo.create({ id, project_id: projectId, user_id: userId, name, path: rel, size_bytes: body.length, mime_type: mime, uploaded_by: userId ?? adminId, folder: null, source_workflow_id: null, created_at: now() });
    };
    await put('vf-team', null, 'architecture.md', 'TEAM-ARCHITECTURE-NOTES', 'text/markdown');
    await put('vf-mine', memberId, 'my-notes.txt', 'MEMBER-PRIVATE-NOTES', 'text/plain');
    await put('vf-theirs', outsiderId, 'their-notes.txt', 'OUTSIDER-PRIVATE-NOTES', 'text/plain');
    await put('vf-image', null, 'diagram.png', 'PNGDATA', 'image/png');
  });
  after(cleanup);

  it('tokens name one person and one project, expire, and refuse tampering', () => {
    const t = issuePortalDataToken('u1', 'p1', 1000);
    assert.deepEqual(verifyPortalDataToken(t, 1001), { userId: 'u1', projectId: 'p1' });
    assert.equal(verifyPortalDataToken(t, 1000 + 12 * 3600 + 1), null, 'expired');
    const [payload, mac] = t.slice(3).split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'u1', p: 'p2', e: 9_999_999_999 })).toString('base64url');
    assert.equal(verifyPortalDataToken(`pd_${forged}.${mac}`, 1001), null, 'another project with the old signature');
    assert.equal(verifyPortalDataToken(`pd_${payload}.x${mac!.slice(1)}`, 1001), null, 'bad signature');
    assert.equal(verifyPortalDataToken(`gw_${payload}.${mac}`, 1001), null, 'another kind of token');
  });

  it('a run gets the server only with a person, a project and an https portal address', () => {
    assert.equal(portalDataMcpSpec('u', 'p', 'http://insecure.example'), null);
    assert.equal(portalDataMcpSpec(null, 'p', 'https://k.example'), null);
    assert.equal(portalDataMcpSpec('u', null, 'https://k.example'), null);
    const s = portalDataMcpSpec('u', 'p', 'https://k.example/')!;
    assert.equal(s.url, 'https://k.example/api/mcp/portal-data');
    assert.equal(s.allowWrites, false);
    assert.match(s.headers.Authorization!, /^Bearer pd_/);
  });

  it('every cloud run gets it, first, whatever integrations the session chose', async () => {
    const before = process.env.PORTAL_PUBLIC_URL;
    process.env.PORTAL_PUBLIC_URL = 'https://kyuubit.example';
    try {
      const all = await buildRunnerMcpServers(projectId, memberId, null);
      assert.equal(all[0]?.name, 'portal-data');
      const chosen = await buildRunnerMcpServers(projectId, memberId, ['some-other-integration']);
      assert.equal(chosen[0]?.name, 'portal-data');
    } finally {
      if (before === undefined) delete process.env.PORTAL_PUBLIC_URL; else process.env.PORTAL_PUBLIC_URL = before;
    }
  });

  it('a member searches Knowledge and lists its documents', async () => {
    const t = issuePortalDataToken(memberId, projectId);
    const s = await call(t, 'search_knowledge', { query: 'how do deploys work' });
    assert.equal(s.isError, false, s.text);
    assert.match(s.text, /runbook\.md › Deploys/);
    assert.match(s.text, /PORTAL-PIPELINE-X/);
    const l = await call(t, 'list_knowledge');
    assert.match(l.text, /- Runbook\.md \(text\/markdown, ready\)/);
  });

  it('the Vault shows the team files and only the person\'s own personal files', async () => {
    const t = issuePortalDataToken(memberId, projectId);
    const team = await call(t, 'list_vault', { scope: 'team' });
    assert.match(team.text, /id vf-team: architecture\.md/);
    assert.doesNotMatch(team.text, /my-notes|their-notes/);
    const mine = await call(t, 'list_vault', { scope: 'mine' });
    assert.match(mine.text, /id vf-mine: my-notes\.txt/);
    assert.doesNotMatch(mine.text, /their-notes/);
    assert.match((await call(t, 'read_vault_file', { fileId: 'vf-team' })).text, /TEAM-ARCHITECTURE-NOTES/);
    assert.match((await call(t, 'read_vault_file', { fileId: 'vf-mine' })).text, /MEMBER-PRIVATE-NOTES/);
    const theirs = await call(t, 'read_vault_file', { fileId: 'vf-theirs' });
    assert.equal(theirs.isError, true);
    assert.doesNotMatch(theirs.text, /OUTSIDER-PRIVATE-NOTES/);
    const image = await call(t, 'read_vault_file', { fileId: 'vf-image' });
    assert.equal(image.isError, true);
    assert.match(image.text, /not a text document/);
  });

  it('a person who is not in the project gets nothing, and a bad token is refused', async () => {
    const t = issuePortalDataToken(outsiderId, projectId);
    for (const [name, args] of [['search_knowledge', { query: 'deploys' }], ['list_knowledge', {}], ['list_vault', {}], ['read_vault_file', { fileId: 'vf-team' }]] as const) {
      const r = await call(t, name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.text, /no longer have access/, name);
    }
    // A member's token for another project does not open this one's data either.
    const other = await call(issuePortalDataToken(memberId, otherProjectId), 'list_vault', {});
    assert.match(other.text, /no longer have access/);
    assert.equal((await call('pd_nope.nope', 'list_vault')).status, 401);
    assert.equal((await call('ap_whatever', 'list_vault')).status, 401);
  });

  it('there are no write tools', async () => {
    const resp = await fetch(`${baseUrl}/api/mcp/portal-data`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${issuePortalDataToken(memberId, projectId)}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const raw = await resp.text();
    const m = raw.match(/^data:\s*(.+)$/m);
    const tools = (JSON.parse(m ? m[1]! : raw) as Json).result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
    assert.deepEqual(tools.map((t) => t.name).sort(), ['list_knowledge', 'list_vault', 'read_vault_file', 'search_knowledge']);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  });
});
