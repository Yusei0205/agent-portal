/** A restored session workspace must keep uncommitted changes and local commits (finalize runs on a fresh machine). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { restoreWorkspace, saveWorkspaceInBackground, settleSnapshot } from '../server/agent/runner-snapshot.ts';

const haveTools = ['tar', 'gzip', 'find', 'git'].every((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0);

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

describe('workspace snapshot keeps git state', { skip: !haveTools && 'tar, gzip, find and git are needed' }, () => {
  it('uncommitted changes, local commits and origin/<base> survive pack and unpack', async () => {
    let stored: Buffer | null = null;
    const server = http.createServer((req, res) => {
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => { stored = Buffer.concat(chunks); res.writeHead(200); res.end(); });
      } else if (stored) {
        res.writeHead(200, { 'content-length': stored.length });
        res.end(stored);
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/snap`;
    const snap = { putUrl: url, getUrl: url };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-fin-'));
    try {
      // A remote with one commit on main, cloned into a fake machine's repos/.
      const seed = path.join(tmp, 'seed');
      fs.mkdirSync(seed);
      git(seed, 'init', '-b', 'main');
      fs.writeFileSync(path.join(seed, 'a.txt'), 'one\n');
      fs.writeFileSync(path.join(seed, 'b.txt'), 'bee\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-m', 'init');
      const remote = path.join(tmp, 'remote.git');
      git(tmp, 'clone', '--bare', seed, remote);

      const a = path.join(tmp, 'machine-a');
      fs.mkdirSync(path.join(a, 'repos'), { recursive: true });
      const repoA = path.join(a, 'repos', 'proj');
      git(a, 'clone', remote, repoA);

      // One local (unpushed) commit, then one modification and one new file left uncommitted.
      fs.writeFileSync(path.join(repoA, 'c.txt'), 'local commit\n');
      git(repoA, 'add', '-A');
      git(repoA, 'commit', '-m', 'local work');
      fs.writeFileSync(path.join(repoA, 'a.txt'), 'edited\n');
      fs.writeFileSync(path.join(repoA, 'new.txt'), 'untracked\n');

      const statusA = git(repoA, 'status', '--porcelain');
      const aheadA = git(repoA, 'rev-list', '--count', 'origin/main..HEAD').trim();
      const headA = git(repoA, 'rev-parse', 'HEAD').trim();
      assert.equal(aheadA, '1');
      assert.notEqual(statusA.trim(), '');

      saveWorkspaceInBackground(snap, a);
      await settleSnapshot();
      assert.ok(stored && (stored as Buffer).length > 0, 'the workspace was saved');

      // A fresh machine restores it.
      const b = path.join(tmp, 'machine-b');
      fs.mkdirSync(b);
      assert.equal(await restoreWorkspace(snap, b, () => {}), true);
      const repoB = path.join(b, 'repos', 'proj');

      assert.equal(git(repoB, 'status', '--porcelain'), statusA, 'uncommitted changes are the same');
      assert.equal(git(repoB, 'rev-list', '--count', 'origin/main..HEAD').trim(), aheadA, 'local commits are the same');
      assert.equal(git(repoB, 'rev-parse', 'HEAD').trim(), headA);
      assert.equal(fs.readFileSync(path.join(repoB, 'a.txt'), 'utf8'), 'edited\n');
      assert.equal(fs.readFileSync(path.join(repoB, 'new.txt'), 'utf8'), 'untracked\n');
    } finally {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
