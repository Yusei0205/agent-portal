/**
 * The real Claude Code engine (the installed Agent SDK and its bundled CLI), driven through the portal against a
 * stand-in Anthropic API that scripts the model's replies. These tests check what the engine actually does with the
 * portal's settings, which the stand-in SDK used by `npm test` cannot show. Run with `npm run test:engine`.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, Client, waitFor, startSingleRun, type TestServer } from '../client.ts';
import { startMockAnthropic } from '../mock-anthropic-api.ts';

const KEY = 'sk-ant-ENGINE-TEST-KEY-000111222';
let api: Awaited<ReturnType<typeof startMockAnthropic>>;
let srv: TestServer;
let c: Client;
let pid: string;

before(async () => {
  api = await startMockAnthropic();
  process.env.PORTAL_ANTHROPIC_BASE_URL = api.url;
  delete process.env.PORTAL_SDK_MODULE;
  srv = await bootServer();
  c = new Client(srv.base);
  await c.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: 'a-long-password-1' });
  pid = (await c.post('/api/projects', { name: 'Engine check' })).project.id;
  await c.put('/api/settings', { provider: { mode: 'anthropic' } });
  await c.post('/api/settings/secrets/anthropic.api_key', { value: KEY });
});

after(async () => {
  await srv?.close();
  await api?.close();
});

/** Start a single run and wait for its end, allowing each approval it asks for. */
async function runToEnd(body: Record<string, unknown>) {
  const { run } = await startSingleRun(c, pid, body);
  return waitFor(
    async () => {
      const r = await c.get(`/api/runs/${run.id}`);
      for (const i of r.inputs ?? []) {
        if (i.status === 'pending' && i.type === 'approval') await c.post(`/api/inputs/${i.id}/answer`, { decision: 'allow' }).catch(() => {});
      }
      return ['completed', 'failed', 'stopped'].includes(r.run.status) ? r : null;
    },
    'the run to finish',
    150_000,
  );
}

/** The text of every tool result the engine sent back to the model. */
function toolResults(r: any): string {
  const out: string[] = [];
  for (const e of r.events) {
    if (e.type !== 'user') continue;
    for (const b of e.data?.message?.content ?? []) {
      if (b?.type === 'tool_result') out.push(typeof b.content === 'string' ? b.content : (b.content ?? []).map((x: any) => x.text ?? '').join(''));
    }
  }
  return out.join('\n');
}

test('the model key never reaches a shell command; the project AWS account does; the run keeps its mode', { timeout: 200_000 }, async () => {
  await c.put(`/api/projects/${pid}/aws`, { auth: 'keys', region: 'eu-west-1', accessKeyId: 'AKIAENGINETEST000001', secretAccessKey: 'engine-test-project-secret-0123456789' });
  // `portal-aws-env` is the wrapper agents use for Terraform or SDK code; it points AWS_* at the run's credentials file.
  const awsCheck = 'eval "$(portal-aws-env)"; echo "profile=$AWS_PROFILE region=$AWS_REGION"; grep -c "aws_access_key_id = AKIAENGINETEST000001" "$AWS_SHARED_CREDENTIALS_FILE"';
  api.setScript([
    { tool: 'Bash', input: { command: 'printenv', description: 'List the environment' } },
    { tool: 'Bash', input: { command: awsCheck, description: 'Use the project AWS account' } },
    { text: 'Done.' },
  ]);
  const r = await runToEnd({ prompt: 'Show the environment', permissionMode: 'acceptEdits' });
  assert.equal(r.run.status, 'completed', r.run.error ?? '');

  const out = toolResults(r);
  assert.match(out, /^PATH=/m, 'printenv ran in the shell');
  assert.ok(!out.includes(KEY), 'the Anthropic key is not in the shell environment');
  assert.doesNotMatch(out, /^ANTHROPIC_API_KEY=/m);
  assert.ok(api.requests.some((q) => q.headers['x-api-key'] === KEY), 'Claude Code itself still calls the API with the key');

  // The project's own AWS account is meant for the agent: a per-run credentials file, not secret-looking variables.
  assert.doesNotMatch(out, /AKIAENGINETEST000001.*\n.*engine-test-project-secret/, 'the keys are not in the environment');
  assert.doesNotMatch(out, /^(PROJECT_)?AWS_SECRET_ACCESS_KEY=/m);
  assert.match(out, /^PROJECT_AWS_FILES=.*run-aws/m);
  assert.match(out, /profile=project region=eu-west-1\n1/, 'the wrapper points the agent at the project account');

  const init = r.events.find((e: any) => e.type === 'system:init');
  assert.equal(init?.data?.permissionMode, 'acceptEdits', 'the run kept its own permission mode');
});
