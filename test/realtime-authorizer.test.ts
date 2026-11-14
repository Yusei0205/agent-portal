/**
 * The AppSync Events Lambda authorizer (infra/lib/realtime-authorizer.js) runs as inline Lambda code, so it is loaded here the
 * same way: as plain source. A syntax error in it (a regular expression lost its backslashes once) fails every connection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import crypto from 'node:crypto';

const source = fs.readFileSync(new URL('../infra/lib/realtime-authorizer.js', import.meta.url), 'utf8');
const SECRET = 'master-key-for-tests';
const key = crypto.createHmac('sha256', SECRET).update('portal-realtime-v1').digest();

function authorizer() {
  class Command { constructor(public input: unknown) {} }
  class SecretsManagerClient { async send() { return { SecretString: ` ${SECRET}\n` }; } }
  const context: Record<string, unknown> = {
    exports: {}, Buffer, process: { env: { KEY_SECRET_ARN: 'arn' } },
    require: (name: string) => (name === 'crypto' ? crypto : { SecretsManagerClient, GetSecretValueCommand: Command }),
  };
  vm.runInNewContext(source, context);
  return (context.exports as { handler: (e: unknown) => Promise<{ isAuthorized: boolean }> }).handler;
}

function token(claims: Record<string, unknown>, tamper = false): string {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${tamper ? sig.slice(0, -2) + 'AA' : sig}`;
}
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const ev = (authorizationToken: string, operation: string, channel?: string) => ({ authorizationToken, requestContext: { operation, channel } });

test('the authorizer source compiles and exports a handler', () => {
  assert.equal(typeof authorizer(), 'function');
});

test('any valid token may connect; a bad, tampered or expired one may not', async () => {
  const handler = authorizer();
  assert.equal((await handler(ev(token({ exp: inAnHour() }), 'EVENT_CONNECT'))).isAuthorized, true);
  assert.equal((await handler(ev(token({ exp: inAnHour() }, true), 'EVENT_CONNECT'))).isAuthorized, false);
  assert.equal((await handler(ev(token({ exp: 1 }), 'EVENT_CONNECT'))).isAuthorized, false);
  assert.equal((await handler(ev('nonsense', 'EVENT_CONNECT'))).isAuthorized, false);
});

test('project channels need membership (or admin); global and run channels need a valid token', async () => {
  const handler = authorizer();
  const member = token({ exp: inAnHour(), prj: ['p1'] });
  assert.equal((await handler(ev(member, 'EVENT_SUBSCRIBE', '/project/p1'))).isAuthorized, true);
  assert.equal((await handler(ev(member, 'EVENT_SUBSCRIBE', '/project/p1/extra'))).isAuthorized, true);
  assert.equal((await handler(ev(member, 'EVENT_SUBSCRIBE', '/project/p2'))).isAuthorized, false);
  assert.equal((await handler(ev(token({ exp: inAnHour(), adm: true }), 'EVENT_SUBSCRIBE', '/project/p2'))).isAuthorized, true);
  assert.equal((await handler(ev(member, 'EVENT_SUBSCRIBE', '/global/portal'))).isAuthorized, true);
  assert.equal((await handler(ev(member, 'EVENT_SUBSCRIBE', '/run/r1'))).isAuthorized, true);
  assert.equal((await handler(ev(member, 'EVENT_SUBSCRIBE', '/other/x'))).isAuthorized, false);
});

test('nobody publishes through the authorizer', async () => {
  const handler = authorizer();
  assert.equal((await handler(ev(token({ exp: inAnHour(), adm: true }), 'EVENT_PUBLISH', '/project/p1'))).isAuthorized, false);
});
