/**
 * Malformed requests are client errors, and file routes stay inside their folder.
 *
 * Covers:
 *   - A request target that is not a valid URL ("//[") gets 400, also as a WebSocket upgrade,
 *     and the server keeps serving afterwards
 *   - Route parameters and session cookies that are not valid percent-encoding
 *   - Static files: a sibling folder whose name starts with the web folder's name
 *   - realPathInside: "..", sibling prefixes and symlinks that point outside
 *   - Run file preview: sibling work dirs, symlinked folders, directories, large files
 */

process.env.PORTAL_DISABLE_GIT_SYNC = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { createTestConfig, fetchJson } from './fixtures.ts';
import { setConfig } from '../server/config.ts';
import { openDb, closeDb, isDbOpen, insert } from '../server/db.ts';
import { startServer } from '../server/index.ts';
import { parseCookies, parseRequestUrl, safeDecode } from '../server/http.ts';
import { generateId, now, realPathInside } from '../server/util.ts';

/** Sends raw bytes and returns the status line of the answer ('' when the connection closes without one). */
function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); resolve(data.split('\r\n')[0]); }, 5_000);
    socket.on('data', (d) => {
      data += String(d);
      if (data.includes('\r\n')) { clearTimeout(timer); socket.destroy(); resolve(data.split('\r\n')[0]); }
    });
    socket.on('close', () => { clearTimeout(timer); resolve(data.split('\r\n')[0]); });
    socket.on('error', reject);
  });
}

/** A directory link that works on every OS: on Windows a junction needs no extra rights. */
function linkDir(target: string, link: string): void {
  fs.symlinkSync(target, link, 'junction');
}

describe('request parsing helpers', () => {
  it('safeDecode returns null for malformed percent-encoding', () => {
    assert.equal(safeDecode('a%20b'), 'a b');
    assert.equal(safeDecode('%E0%A4%A'), null);
  });

  it('parseCookies keeps a malformed value as sent instead of throwing', () => {
    assert.deepEqual(parseCookies('a=%E0%A4%A; b=x%20y'), { a: '%E0%A4%A', b: 'x y' });
  });

  it('parseRequestUrl returns null for a target that is not a URL', () => {
    assert.equal(parseRequestUrl('//['), null);
    assert.equal(parseRequestUrl('/api/health?x=1')?.pathname, '/api/health');
    assert.equal(parseRequestUrl(undefined)?.pathname, '/');
  });
});

describe('realPathInside', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-realpath-'));
  const root = path.join(tmp, 'work');
  const outside = path.join(tmp, 'outside');

  before(() => {
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'a');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
    fs.mkdirSync(path.join(tmp, 'work-secret'));
    fs.writeFileSync(path.join(tmp, 'work-secret', 'b.txt'), 'b');
    linkDir(outside, path.join(root, 'linked'));
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns the real path of a file inside the root', () => {
    assert.equal(realPathInside(root, 'sub/a.txt'), fs.realpathSync(path.join(root, 'sub', 'a.txt')));
  });

  it('returns null when nothing exists at the path', () => {
    assert.equal(realPathInside(root, 'sub/missing.txt'), null);
  });

  it('refuses "..", a sibling folder with the same prefix, and absolute paths', () => {
    assert.throws(() => realPathInside(root, '../outside/secret.txt'), /escapes root/);
    assert.throws(() => realPathInside(root, '../work-secret/b.txt'), /escapes root/);
    assert.throws(() => realPathInside(root, path.join(outside, 'secret.txt')), /escapes root/);
  });

  it('refuses a path through a linked folder that points outside the root', () => {
    assert.throws(() => realPathInside(root, 'linked/secret.txt'), /escapes root/);
  });

  it('allows a link whose target stays inside the root', () => {
    linkDir(path.join(root, 'sub'), path.join(root, 'inner'));
    assert.equal(realPathInside(root, 'inner/a.txt'), fs.realpathSync(path.join(root, 'sub', 'a.txt')));
  });
});

