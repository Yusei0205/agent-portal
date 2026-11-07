/**
 * "Amazon Bedrock (this AWS account)": on the cloud portal (the Claude AgentCore runtime is configured) Claude Code can
 * always be run on Bedrock with the runtime's role, as a choice next to the person's own sign-ins. It is not a stored
 * credential: the list offers it, a session can pick it, and the run environment then selects Bedrock.
 */
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { resolveCredentialEnv, BEDROCK_RUNTIME_SIGN_IN, isBedrockRuntimeChoice } from '../server/credentials.ts';
import { anthropicAuthFromEnv } from '../server/agent/claude-agentcore.ts';

type Entry = { engine: string; credentials: Array<{ id: string; name: string; virtual?: boolean; isDefault: boolean }> };

describe('Amazon Bedrock sign-in choice', () => {
  let base = ''; let cookie = '';
  const summary = async () => ((await fetchJson(base, '/api/credentials/summary', { cookie })).body as { summary: Entry[] }).summary;
  const saved = process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN;

  before(async () => {
    delete process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN;
    ({ baseUrl: base } = await createTestServer());
    cookie = (await fetchJson(base, '/api/auth/setup', { method: 'POST', body: { email: 'bedrock@example.com', name: 'Admin', password: 'password1234', provider: 'demo' } })).cookie!;
  });
  after(async () => {
    if (saved === undefined) delete process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN; else process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN = saved;
    await cleanup();
  });

  it('is not offered, and means nothing, outside the cloud portal', async () => {
    const claude = (await summary()).find((e) => e.engine === 'claude-code')!;
    assert.ok(!claude.credentials.some((c) => c.virtual));
    assert.equal(isBedrockRuntimeChoice('claude-code', BEDROCK_RUNTIME_SIGN_IN), false);
    const env = await resolveCredentialEnv('claude-code', null, BEDROCK_RUNTIME_SIGN_IN);
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined, 'a stale id does not switch the provider');
  });

  it('on the cloud portal it is listed for Claude Code only, and is never the default', async () => {
    process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:111122223333:runtime/claude';
    const list = await summary();
    const claude = list.find((e) => e.engine === 'claude-code')!;
    const choice = claude.credentials.find((c) => c.virtual)!;
    assert.equal(choice.id, 'bedrock');
    assert.match(choice.name, /Amazon Bedrock/);
    assert.equal(choice.isDefault, false);
    assert.ok(!list.find((e) => e.engine === 'kiro')!.credentials.some((c) => c.virtual));
  });

  it('the sign-in check refuses a bad request, and says a Claude plan token can only be confirmed by a run', async () => {
    const check = (body: unknown) => fetchJson(base, '/api/credentials/check', { cookie, method: 'POST', body });
    assert.equal((await check({ engine: 'codex' })).status, 400);
    assert.equal((await check({ engine: 'claude-code', credentialId: 'nope' })).status, 404);
    const made = (await fetchJson(base, '/api/credentials', { cookie, method: 'POST', body: { engine: 'claude-code', mode: 'subscription_token', name: 'Plan', secret: 'oauth-token-abcd' } })).body as { credential: { id: string } };
    const r = await check({ engine: 'claude-code', credentialId: made.credential.id });
    assert.equal(r.status, 200);
    assert.deepEqual({ ok: (r.body as any).ok, checked: (r.body as any).checked }, { ok: true, checked: false });
    assert.match(String((r.body as any).message), /first session will tell/);
  });

  it('choosing it selects Bedrock with the runtime role, so a run does not use an Anthropic key', async () => {
    const env = await resolveCredentialEnv('claude-code', null, BEDROCK_RUNTIME_SIGN_IN);
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1');
    assert.equal(anthropicAuthFromEnv(env), null, 'no Anthropic key or token goes with the run');
    assert.equal(isBedrockRuntimeChoice('kiro', BEDROCK_RUNTIME_SIGN_IN), false, 'only Claude Code has it');
  });
});
