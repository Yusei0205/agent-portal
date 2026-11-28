import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { guardedFetch } from '../server/testing/guarded-fetch.ts';
import { checkAddress } from '../server/testing/ssrf.ts';

describe('connect-time address check', () => {
  let server: http.Server;
  let port = 0;
  before(async () => {
    server = http.createServer((_req, res) => { res.end('inside'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  after(() => { server.close(); });

  it('refuses a name that resolves to a loopback address when private networks are off', async () => {
    // "localhost" passes a hostname-only check; the guard sees the address the connection would use.
    await assert.rejects(
      () => guardedFetch(`http://localhost:${port}/`, {}, false),
      (e: Error) => /SSRF blocked/.test(e.message) || /SSRF blocked/.test(String((e as { cause?: Error }).cause?.message)),
    );
  });

  it('connects to the same name when private networks are allowed', async () => {
    const r = await guardedFetch(`http://localhost:${port}/`, {}, true);
    assert.equal(await r.text(), 'inside');
  });

  it('never allows the cloud metadata range, even when private networks are allowed', () => {
    assert.equal(checkAddress('169.254.169.254', true).blocked, true);
    assert.equal(checkAddress('::ffff:169.254.169.254', true).blocked, true);
    assert.equal(checkAddress('10.0.0.5', true).blocked, false);
    assert.equal(checkAddress('10.0.0.5', false).blocked, true);
    assert.equal(checkAddress('93.184.216.34', false).blocked, false);
  });
});
