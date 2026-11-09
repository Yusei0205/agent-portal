import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootServer, Client, type TestServer } from './client.ts';

// Each test file runs in its own process, so this web folder only applies here.
const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-web-'));
const webDir = path.join(webRoot, 'web');
let srv: TestServer;

before(async () => {
  fs.mkdirSync(webDir);
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>portal</title>');
  // A sibling folder whose name starts with the web folder's name.
  fs.mkdirSync(path.join(webRoot, 'web-secret'));
  fs.writeFileSync(path.join(webRoot, 'web-secret', 'secret.txt'), 'top secret');
  process.env.WEB_DIR = webDir;
  srv = await bootServer();
});

after(async () => {
  await srv.close();
  fs.rmSync(webRoot, { recursive: true, force: true });
});

test('static files cannot be read from a sibling of the web folder', async () => {
  const res = await fetch(`${srv.base}/%2e%2e%2fweb-secret%2fsecret.txt`);
  const body = await res.text();
  assert.doesNotMatch(body, /top secret/);
  assert.equal(res.status, 404);
  const index = await fetch(`${srv.base}/some/page`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /<title>portal/);
});

test('malformed percent-encoding is a client error, not a server error', async () => {
  assert.equal((await fetch(`${srv.base}/%E0%A4%A`)).status, 404);
  const c = new Client(srv.base);
  assert.equal((await c.req('GET', '/api/runs/%E0%A4%A')).status, 400);
  // A broken session cookie (e.g. set by another app on the domain) must not break every request.
  c.cookie = 'portal_session=%E0%A4%A';
  const state = await c.req('GET', '/api/auth/state');
  assert.equal(state.status, 200);
  assert.equal(state.data.user, null);
  assert.equal((await c.req('GET', '/api/auth/me')).status, 401);
  assert.equal((await c.req('POST', '/api/auth/logout')).status, 200);
});
