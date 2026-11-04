/** The signed realtime token is what the AppSync authorizer verifies: same key derivation, expiry and claims. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setConfig } from '../server/config.ts';
import { createTestConfig } from './fixtures.ts';
import { issueRealtimeToken } from '../server/realtime.ts';

test('token verifies with the authorizer algorithm and carries project claims', () => {
  const cfg = createTestConfig();
  setConfig(cfg);
  const token = issueRealtimeToken({ id: 'u1', is_admin: false }, ['p1', 'p2']);
  const [h, c, sig] = token.split('.');
  const key = createHmac('sha256', cfg.secretKey).update('portal-realtime-v1').digest();
  assert.equal(createHmac('sha256', key).update(`${h}.${c}`).digest('base64url'), sig);
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.deepEqual(claims.prj, ['p1', 'p2']);
  assert.equal(claims.adm, false);
  assert.ok(claims.exp > Date.now() / 1000);
});

test('admin tokens are marked adm with no project list', () => {
  setConfig(createTestConfig());
  const claims = JSON.parse(Buffer.from(issueRealtimeToken({ id: 'a', is_admin: true }, ['p1']).split('.')[1], 'base64url').toString());
  assert.equal(claims.adm, true);
  assert.deepEqual(claims.prj, []);
});
