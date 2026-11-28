/**
 * The Claude models a session on the AgentCore runtime can use (server/agent/runtime-models.ts):
 *   ✓ Bedrock lists newer Claude models before an account may call them; the pickers and /model offer only the
 *     runtime's models this account may use, whatever the portal's provider setting is.
 *   ✓ A session stuck on a model the account may not use can be switched with /model (or /model default).
 *   ✓ A turn that ended on an API error fails the run with a plain message (claude-agentcore-bedrock.ts).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import {
  RUNTIME_BEDROCK_MODELS, RUNTIME_DEFAULT_MODEL, modelLabel, runtimeClaudeModels, runApiError, explainModelError,
  _setAvailabilityCheck,
} from '../server/agent/runtime-models.ts';
import { bedrockModelFor } from '../server/agent/claude-agentcore-bedrock.ts';

/** What Bedrock said for this account on 2026-11-07 (GetFoundationModelAvailability): 4.5 and 4.6 only. */
const ACCOUNT_MAY_USE = new Set([
  'anthropic.claude-haiku-4-5-20251001-v1:0', 'anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic.claude-opus-4-5-20251101-v1:0',
  'anthropic.claude-sonnet-4-6', 'anthropic.claude-opus-4-6-v1',
]);
const accountCheck = async (id: string) => ACCOUNT_MAY_USE.has(id);

const REFUSED = 'API Error: 403 anthropic.claude-sonnet-5-5 is not available for this account. You can explore other available models on Amazon Bedrock.';

