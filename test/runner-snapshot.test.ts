/** Saving a session's workspace to S3 (presigned URLs) and restoring it on a fresh machine. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseSnapshot, restoreWorkspace, saveWorkspaceInBackground, settleSnapshot, cancelSnapshot, snapshotBusy,
  flushWorkspace, flushWorkspaceStrict, moveSnapshotMarks,
} from '../server/agent/runner-snapshot.ts';

const haveTools = ['tar', 'gzip', 'find'].every((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0);

describe('parseSnapshot', () => {
  const s3 = 'https://bucket.s3.ap-southeast-1.amazonaws.com/data/workspace-snapshots/x.tar.gz?X-Amz-Signature=abc';
  it('accepts two S3 URLs, or just the upload one', () => {
    assert.deepEqual(parseSnapshot({ putUrl: s3, getUrl: s3 }), { putUrl: s3, getUrl: s3 });
    assert.deepEqual(parseSnapshot({ putUrl: s3 }), { putUrl: s3 });
  });
  it('ignores anything that is not an https amazonaws.com URL', () => {
    assert.equal(parseSnapshot(null), null);
    assert.equal(parseSnapshot({}), null);
    assert.equal(parseSnapshot({ putUrl: 'http://bucket.s3.amazonaws.com/x' }), null);
    assert.equal(parseSnapshot({ putUrl: 'https://evil.example.com/x' }), null);
    assert.equal(parseSnapshot({ putUrl: 'https://amazonaws.com.evil.example/x' }), null);
    assert.equal(parseSnapshot({ putUrl: s3, getUrl: 'https://evil.example.com/x' }), null);
  });
});

describe('workspace snapshots', { skip: !haveTools && 'tar, gzip and find are needed' }, () => {
  it('serializes terminal and agent saves so their archives cannot overwrite one another', async () => {
    const roots = ['a', 'b'].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-save-race-')));
    for (let i = 0; i < roots.length; i++) {
      fs.mkdirSync(path.join(roots[i], 'repos', 'fixture'), { recursive: true });
      fs.writeFileSync(path.join(roots[i], 'repos', 'fixture', 'value.txt'), String(i));
    }
    let active = 0, maximum = 0;
    const stored = new Map<string, Buffer>();
    const server = http.createServer((req, res) => {
      active++; maximum = Math.max(maximum, active);
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => { stored.set(req.url!, Buffer.concat(chunks)); setTimeout(() => { active--; res.writeHead(200); res.end(); }, 50); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      await Promise.all(roots.map((root, i) => flushWorkspaceStrict({ putUrl: `${base}/${i}` }, root)));
      assert.equal(maximum, 1);
      for (let i = 0; i < roots.length; i++) {
        const archive = path.join(roots[i], 'saved.tar.gz'); fs.writeFileSync(archive, stored.get(`/${i}`)!);
        const result = spawnSync('tar', ['--force-local', '-xOf', archive, 'repos/fixture/value.txt'], { encoding: 'utf8' });
        assert.equal(result.status, 0); assert.equal(result.stdout, String(i));
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const root of roots) if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('terminal-save-race-')) fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('rejects a failed upload when durable completion is required', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-strict-snapshot-'));
    fs.mkdirSync(path.join(root, 'repos', 'example'), { recursive: true });
    fs.writeFileSync(path.join(root, 'repos', 'example', 'changed.txt'), 'unsaved');
    const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(503); res.end(); }); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const putUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/snapshot`;
    try {
      await assert.rejects(flushWorkspaceStrict({ putUrl }, root), /persist the session workspace/);
      assert.equal(fs.existsSync(path.join(root, '.snapshot-stamp')), false);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('codex-strict-snapshot-')) fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('saves a changed workspace, skips an unchanged one, and restores it on an empty machine', async () => {
    let stored: Buffer | null = null;
    let puts = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => { stored = Buffer.concat(chunks); puts++; res.writeHead(200); res.end(); });
      } else if (stored) {
        res.writeHead(200, { 'content-length': stored.length });
        res.end(stored);
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/snap`;
    const snap = { putUrl: url, getUrl: url };
    try {
      const a = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-a-'));
      fs.mkdirSync(path.join(a, 'repos', 'proj', 'node_modules', 'dep'), { recursive: true });
      fs.writeFileSync(path.join(a, 'repos', 'proj', 'src.txt'), 'hello');
      fs.writeFileSync(path.join(a, 'repos', 'proj', 'node_modules', 'dep', 'index.js'), 'installed');

      saveWorkspaceInBackground(snap, a);
      await settleSnapshot();
      assert.equal(puts, 1, 'the first save uploads');
      assert.ok(stored && (stored as Buffer).length > 0);

      saveWorkspaceInBackground(snap, a);
      await settleSnapshot();
      assert.equal(puts, 1, 'nothing changed, so nothing is uploaded');

      await new Promise((r) => setTimeout(r, 50));
      fs.writeFileSync(path.join(a, 'repos', 'proj', 'src.txt'), 'edited');
      saveWorkspaceInBackground(snap, a);
      await settleSnapshot();
      assert.equal(puts, 2, 'an edit is saved');

      // A new machine: empty folder, restores everything, including what was installed.
      const b = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-b-'));
      const msgs: string[] = [];
      assert.equal(await restoreWorkspace(snap, b, (e) => msgs.push(e.text)), true);
      assert.equal(fs.readFileSync(path.join(b, 'repos', 'proj', 'src.txt'), 'utf8'), 'edited');
      assert.equal(fs.readFileSync(path.join(b, 'repos', 'proj', 'node_modules', 'dep', 'index.js'), 'utf8'), 'installed');

      // A machine that already has the repositories is left alone.
      assert.equal(await restoreWorkspace(snap, b, () => {}), false);
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    } finally {
      server.close();
    }
  });

  it('a new message cancels a save that is still uploading', async () => {
    let received = 0;
    const server = http.createServer((req, res) => {
      req.on('data', () => { /* never finishes: the response is held back */ });
      req.on('end', () => { received++; });
      void res;
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const snap = { putUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/snap` };
    try {
      const a = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-d-'));
      fs.mkdirSync(path.join(a, 'repos', 'p'), { recursive: true });
      fs.writeFileSync(path.join(a, 'repos', 'p', 'f.txt'), 'x');
      saveWorkspaceInBackground(snap, a);
      assert.equal(snapshotBusy(), true);
      await new Promise((r) => setTimeout(r, 800)); // packed, now waiting on the upload
      const t0 = Date.now();
      await cancelSnapshot();
      assert.ok(Date.now() - t0 < 5000, 'returns quickly');
      assert.equal(snapshotBusy(), false);
      assert.equal(fs.existsSync(path.join(a, '.snapshot-stamp')), false, 'not marked as saved');
      fs.rmSync(a, { recursive: true, force: true });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  // One saved copy per session, written by whichever engine ran last (Kiro and Claude Code have separate machines).
  describe('switching engines', () => {
    /** A stand-in for S3: keeps the last upload, answers with its ETag, and serves one-byte ranges. */
    async function fakeS3() {
      let stored: Buffer | null = null;
      let version = 0;
      const server = http.createServer((req, res) => {
        if (req.method === 'PUT') {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => { stored = Buffer.concat(chunks); version++; res.writeHead(200, { etag: `"v${version}"` }); res.end(); });
          return;
        }
        if (!stored) { res.writeHead(404); res.end(); return; }
        const body = stored as Buffer;
        if (req.headers.range === 'bytes=0-0') { res.writeHead(206, { etag: `"v${version}"`, 'content-length': 1 }); res.end(body.subarray(0, 1)); return; }
        res.writeHead(200, { etag: `"v${version}"`, 'content-length': body.length });
        res.end(body);
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/snap`;
      return { server, snap: { putUrl: url, getUrl: url } };
    }
    const mk = (prefix: string, text: string): string => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      fs.mkdirSync(path.join(d, 'repos', 'proj'), { recursive: true });
      fs.writeFileSync(path.join(d, 'repos', 'proj', 'src.txt'), text);
      return d;
    };
    const read = (d: string) => fs.readFileSync(path.join(d, 'repos', 'proj', 'src.txt'), 'utf8');

    it("brings the other engine's newer copy onto a machine that changed nothing since", async () => {
      const { server, snap } = await fakeS3();
      try {
        const claude = mk('ws-claude-', 'v1 by claude');
        await flushWorkspace(snap, claude);                      // Claude saved v1
        const kiro = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-kiro-'));
        assert.equal(await restoreWorkspace(snap, kiro, () => {}), true);
        await new Promise((r) => setTimeout(r, 50));
        fs.writeFileSync(path.join(kiro, 'repos', 'proj', 'src.txt'), 'v2 by kiro, not committed');
        await flushWorkspace(snap, kiro);                        // switch back: Kiro's machine saves v2 first

        const msgs: string[] = [];
        assert.equal(await restoreWorkspace(snap, claude, (e) => msgs.push(e.text)), true, 'out-of-date copy is replaced');
        assert.equal(read(claude), 'v2 by kiro, not committed');
        assert.ok(msgs.some((m) => /other engine/.test(m)), msgs.join(' | '));
        assert.equal(fs.existsSync(path.join(claude, 'repos.previous')), false, 'the old copy is removed');

        assert.equal(await restoreWorkspace(snap, claude, () => {}), false, 'up to date: nothing to do');
        for (const d of [claude, kiro]) fs.rmSync(d, { recursive: true, force: true });
      } finally { server.close(); }
    });

    it('never throws away changes the machine has not saved', async () => {
      const { server, snap } = await fakeS3();
      try {
        const a = mk('ws-a2-', 'one');
        await flushWorkspace(snap, a);
        const b = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-b2-'));
        await restoreWorkspace(snap, b, () => {});
        await new Promise((r) => setTimeout(r, 50));
        fs.writeFileSync(path.join(b, 'repos', 'proj', 'src.txt'), 'two');
        await flushWorkspace(snap, b);
        await new Promise((r) => setTimeout(r, 50));
        fs.writeFileSync(path.join(a, 'repos', 'proj', 'src.txt'), 'local edit not saved');

        const msgs: string[] = [];
        assert.equal(await restoreWorkspace(snap, a, (e) => msgs.push(e.text)), false);
        assert.equal(read(a), 'local edit not saved');
        assert.ok(msgs.some((m) => /changes of its own/.test(m)));
        for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true });
      } finally { server.close(); }
    });

    it('leaves a machine alone that never recorded which copy it holds (an older runner)', async () => {
      const { server, snap } = await fakeS3();
      try {
        const a = mk('ws-a3-', 'saved');
        await flushWorkspace(snap, a);
        const old = mk('ws-old-', 'older runner');
        assert.equal(await restoreWorkspace(snap, old, () => {}), false);
        assert.equal(read(old), 'older runner');
        for (const d of [a, old]) fs.rmSync(d, { recursive: true, force: true });
      } finally { server.close(); }
    });

    it('flushWorkspace waits for the upload', async () => {
      const { server, snap } = await fakeS3();
      try {
        const a = mk('ws-a4-', 'x');
        await flushWorkspace(snap, a);
        assert.equal(snapshotBusy(), false);
        assert.equal(fs.readFileSync(path.join(a, '.snapshot-etag'), 'utf8'), '"v1"');
        fs.rmSync(a, { recursive: true, force: true });
      } finally { server.close(); }
    });

    it('moveSnapshotMarks carries the marks along with repos/', () => {
      const from = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-m1-'));
      const to = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-m2-'));
      fs.writeFileSync(path.join(from, '.snapshot-stamp'), '1');
      fs.writeFileSync(path.join(from, '.snapshot-etag'), '"v3"');
      moveSnapshotMarks(from, to);
      assert.equal(fs.readFileSync(path.join(to, '.snapshot-etag'), 'utf8'), '"v3"');
      assert.equal(fs.existsSync(path.join(from, '.snapshot-stamp')), false);
      for (const d of [from, to]) fs.rmSync(d, { recursive: true, force: true });
    });
  });

  it("the agents' shared notes in repos/.agent-notes are saved with the workspace and come back on the next machine", async () => {
    let stored: Buffer | null = null;
    let puts = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => { stored = Buffer.concat(chunks); puts++; res.writeHead(200); res.end(); });
      } else if (stored) {
        res.writeHead(200, { 'content-length': stored.length });
        res.end(stored);
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/notes`;
    const snap = { putUrl: url, getUrl: url };
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-n1-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-n2-'));
    try {
      fs.mkdirSync(path.join(a, 'repos', 'app'), { recursive: true });
      fs.writeFileSync(path.join(a, 'repos', 'app', 'main.ts'), 'code');
      saveWorkspaceInBackground(snap, a);
      await settleSnapshot();
      assert.equal(puts, 1);

      // A run that only updates the notes (no code change) is still saved.
      await new Promise((r) => setTimeout(r, 50));
      fs.mkdirSync(path.join(a, 'repos', '.agent-notes'), { recursive: true });
      fs.writeFileSync(path.join(a, 'repos', '.agent-notes', 'lead-orchestrator.md'), '# lead-orchestrator: plan');
      saveWorkspaceInBackground(snap, a);
      await settleSnapshot();
      assert.equal(puts, 2, 'a change to the notes alone is saved');

      assert.equal(await restoreWorkspace(snap, b, () => {}), true);
      assert.equal(fs.readFileSync(path.join(b, 'repos', '.agent-notes', 'lead-orchestrator.md'), 'utf8'), '# lead-orchestrator: plan');
    } finally {
      server.close();
      for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('does nothing when there is no saved copy to download', async () => {
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-c-'));
    assert.equal(await restoreWorkspace({ putUrl: 'http://127.0.0.1:9/x' }, b, () => {}), false);
    fs.rmSync(b, { recursive: true, force: true });
  });
});
