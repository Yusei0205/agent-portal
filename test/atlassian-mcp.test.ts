/**
 * Atlassian MCP v2: an OAuth integration still on v1 moves to v2 (cached client and token dropped), a project connected to Jira
 * is offered the integration once, and nothing else is touched.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup } from './fixtures.ts';
import { insert } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';
import { encrypt } from '../server/secrets.ts';
import { config } from '../server/config.ts';
import { getSecret, setSecret } from '../server/secrets.ts';
import { getIntegrationsRepository } from '../server/repositories/integrations.ts';
import { readHttpConfig } from '../server/agent/runner-integrations.ts';
import { ensureAtlassianMcp, isAtlassianV1Url, isAtlassianMcpUrl, ATLASSIAN_MCP_V2 } from '../server/atlassian-mcp.ts';

describe('Atlassian MCP v2', () => {
  let u1 = '';
  let u2 = '';
  before(async () => {
    await createTestServer();
    const user = (n: string): string => {
      const id = generateId();
      insert('users', { id, email: `${n}-${id.slice(0, 6)}@test.com`, name: n, password_hash: 'x', is_admin: 0, disabled: 0, created_at: now() });
      return id;
    };
    u1 = user('one');
    u2 = user('two');
  });
  after(() => { cleanup(); });

  const project = (): string => {
    const id = `proj-atl-${generateId().slice(0, 8)}`;
    insert('projects', { id, slug: `slug-${id}`, name: id, description: '', notes: '', created_by: null, created_at: now(), archived: 0, default_lead_agent: '', default_model: '', monthly_budget_usd: null, team_id: null, vault_generated: 0 });
    return id;
  };
  const add = async (projectId: string, name: string, cfg: Record<string, unknown>) => {
    const id = generateId();
    await getIntegrationsRepository().create({ id, project_id: projectId, name, type: 'http', config_enc: encrypt(JSON.stringify(cfg), config.secretKey), enabled: 1, created_by: u1, created_at: now() });
    return id;
  };
  const connectJira = (projectId: string) => setSecret(`jira.project.${projectId}`, JSON.stringify({ authType: 'api_token', site: { cloudId: 'c', name: 'S', url: 'https://x.atlassian.net' }, apiEmail: 'a@b.c', apiToken: 't' }));
  const list = (projectId: string) => getIntegrationsRepository().listByProject(projectId);

  it('knows the v1 and v2 addresses', () => {
    for (const u of ['https://mcp.atlassian.com/v1/mcp', 'https://mcp.atlassian.com/v1/mcp/authv2', 'https://mcp.atlassian.com/v1/sse', 'https://mcp.atlassian.com/sse']) assert.equal(isAtlassianV1Url(u), true, u);
    for (const u of [ATLASSIAN_MCP_V2, 'https://mcp.atlassian.com/v2/mcp?tools=all', 'https://example.com/v1/mcp', 'not a url']) assert.equal(isAtlassianV1Url(u), false, u);
    assert.equal(isAtlassianMcpUrl(ATLASSIAN_MCP_V2), true);
    assert.equal(isAtlassianMcpUrl('https://mcp.linear.app/mcp'), false);
  });

  it('moves an OAuth integration from v1 to v2 and drops what was cached for v1', async () => {
    const p = project();
    const id = await add(p, 'Atlassian', { url: 'https://mcp.atlassian.com/v1/mcp', auth: 'oauth', allowWrites: true, lastTest: { ok: true, message: 'ok', at: 'x', tools: 3 } });
    await setSecret(`mcp-oauth-client:${id}`, '{"clientId":"v1-client"}');
    await setSecret(`mcp-oauth:${id}:${u1}`, '{"accessToken":"v1-token","expiresAt":9999999999999}');
    const out = await ensureAtlassianMcp(p, u1);
    assert.deepEqual(out, { migrated: ['Atlassian'], added: false });
    const cfg = readHttpConfig((await list(p))[0].config_enc)!;
    assert.equal(cfg.url, ATLASSIAN_MCP_V2);
    assert.equal(cfg.auth, 'oauth');
    assert.equal(cfg.allowWrites, true, 'the person\'s choice about writes is kept');
    assert.equal(cfg.lastTest, undefined);
    assert.equal(await getSecret(`mcp-oauth-client:${id}`), null);
    assert.equal(await getSecret(`mcp-oauth:${id}:${u1}`), null);
    // Done once: a second start changes nothing.
    assert.deepEqual(await ensureAtlassianMcp(p, u1), { migrated: [], added: false });
  });

  it('leaves a v1 integration that signs in with a token header: Atlassian documents tokens for v1 only', async () => {
    const p = project();
    await add(p, 'Atlassian v1', { url: 'https://mcp.atlassian.com/v1/mcp', headers: { Authorization: 'Basic abc' } });
    assert.deepEqual(await ensureAtlassianMcp(p, u1), { migrated: [], added: false });
    assert.equal(readHttpConfig((await list(p))[0].config_enc)!.url, 'https://mcp.atlassian.com/v1/mcp');
  });

  it('adds the integration (read-only, OAuth) to a project connected to Jira, once: deleting it sticks', async () => {
    const p = project();
    await connectJira(p);
    assert.deepEqual(await ensureAtlassianMcp(p, u1), { migrated: [], added: true });
    const [it1] = await list(p);
    assert.equal(it1.name, 'Atlassian');
    assert.equal(it1.enabled, 1);
    assert.equal(it1.created_by, u1);
    assert.deepEqual({ ...readHttpConfig(it1.config_enc)! }, { url: ATLASSIAN_MCP_V2, auth: 'oauth', allowWrites: false });
    assert.deepEqual(await ensureAtlassianMcp(p, u2), { migrated: [], added: false });
    await getIntegrationsRepository().delete(it1.id, p);
    assert.deepEqual(await ensureAtlassianMcp(p, u1), { migrated: [], added: false });
    assert.equal((await list(p)).length, 0);
  });

  it('adds nothing to a project that is not connected to Jira, or that already has an Atlassian integration, or with no person', async () => {
    const none = project();
    assert.deepEqual(await ensureAtlassianMcp(none, u1), { migrated: [], added: false });
    assert.equal((await list(none)).length, 0);

    const has = project();
    await connectJira(has);
    await add(has, 'My Atlassian', { url: ATLASSIAN_MCP_V2, auth: 'oauth' });
    assert.deepEqual(await ensureAtlassianMcp(has, u1), { migrated: [], added: false });
    assert.equal((await list(has)).length, 1);

    const anon = project();
    await connectJira(anon);
    assert.deepEqual(await ensureAtlassianMcp(anon, null), { migrated: [], added: false });
    assert.deepEqual(await ensureAtlassianMcp(null, u1), { migrated: [], added: false });
  });
});
