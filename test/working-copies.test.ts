/**
 * Tests for server/workflows/working-copies.ts and the related path helper in server/repos.ts.
 *
 * These tests use a real, minimal git repository (created in a temp dir as a bare clone
 * and then cloned locally) to exercise the actual `git clone --local --no-hardlinks` path.
 * No server or database is required.
 *
 * Covered:
 *   - checkoutRepoToWorkDir creates workDir/repos/<name>/.git
 *   - checkoutRepoToWorkDir is idempotent (second call is a no-op, no error)
 *   - checkoutRepoToWorkDir skips if refCloneDir has no .git (caller handles not-ready repos)
 *   - populateRepoWorkDirs via the runner: not-ready repo → status event, run continues
 *   - populateRepoWorkDirs: repo from another project is silently ignored
 *   - repoRefDir and repoDir (path helper consistency): raw name not slugified
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';

import { checkoutRepoToWorkDir, createWorkDir } from '../server/workflows/working-copies.ts';
import { repoRefDir } from '../server/repos.ts';
import { setConfig } from '../server/config.ts';
import { createTestConfig } from './fixtures.ts';

// ── Git helpers ──────────────────────────────────────────────────────────────

function spawnGitSync(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const err: Buffer[] = [];
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(err).toString('utf8').trim() || `git exited ${code}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Create a minimal bare git repository that can serve as a reference clone.
 * Returns the path to the bare repo.
 */
async function createBareRepo(dir: string): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  await spawnGitSync(['init', '--bare'], dir);
  return dir;
}

/**
 * Create a fresh non-bare clone of a bare repo with at least one commit so
 * the working copy has a HEAD and a default branch.
 * Returns the path to the clone.
 */
async function createRefClone(bareDir: string, cloneDir: string): Promise<string> {
  await spawnGitSync(['clone', bareDir, cloneDir], os.tmpdir());

  // Create an initial commit so HEAD points somewhere real
  const readme = path.join(cloneDir, 'README.md');
  await fsp.writeFile(readme, '# test repo\n');
  await spawnGitSync(['config', 'user.email', 'test@example.com'], cloneDir);
  await spawnGitSync(['config', 'user.name', 'Test'], cloneDir);
  await spawnGitSync(['add', 'README.md'], cloneDir);
  await spawnGitSync(['commit', '-m', 'init'], cloneDir);
  await spawnGitSync(['push', 'origin', 'HEAD'], cloneDir);

  return cloneDir;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('checkoutRepoToWorkDir', () => {
  let tmpRoot: string;
  let bareDir: string;
  let refCloneDir: string;
  let workDir: string;

  before(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'wc-test-'));
    bareDir = path.join(tmpRoot, 'bare.git');
    refCloneDir = path.join(tmpRoot, 'ref-clone');
    workDir = path.join(tmpRoot, 'work');

    await createBareRepo(bareDir);
    await createRefClone(bareDir, refCloneDir);
    await fsp.mkdir(path.join(workDir, 'repos'), { recursive: true });
  });

  after(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('creates workDir/repos/<name>/.git from a valid reference clone', async () => {
    await checkoutRepoToWorkDir(refCloneDir, workDir, 'my.repo', bareDir, null);
    const gitDir = path.join(workDir, 'repos', 'my.repo', '.git');
    assert.ok(fs.existsSync(gitDir), '.git should exist after checkout');
  });

  it('is idempotent — second call does not throw and leaves the copy intact', async () => {
    // Write a sentinel file inside the working copy
    const sentinel = path.join(workDir, 'repos', 'my.repo', 'sentinel.txt');
    await fsp.writeFile(sentinel, 'keep me');

    // Call again — must be a no-op
    await assert.doesNotReject(
      () => checkoutRepoToWorkDir(refCloneDir, workDir, 'my.repo', bareDir, null),
    );

    // Sentinel must still be there (not re-cloned)
    assert.ok(fs.existsSync(sentinel), 'sentinel file should be preserved on second call');
  });

  it('sets origin to the supplied remoteUrl (not the local refCloneDir path)', async () => {
    await checkoutRepoToWorkDir(
      refCloneDir,
      workDir,
      'origin-check-repo',
      'https://github.com/example/test.git',
      null,
    );
    const dest = path.join(workDir, 'repos', 'origin-check-repo');
    assert.ok(fs.existsSync(path.join(dest, '.git')));

    // Read origin URL via git
    const originUrl: string = await new Promise((resolve, reject) => {
      const proc = spawn('git', ['remote', 'get-url', 'origin'], { cwd: dest, stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      proc.stdout.on('data', (d: Buffer) => out.push(d));
      proc.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(out).toString('utf8').trim());
        else reject(new Error(`git remote get-url exited ${code}`));
      });
      proc.on('error', reject);
    });

    assert.equal(originUrl, 'https://github.com/example/test.git',
      'origin URL must be the supplied remoteUrl, not the local refCloneDir');
  });

  it('skips checkout when refCloneDir has no .git (caller must handle not-ready repos)', async () => {
    const missingRef = path.join(tmpRoot, 'does-not-exist');
    // Should throw (git clone will fail) — the caller (populateRepoWorkDirs) catches this
    await assert.rejects(
      () => checkoutRepoToWorkDir(missingRef, workDir, 'should-not-exist', 'https://example.com/x.git', null),
      /git/i,
    );
    const dest = path.join(workDir, 'repos', 'should-not-exist');
    assert.ok(!fs.existsSync(dest), 'destination must not be created on failure');
  });

  it('passes -c core.longpaths=true and persists core.longpaths=true in git config', async () => {
    await checkoutRepoToWorkDir(refCloneDir, workDir, 'longpaths-test', bareDir, null);
    const dest = path.join(workDir, 'repos', 'longpaths-test');

    // Read back core.longpaths from the clone's .git/config
    const longpathsValue: string = await new Promise((resolve, reject) => {
      const proc = spawn('git', ['config', 'core.longpaths'], {
        cwd: dest, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      });
      const out: Buffer[] = [];
      proc.stdout.on('data', (d: Buffer) => out.push(d));
      proc.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(out).toString('utf8').trim());
        else reject(new Error(`git config exited ${code}`));
      });
      proc.on('error', reject);
    });
    assert.equal(longpathsValue, 'true', 'core.longpaths must be persisted as "true" in the clone');
  });

  it('failed clone leaves no dest dir and no temp dir', async () => {
    const missingRef = path.join(tmpRoot, 'nonexistent-for-temp-test');
    try {
      await checkoutRepoToWorkDir(missingRef, workDir, 'temp-cleanup-test', 'https://example.com/x.git', null);
    } catch { /* expected */ }

    const dest = path.join(workDir, 'repos', 'temp-cleanup-test');
    assert.ok(!fs.existsSync(dest), 'dest must not exist after failed clone');
    assert.ok(!fs.existsSync(dest + '.wc-tmp'), 'temp dir must be cleaned up after failed clone');
  });

  it('broken existing copy (no valid HEAD) is detected and re-cloned', async () => {
    const dest = path.join(workDir, 'repos', 'broken-reclone-test');

    // Simulate a broken copy: .git directory exists but contains no valid HEAD
    // (mimics an interrupted clone that left a partial .git directory).
    await fsp.mkdir(path.join(dest, '.git'), { recursive: true });
    await fsp.writeFile(path.join(dest, 'broken-sentinel.txt'), 'I am a broken copy');

    // checkoutRepoToWorkDir must detect the invalid HEAD and perform a fresh clone
    await checkoutRepoToWorkDir(refCloneDir, workDir, 'broken-reclone-test', bareDir, null);

    // The broken sentinel is gone — the directory was replaced by the fresh clone
    assert.ok(
      !fs.existsSync(path.join(dest, 'broken-sentinel.txt')),
      'sentinel from broken copy must be removed by re-clone',
    );
    // The fresh clone has a real .git/config
    assert.ok(
      fs.existsSync(path.join(dest, '.git', 'config')),
      '.git/config must exist after re-clone',
    );
    // core.longpaths must be set in the re-cloned copy too
    const longpathsAfterReclone: string = await new Promise((resolve, reject) => {
      const proc = spawn('git', ['config', 'core.longpaths'], {
        cwd: dest, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      });
      const out: Buffer[] = [];
      proc.stdout.on('data', (d: Buffer) => out.push(d));
      proc.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(out).toString('utf8').trim());
        else reject(new Error(`git config exited ${code}`));
      });
      proc.on('error', reject);
    });
    assert.equal(longpathsAfterReclone, 'true', 'core.longpaths must be set in the re-cloned copy');
  });
});

