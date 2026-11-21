import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowList, isEmailAllowed, checkClaims, buildAuthUrl } from '../server/google-auth.ts';

test('allow-list accepts exact emails and domains, ignores case and spacing', () => {
  const raw = ' Alice@Example.com, @corp.example ;bob@other.org';
  assert.equal(isEmailAllowed('alice@example.com', raw), true);
  assert.equal(isEmailAllowed('ANY@CORP.EXAMPLE', raw), true);
  assert.equal(isEmailAllowed('bob@other.org', raw), true);
  assert.equal(isEmailAllowed('eve@other.org', raw), false);
  assert.equal(isEmailAllowed('x@sub.corp.example', raw), false);
});

test('empty or missing allow-list allows nobody', () => {
  assert.equal(isEmailAllowed('a@b.com', ''), false);
  assert.equal(isEmailAllowed('a@b.com', undefined), false);
  assert.equal(isEmailAllowed('not-an-email', '@b.com'), false);
  assert.deepEqual([...parseAllowList('').emails], []);
});

const good = { iss: 'https://accounts.google.com', aud: 'cid', exp: 2000, nonce: 'n1', email: 'a@b.com', email_verified: true };

test('claims check passes a good token and rejects each kind of bad token', () => {
  assert.equal(checkClaims(good, 'cid', 'n1', 1000), null);
  assert.match(checkClaims({ ...good, iss: 'https://evil.example' }, 'cid', 'n1', 1000)!, /issuer/);
  assert.match(checkClaims({ ...good, aud: 'other' }, 'cid', 'n1', 1000)!, /different application/);
  assert.match(checkClaims({ ...good, exp: 500 }, 'cid', 'n1', 1000)!, /expired/);
  assert.match(checkClaims({ ...good, nonce: 'zzz' }, 'cid', 'n1', 1000)!, /nonce/);
  assert.match(checkClaims({ ...good, email_verified: false }, 'cid', 'n1', 1000)!, /not verified/);
  assert.match(checkClaims({ ...good, email: undefined }, 'cid', 'n1', 1000)!, /email/);
});

test('authorization URL carries state, nonce and the redirect URI', () => {
  const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'https://p.example/api/auth/google/callback', state: 's', nonce: 'n' }));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('state'), 's');
  assert.equal(u.searchParams.get('nonce'), 'n');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://p.example/api/auth/google/callback');
  assert.equal(u.searchParams.get('scope'), 'openid email profile');
});
