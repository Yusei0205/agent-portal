import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './fixtures.ts';
import { SqliteAuthRepository } from '../server/repositories/auth-sqlite.ts';
import { clearAuthRepository, setAuthRepository } from '../server/repositories/auth.ts';
import {
  ACCOUNT_LIMIT,
  IP_LIMIT,
  LOGIN_WINDOW_MS,
  accountKey,
  addressKey,
  clearLoginFailures,
  loginBlocked,
  recordLoginFailure,
} from '../server/login-limiter.ts';
import { dummyPasswordHash, verifyPassword } from '../server/auth.ts';

describe('login limiter', () => {
  before(() => {
    createTestDb();
    setAuthRepository(new SqliteAuthRepository());
  });
  after(() => {
    clearAuthRepository();
  });

  test('keys are hashed, not the raw email or address', () => {
    assert.ok(!accountKey('a@b.com').includes('a@b.com'));
    assert.ok(!addressKey('1.2.3.4').includes('1.2.3.4'));
    assert.notEqual(accountKey('a@b.com'), accountKey('c@d.com'));
  });

  test('an account is blocked after its limit, from any address', async () => {
    const t = Date.now();
    for (let i = 0; i < ACCOUNT_LIMIT; i++) {
      assert.equal(await loginBlocked('victim@x.com', `10.0.0.${i}`, t), false);
      await recordLoginFailure('victim@x.com', `10.0.0.${i}`, t);
    }
    assert.equal(await loginBlocked('victim@x.com', '10.9.9.9', t), true);
    // Another account from a fresh address is unaffected.
    assert.equal(await loginBlocked('other@x.com', '10.9.9.9', t), false);
    // The block ends with the window.
    assert.equal(await loginBlocked('victim@x.com', '10.9.9.9', t + LOGIN_WINDOW_MS + 1000), false);
  });

  test('an address is blocked when it tries many accounts', async () => {
    const t = Date.now();
    for (let i = 0; i < IP_LIMIT; i++) await recordLoginFailure(`user${i}@x.com`, '192.0.2.7', t);
    assert.equal(await loginBlocked('brand-new@x.com', '192.0.2.7', t), true);
    assert.equal(await loginBlocked('brand-new@x.com', '192.0.2.8', t), false);
  });

  test('a correct sign-in clears the account counter', async () => {
    const t = Date.now();
    for (let i = 0; i < ACCOUNT_LIMIT; i++) await recordLoginFailure('typo@x.com', '198.51.100.1', t);
    assert.equal(await loginBlocked('typo@x.com', '198.51.100.2', t), true);
    await clearLoginFailures('typo@x.com');
    assert.equal(await loginBlocked('typo@x.com', '198.51.100.2', t), false);
  });
});

describe('dummy password hash', () => {
  test('is a valid hash that no password matches, and is stable', () => {
    const h = dummyPasswordHash();
    assert.equal(dummyPasswordHash(), h);
    assert.equal(h.split(':').length, 2);
    assert.equal(verifyPassword('', h), false);
    assert.equal(verifyPassword('password', h), false);
  });
});
