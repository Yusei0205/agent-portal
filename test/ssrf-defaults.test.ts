import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSsrf, privateNetworksAllowed } from '../server/testing/ssrf.ts';

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

describe('privateNetworksAllowed', () => {
  it('is off on the cloud portal whatever the setting says', () => {
    assert.equal(privateNetworksAllowed('true', env({ DEPLOY_TARGET: 'cloud' })), false);
    assert.equal(privateNetworksAllowed(null, env({ DEPLOY_TARGET: 'cloud' })), false);
  });
  it('can be switched on explicitly in the cloud', () => {
    assert.equal(privateNetworksAllowed('false', env({ DEPLOY_TARGET: 'cloud', PORTAL_ALLOW_PRIVATE_NETWORKS: '1' })), true);
  });
  it('follows the setting elsewhere (default on for local development)', () => {
    assert.equal(privateNetworksAllowed(null, env({})), true);
    assert.equal(privateNetworksAllowed('true', env({})), true);
    assert.equal(privateNetworksAllowed('false', env({})), false);
  });
});

describe('checkSsrf with private networks off', () => {
  for (const host of ['0.0.0.0', '100.64.0.1', '[fd00::1]', '[::]', '[::ffff:10.0.0.5]', '[::ffff:127.0.0.1]', '127.0.0.1']) {
    it(`blocks ${host}`, async () => {
      assert.equal((await checkSsrf(host, false)).blocked, true);
    });
  }
  it('blocks a name that does not resolve', async () => {
    assert.equal((await checkSsrf('does-not-exist.invalid', false)).blocked, true);
  });
  it('still allows a public address', async () => {
    assert.equal((await checkSsrf('8.8.8.8', false)).blocked, false);
  });
});