describe('malformed requests and file routes on a running server', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-hardening-'));
  const webDir = path.join(tmp, 'web');
  let server: http.Server;
  let baseUrl = '';
  let port = 0;
  let dataDir = '';

  before(async () => {
    fs.mkdirSync(webDir);
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>portal</title>');
    // A sibling folder whose name starts with the web folder's name.
    fs.mkdirSync(path.join(tmp, 'web-secret'));
    fs.writeFileSync(path.join(tmp, 'web-secret', 'secret.txt'), 'top secret');

    if (isDbOpen()) closeDb();
    const cfg = createTestConfig({ webDir });
    dataDir = cfg.dataDir;
    setConfig(cfg);
    openDb(':memory:');
    server = await startServer({ port: 0, host: '127.0.0.1', config: cfg });
    port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    if (isDbOpen()) closeDb();
    // Best effort, like fixtures.ts: on Windows the demo session can still hold a file open.
    for (const dir of [tmp, dataDir]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* left for the OS to clean */ }
    }
  });

  it('a request target that is not a URL gets 400, and the server keeps serving', async () => {
    assert.match(await rawRequest(port, 'GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 400/);
    assert.equal((await fetchJson(baseUrl, '/api/health')).status, 200);
  });

  it('a WebSocket upgrade with such a target is refused, and the server keeps serving', async () => {
    const upgrade =
      'GET //[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
      'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n';
    assert.match(await rawRequest(port, upgrade), /^HTTP\/1\.1 400/);
    assert.equal((await fetchJson(baseUrl, '/api/health')).status, 200);
  });

  it('a route parameter that is not valid percent-encoding is a 400', async () => {
    const r = await fetchJson(baseUrl, '/api/runs/%E0%A4%A');
    assert.equal(r.status, 400);
  });

  it('a broken session cookie (e.g. set by another app on the domain) does not break requests', async () => {
    for (const cookie of ['portal_session=%E0%A4%A', 'portal_session=%25E0']) {
      const state = await fetchJson(baseUrl, '/api/auth/state', { cookie });
      assert.equal(state.status, 200, `auth state with ${cookie}`);
      assert.equal((state.body as { loggedIn: boolean }).loggedIn, false);
      assert.equal((await fetchJson(baseUrl, '/api/auth/logout', { method: 'POST', cookie })).status, 200);
    }
  });

  it('static files cannot be read from a sibling of the web folder', async () => {
    const res = await fetch(`${baseUrl}/%2e%2e%2fweb-secret%2fsecret.txt`);
    const body = await res.text();
    assert.doesNotMatch(body, /top secret/);
    assert.equal(res.status, 404);
    const page = await fetch(`${baseUrl}/some/page`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>portal/);
    assert.equal((await fetch(`${baseUrl}/%E0%A4%A`)).status, 404);
  });

  describe('run file preview', () => {
    let cookie = '';
    let runId = '';

    before(async () => {
      await fetchJson(baseUrl, '/api/auth/setup', {
        method: 'POST',
        body: { email: 'harden-admin@example.com', name: 'Admin', password: 'password1234', provider: 'demo' },
      });
      const login = await fetchJson(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: { email: 'harden-admin@example.com', password: 'password1234' },
      });
      cookie = login.cookie ?? '';
      const proj = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Hardening Test' }, cookie });
      const project = (proj.body as { project: { id: string; slug: string } }).project;
      const wf = await fetchJson(baseUrl, `/api/projects/${project.id}/workflows`, {
        method: 'POST',
        body: { goal: 'preview test', engine: 'demo' },
        cookie,
      });
      const workflowId = (wf.body as { workflow: { id: string } }).workflow.id;

      runId = generateId();
      insert('p6_runs', { id: runId, workflow_id: workflowId, status: 'done', cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: now() });

      const workRoot = path.join(dataDir, 'projects', project.slug, 'work');
      const workDir = path.join(workRoot, runId);
      fs.mkdirSync(path.join(workDir, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(workDir, 'notes.md'), '# Notes');
      fs.writeFileSync(path.join(workDir, 'big.txt'), Buffer.alloc(4 * 1024 * 1024 + 1, 'x'));
      // A sibling work dir whose name starts with this run's id, and a folder outside it.
      fs.mkdirSync(path.join(workRoot, `${runId}-other`));
      fs.writeFileSync(path.join(workRoot, `${runId}-other`, 'secret.md'), 'top secret');
      const outside = path.join(dataDir, 'outside');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'secret.md'), 'top secret');
      linkDir(outside, path.join(workDir, 'linked'));
    });

    const preview = (p: string) => fetchJson(baseUrl, `/api/runs/${runId}/file/preview?path=${encodeURIComponent(p)}`, { cookie });

    it('shows a text file inside the work dir', async () => {
      const r = await preview('notes.md');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { type: 'text', content: '# Notes', ext: '.md' });
    });

    it('refuses a sibling work dir whose name starts with the run id', async () => {
      const r = await preview(`../${runId}-other/secret.md`);
      assert.equal(r.status, 403);
      assert.doesNotMatch(JSON.stringify(r.body), /top secret/);
    });

    it('refuses a file reached through a linked folder that points outside', async () => {
      const r = await preview('linked/secret.md');
      assert.equal(r.status, 403);
      assert.doesNotMatch(JSON.stringify(r.body), /top secret/);
    });

    it('answers 404 for a folder or a missing file', async () => {
      assert.equal((await preview('sub')).status, 404);
      assert.equal((await preview('missing.md')).status, 404);
    });

    it('does not send back a file over the preview limit', async () => {
      const r = await preview('big.txt');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { type: 'binary', ext: '.txt', size: 4 * 1024 * 1024 + 1, tooLarge: true });
    });
  });
});
