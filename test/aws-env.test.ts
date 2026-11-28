import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanAwsEnv as cleanKiro, validatePayload as validateKiro } from '../kiro-runner/src/validate.ts';
import { cleanAwsEnv as cleanClaude, validatePayload as validateClaude } from '../agent-runner/src/validate.ts';

const good = { AWS_ACCESS_KEY_ID: 'AKIAABCDEFGHIJKLMNOP', AWS_SECRET_ACCESS_KEY: 'x'.repeat(40), AWS_REGION: 'ap-southeast-1' };

for (const [name, clean] of [['kiro-runner', cleanKiro], ['agent-runner', cleanClaude]] as const) {
  describe(`${name}: the project's AWS account`, () => {
    test('keeps the five AWS variables', () => {
      assert.deepEqual(clean({ ...good, AWS_SESSION_TOKEN: 'tok', AWS_DEFAULT_REGION: 'ap-southeast-1' }), { ...good, AWS_SESSION_TOKEN: 'tok', AWS_DEFAULT_REGION: 'ap-southeast-1' });
    });
    test('drops every other variable', () => {
      const out = clean({ ...good, PATH: '/evil', LD_PRELOAD: '/x.so', AWS_PROFILE: 'admin' });
      assert.deepEqual(Object.keys(out ?? {}).sort(), ['AWS_ACCESS_KEY_ID', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY']);
    });
    test('needs both keys, plain strings, no line breaks', () => {
      assert.equal(clean({ AWS_ACCESS_KEY_ID: 'AKIAABCDEFGHIJKLMNOP' }), undefined);
      assert.equal(clean({ ...good, AWS_SECRET_ACCESS_KEY: 'a\nb' }), undefined);
      assert.equal(clean({ ...good, AWS_ACCESS_KEY_ID: 5 }), undefined);
      assert.equal(clean(null), undefined);
      assert.equal(clean(['AWS_ACCESS_KEY_ID']), undefined);
    });
  });
}

describe('kiro-runner payload', () => {
  test('carries bedrockEnv through validation, cleaned like awsEnv', () => {
    const r = validateClaude({
      runId: 'r1', prompt: 'hi', bedrockEnv: { ...good, PATH: '/evil' },
    });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(Object.keys(r.payload.bedrockEnv ?? {}).sort(), ['AWS_ACCESS_KEY_ID', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY']);
  });

  test('carries awsEnv through validation', () => {
    const r = validateKiro({
      mode: 'kiro-run', runId: 'r1', prompt: 'hi', awsEnv: { ...good, PATH: '/evil' },
      token: { accessToken: 'a', expiresAt: '2030-01-01T00:00:00Z', refreshToken: 'r', region: 'us-east-1', startUrl: 'https://x.awsapps.com/start' },
    });
    assert.ok(r.ok, JSON.stringify(r));
    if (r.ok && r.payload.mode === 'kiro-run') assert.deepEqual(Object.keys(r.payload.awsEnv ?? {}).sort(), ['AWS_ACCESS_KEY_ID', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY']);
  });
});