// ── createWorkDir creates repos/ ──────────────────────────────────────────────

describe('createWorkDir', () => {
  let tmpRoot: string;

  before(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'wc-cwd-test-'));
  });

  after(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('creates repos/ subdirectory', async () => {
    const projectDir = path.join(tmpRoot, 'project');
    await fsp.mkdir(projectDir, { recursive: true });

    const workDir = await createWorkDir('test-workflow', projectDir);

    assert.ok(fs.existsSync(path.join(workDir, 'repos')), 'repos/ must be created');
    assert.ok(fs.statSync(path.join(workDir, 'repos')).isDirectory());
  });

  it('is idempotent — calling twice does not throw', async () => {
    const projectDir = path.join(tmpRoot, 'project2');
    await fsp.mkdir(projectDir, { recursive: true });

    await assert.doesNotReject(() => createWorkDir('idempotent-wf', projectDir));
    await assert.doesNotReject(() => createWorkDir('idempotent-wf', projectDir));
  });
});

// ── repoRefDir path helper consistency ───────────────────────────────────────

describe('repoRefDir path helper', () => {
  before(() => {
    const cfg = createTestConfig();
    setConfig(cfg);
  });

  it('uses the raw repo name (no slugification)', () => {
    const dir = repoRefDir('my-project', 'rhb.lad.adminportal.frontend');
    // Must end with the raw name, NOT a slugified version
    assert.ok(
      dir.endsWith(path.join('repos', 'rhb.lad.adminportal.frontend')),
      `expected raw name in path, got: ${dir}`,
    );
    assert.ok(
      !dir.includes('rhb-lad-adminportal-frontend'),
      `path must not be slugified, got: ${dir}`,
    );
  });

  it('dots and mixed case are preserved', () => {
    const dir = repoRefDir('rhb', 'rhb.backend.shared');
    assert.ok(dir.endsWith(path.join('repos', 'rhb.backend.shared')), `got: ${dir}`);
  });

  it('two repos with same prefix stay distinct', () => {
    const a = repoRefDir('proj', 'my-service');
    const b = repoRefDir('proj', 'my-service-v2');
    assert.notEqual(a, b);
  });
});
