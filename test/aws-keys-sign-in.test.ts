/**
 * "Amazon Bedrock (AWS access keys)": a Claude Code sign-in made of the keys the AWS access portal copies (access key
 * ID, secret, session token). They are checked on the way in, stored encrypted and never shown again, used as the run's
 * Bedrock access (locally and, for the cloud runner, sent along with the run), and replaceable when they expire.
 * Also: reading those keys out of whatever block the AWS portal copied.
 */
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { resolveCredentialEnv, resolveBedrockEnvForRunner, BEDROCK_RUNTIME_SIGN_IN } from '../server/credentials.ts';
import { anthropicAuthFromEnv } from '../server/agent/claude-agentcore.ts';
import { one } from '../server/db.ts';
import { getCredentialsRepository } from '../server/repositories/credentials.ts';
// @ts-expect-error — plain JS module without type declarations
import { parseAwsPaste } from '../web/src/lib/aws-paste.js';

const KEYS = { accessKeyId: 'ASIAEXAMPLE1234567890', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', sessionToken: 'IQoJb3JpZ2luX2VjEXAMPLE+token/with=padding' };

describe('Amazon Bedrock (AWS access keys) sign-in', () => {
  let base = ''; let cookie = ''; let userId = ''; let credId = '';
  const post = (body: unknown) => fetchJson(base, '/api/credentials', { cookie, method: 'POST', body });

  before(async () => {
    ({ baseUrl: base } = await createTestServer());
    cookie = (await fetchJson(base, '/api/auth/setup', { method: 'POST', body: { email: 'keys@example.com', name: 'Admin', password: 'password1234', provider: 'demo' } })).cookie!;
    userId = String(one<{ id: string }>('SELECT id FROM users WHERE email = ?', 'keys@example.com')!.id);
  });
  after(async () => { await cleanup(); });

  it('refuses keys that look wrong, and temporary keys without a session token', async () => {
    const make = (awsKeys: unknown) => post({ engine: 'claude-code', mode: 'aws_keys', name: 'Work AWS', config: { region: 'ap-southeast-1' }, awsKeys });
    assert.equal((await make({ ...KEYS, accessKeyId: 'nope' })).status, 400);
    assert.equal((await make({ ...KEYS, secretAccessKey: 'short' })).status, 400);
    const noToken = await make({ accessKeyId: KEYS.accessKeyId, secretAccessKey: KEYS.secretAccessKey });
    assert.equal(noToken.status, 400);
    assert.match(String((noToken.body as { error: string }).error), /session token/);
    assert.equal((await make({ ...KEYS, sessionToken: 'two\nlines' })).status, 400);
    assert.equal((await post({ engine: 'kiro', mode: 'aws_keys', name: 'x', config: { region: 'us-east-1' }, awsKeys: KEYS })).status, 400, 'Kiro has no such sign-in');
  });

  it('stores them encrypted and never returns them', async () => {
    const r = await post({ engine: 'claude-code', mode: 'aws_keys', name: 'Work AWS', config: { region: 'ap-southeast-1' }, awsKeys: KEYS });
    assert.equal(r.status, 201);
    const cred = (r.body as { credential: { id: string; last4: string } }).credential;
    credId = cred.id;
    assert.equal(cred.last4, '7890');
    const shown = JSON.stringify((await fetchJson(base, '/api/credentials', { cookie })).body);
    for (const secret of [KEYS.secretAccessKey, KEYS.sessionToken]) assert.ok(!shown.includes(secret), 'secrets are write-only');
    const stored = String((await getCredentialsRepository().getById(credId))!.secret_enc);
    assert.ok(!stored.includes(KEYS.secretAccessKey), 'encrypted at rest');
  });

  it('a run with it uses Bedrock with those keys, and no Anthropic key goes with it', async () => {
    const env = await resolveCredentialEnv('claude-code', userId, credId);
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1');
    assert.equal(env.AWS_ACCESS_KEY_ID, KEYS.accessKeyId);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, KEYS.secretAccessKey);
    assert.equal(env.AWS_SESSION_TOKEN, KEYS.sessionToken);
    assert.equal(env.AWS_REGION, 'ap-southeast-1');
    assert.equal(anthropicAuthFromEnv(env), null);
  });

  it('the cloud runner gets the keys only for this sign-in, never for the runtime-role choice or an Anthropic key', async () => {
    const forRunner = await resolveBedrockEnvForRunner(userId, credId);
    assert.deepEqual(Object.keys(forRunner).sort(), ['AWS_ACCESS_KEY_ID', 'AWS_DEFAULT_REGION', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']);
    assert.equal(forRunner.AWS_ACCESS_KEY_ID, KEYS.accessKeyId);
    assert.deepEqual(await resolveBedrockEnvForRunner(userId, BEDROCK_RUNTIME_SIGN_IN), {});
    assert.deepEqual(await resolveBedrockEnvForRunner(userId, null), {});
    const key = (await post({ engine: 'claude-code', mode: 'api_key', name: 'Anthropic', secret: 'sk-ant-api03-abcdefgh' })).body as { credential: { id: string } };
    assert.deepEqual(await resolveBedrockEnvForRunner(userId, key.credential.id), {});
    assert.deepEqual(await resolveBedrockEnvForRunner('someone-else', credId), {}, 'another person\'s sign-in is not theirs to use');
  });

  it('replacing the keys swaps them and checks the new ones', async () => {
    const fresh = { ...KEYS, accessKeyId: 'ASIAFRESH0987654321X' };
    assert.equal((await fetchJson(base, `/api/credentials/${credId}`, { cookie, method: 'PUT', body: { awsKeys: { ...fresh, accessKeyId: 'bad' } } })).status, 400);
    const r = await fetchJson(base, `/api/credentials/${credId}`, { cookie, method: 'PUT', body: { awsKeys: fresh } });
    assert.equal(r.status, 200);
    assert.equal((await resolveCredentialEnv('claude-code', userId, credId)).AWS_ACCESS_KEY_ID, fresh.accessKeyId);
    assert.equal((r.body as { credential: { last4: string } }).credential.last4, '321X');
  });
});

describe('reading the block the AWS portal copies', () => {
  it('macOS / Linux export lines', () => {
    const got = parseAwsPaste('export AWS_ACCESS_KEY_ID="ASIA123"\nexport AWS_SECRET_ACCESS_KEY="sec/ret+1"\nexport AWS_SESSION_TOKEN="tok=="\n');
    assert.deepEqual(got, { accessKeyId: 'ASIA123', secretAccessKey: 'sec/ret+1', sessionToken: 'tok==' });
  });
  it('Windows set and PowerShell lines', () => {
    assert.deepEqual(parseAwsPaste('set AWS_ACCESS_KEY_ID=ASIA123\nset AWS_SECRET_ACCESS_KEY=abc\nset AWS_SESSION_TOKEN=tok'), { accessKeyId: 'ASIA123', secretAccessKey: 'abc', sessionToken: 'tok' });
    assert.deepEqual(parseAwsPaste('$Env:AWS_ACCESS_KEY_ID="ASIA123"\n$Env:AWS_SECRET_ACCESS_KEY="abc"\n$Env:AWS_SESSION_TOKEN="tok"'), { accessKeyId: 'ASIA123', secretAccessKey: 'abc', sessionToken: 'tok' });
  });
  it('the credentials-file block, with a region when there is one', () => {
    const got = parseAwsPaste('[123456789012_Admin]\naws_access_key_id=ASIA123\naws_secret_access_key=abc\naws_session_token=tok\nregion = ap-southeast-1\n');
    assert.deepEqual(got, { accessKeyId: 'ASIA123', secretAccessKey: 'abc', sessionToken: 'tok', region: 'ap-southeast-1' });
  });
  it('returns only what it finds', () => {
    assert.deepEqual(parseAwsPaste('hello'), {});
    assert.deepEqual(parseAwsPaste('export AWS_ACCESS_KEY_ID=ASIA123'), { accessKeyId: 'ASIA123' });
  });
});