describe('the runtime\'s Claude models', () => {
  it('names models the way people know them', () => {
    assert.equal(modelLabel('global.anthropic.claude-sonnet-5-5'), 'Claude Sonnet 5.5');
    assert.equal(modelLabel('anthropic.claude-opus-4-6-v1'), 'Claude Opus 4.6');
    assert.equal(modelLabel('global.anthropic.claude-haiku-4-5-20251001-v1:0'), 'Claude Haiku 4.5');
    assert.equal(modelLabel('global.anthropic.claude-fable-5-1'), 'Claude Fable 5.1');
    assert.equal(modelLabel('something-else'), 'something-else');
  });

  it('runs Sonnet 4.6 and Opus 4.6 through their global profiles', () => {
    assert.equal(bedrockModelFor('claude-sonnet-4-6'), 'global.anthropic.claude-sonnet-4-6');
    assert.equal(bedrockModelFor('anthropic.claude-opus-4-6-v1'), 'global.anthropic.claude-opus-4-6-v1');
    assert.equal(bedrockModelFor('global.anthropic.claude-sonnet-4-6'), 'global.anthropic.claude-sonnet-4-6');
    assert.ok(Object.values(RUNTIME_BEDROCK_MODELS).includes('anthropic.claude-sonnet-4-6'));
    // The old model list offered US profiles; the runtime's role may call only the global ones.
    assert.equal(bedrockModelFor('us.anthropic.claude-sonnet-4-6'), 'global.anthropic.claude-sonnet-4-6');
    assert.equal(bedrockModelFor('apac.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'global.anthropic.claude-sonnet-4-5-20250929-v1:0');
    assert.equal(bedrockModelFor('apac.anthropic.claude-3-haiku-20240307-v1:0'), 'apac.anthropic.claude-3-haiku-20240307-v1:0', 'outside the role\'s list: as given');
  });

  it('offers only the models this account may use; one it could not check stays', async () => {
    const { models, hidden } = await runtimeClaudeModels(accountCheck);
    assert.deepEqual(models.map((m) => m.id), [
      'global.anthropic.claude-opus-4-6-v1', 'global.anthropic.claude-sonnet-4-6',
      'global.anthropic.claude-opus-4-5-20251101-v1:0', 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    ]);
    assert.deepEqual(hidden.sort(), ['global.anthropic.claude-haiku-5-5', 'global.anthropic.claude-opus-5-5', 'global.anthropic.claude-sonnet-5-5']);
    assert.equal(models.find((m) => m.default)?.id, RUNTIME_DEFAULT_MODEL, 'the runner\'s default is marked');
    assert.equal(models[1].label, 'Claude Sonnet 4.6');

    // No permission to ask (null) or a failed check: keep the model rather than hide one that may work.
    const unsure = await runtimeClaudeModels(async (id) => (id.includes('5-5') ? null : true));
    assert.equal(unsure.models.length, Object.keys(RUNTIME_BEDROCK_MODELS).length);
    const failing = await runtimeClaudeModels(async () => { throw new Error('throttled'); });
    assert.equal(failing.models.length, Object.keys(RUNTIME_BEDROCK_MODELS).length);
  });

  it('recognises a turn that ended on an API error, from the runner or from the answer alone', () => {
    assert.equal(runApiError({ apiError: REFUSED }, 'anything'), REFUSED, 'the runner says so');
    assert.equal(runApiError({ metrics: { inputTokens: 0, outputTokens: 0 } }, REFUSED), REFUSED, 'older runners: the answer is the error and no tokens were used');
    assert.equal(runApiError({ metrics: { inputTokens: 1200, outputTokens: 40 } }, REFUSED), null, 'a model reply that quotes an error is an answer');
    assert.equal(runApiError({ metrics: { inputTokens: 0, outputTokens: 0 } }, 'Done.'), null);
  });

  it('explains a refused model in plain words, with what to do', () => {
    const text = explainModelError(REFUSED, 'global.anthropic.claude-sonnet-5-5');
    assert.match(text, /^Claude Sonnet 5\.5 is not available to this AWS account on Amazon Bedrock/);
    assert.match(text, /\/model/);
    assert.match(text, /Bedrock said: API Error: 403/);
    assert.match(explainModelError('API Error: 403 AccessDeniedException: not authorized', 'global.anthropic.claude-opus-4-6-v1'), /^Bedrock refused the call to Claude Opus 4\.6/);
    assert.match(explainModelError('API Error: 529 overloaded', undefined), /^The call to The model failed|^The call to/);
  });
});

describe('on the cloud portal, the Claude model list and /model use the runtime\'s models', () => {
  const ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/test-runtime';
  let baseUrl = '';
  let cookie = '';
  let projectId = '';
  let wfId = '';
  let savedArn: string | undefined;

  before(async () => {
    savedArn = process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN;
    process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN = ARN;
    _setAvailabilityCheck(accountCheck);
    ({ baseUrl } = await createTestServer());
    // The real portal's provider is set to something that lists no Claude models ("codex"); here: demo.
    const setup = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST', body: { email: `admin-${Date.now()}@example.com`, name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    cookie = setup.cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Models' }, cookie });
    projectId = ((p.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
    // A Claude session stuck on Sonnet 5.5, like the one on the cloud portal (no run is started here).
    const { insert } = await import('../server/db.ts');
    const { now, generateId } = await import('../server/util.ts');
    wfId = `wf-${generateId()}`;
    insert('p6_workflows', {
      id: wfId, project_id: projectId, goal: 'Review the repository', status: 'paused', engine: 'claude-code',
      model: 'global.anthropic.claude-sonnet-5-5', trust_tools: 1, repo_ids: '[]', created_at: now(), updated_at: now(),
    });
  });
  after(async () => {
    _setAvailabilityCheck(null);
    if (savedArn === undefined) delete process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN;
    else process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN = savedArn;
    await cleanup();
  });

  const send = (message: string) =>
    fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}/message`, { method: 'POST', body: { message }, cookie });
  async function lastCommandResult(): Promise<string> {
    const { all } = await import('../server/db.ts');
    return all<{ body: string }>("SELECT body FROM p6_workflow_events WHERE workflow_id = ? AND kind = 'command-result' ORDER BY id DESC LIMIT 1", wfId)[0]?.body ?? '';
  }
  async function sessionModel(): Promise<string | null> {
    const { one } = await import('../server/db.ts');
    return one<{ model: string | null }>('SELECT model FROM p6_workflows WHERE id = ?', wfId)?.model ?? null;
  }

  it('the model pickers list the runtime\'s usable models, run on AgentCore', async () => {
    const r = await fetchJson(baseUrl, '/api/engines/claude-code/models?refresh=1', { cookie });
    assert.equal(r.status, 200);
    const body = r.body as { models: Array<{ id: string; label: string; default?: boolean }>; source: string; runsAs: { label: string }; error?: string };
    assert.equal(body.error, undefined, String(body.error));
    assert.equal(body.source, 'bedrock');
    assert.match(body.runsAs.label, /AgentCore/);
    const ids = body.models.map((m) => m.id);
    assert.ok(ids.includes('global.anthropic.claude-sonnet-4-6') && ids.includes('global.anthropic.claude-haiku-4-5-20251001-v1:0'));
    assert.ok(!ids.some((id) => id.includes('5-5')), 'no 5.5 model: this account may not use them');
  });

  it('/model shows them and says the session\'s model is not one of them; /model switches; /model default clears', async () => {
    await send('/model');
    const listing = await lastCommandResult();
    assert.match(listing, /Current model: global\.anthropic\.claude-sonnet-5-5/);
    assert.match(listing, /not in this list/);
    assert.match(listing, /global\.anthropic\.claude-sonnet-4-6 {2}\(Claude Sonnet 4\.6\)/);

    await send('/model Claude Sonnet 4.6');
    assert.match(await lastCommandResult(), /Model switched to global\.anthropic\.claude-sonnet-4-6/);
    assert.equal(await sessionModel(), 'global.anthropic.claude-sonnet-4-6');

    await send('/model sonnet-5-5');
    assert.match(await lastCommandResult(), /No model matches "sonnet-5-5"/, 'a model the account may not use cannot be picked');

    const cleared = await send('/model default');
    assert.match(await lastCommandResult(), /engine default \(Claude Haiku 4\.5\)/, `the reply to /model default: ${cleared.status} ${JSON.stringify(cleared.body)}`);
    assert.equal(await sessionModel(), '', 'no model of its own: runs use the engine default');
  });
});
