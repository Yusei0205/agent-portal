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

  it('does nothing when there is no saved copy to download', async () => {
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-c-'));
    assert.equal(await restoreWorkspace({ putUrl: 'http://127.0.0.1:9/x' }, b, () => {}), false);
    fs.rmSync(b, { recursive: true, force: true });
  });
});
