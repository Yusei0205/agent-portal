/**
 * Work directory management for agent runs.
 *
 * Each workflow gets ONE persistent working directory under
 * DATA_DIR/projects/<slug>/work/<workflowId>/ so file artefacts (repos,
 * generated files, agent configs) survive across runs.
 *
 * Repo sub-directories are independent git working copies created from the
 * project's reference clones — see checkoutRepoToWorkDir.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ── Internal git helper ───────────────────────────────────────────────────────

/**
 * Run a git command, returning stdout or throwing on failure.
 * proc.unref() keeps the Node.js event loop free to exit even if git hangs.
 * shell: false prevents argument injection via repo names or branch names.
 * timeoutMs defaults to 5 minutes — long enough for an initial `git clone` of
 * a large repo but bounded so a hung subprocess does not stall the runner.
 */
function spawnGit(args: string[], cwd: string, timeoutMs = 300_000): Promise<string> {
  // The git subcommand (skipping -c key=value options), for error messages.
  const sub = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c') ?? 'command';
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    // Do NOT unref() here — callers await this directly, so the process must keep the
    // event loop alive until git exits.  (repos.ts's background-sync spawnGit is where
    // unref() belongs; that function stays in repos.ts.)
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`git ${sub} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref(): void }).unref();
    }
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8').trim());
      } else {
        reject(new Error(`git ${sub} failed: ${Buffer.concat(err).toString('utf8').trim() || `exited with ${code}`}`));
      }
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Create the work directory for a run and copy the project skeleton into it.
 * Returns the absolute path to the created directory.
 *
 * @param dirName - directory name to create under `projectDir/work/`.
 *   Pass `workflowId` for a persistent working copy that survives across runs,
 *   or `runId` for the legacy per-run layout.
 */
export async function createWorkDir(dirName: string, projectDir: string): Promise<string> {
  const workDir = path.join(projectDir, 'work', dirName);
  await fsp.mkdir(workDir, { recursive: true });

  // Copy project skeleton files the agent needs
  for (const item of ['CLAUDE.md', 'docs/decisions.md']) {
    const src = path.join(projectDir, item);
    if (fs.existsSync(src)) {
      const dest = path.join(workDir, item);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(src, dest);
    }
  }

  // Copy skills directory (read by agents)
  const skillsSrc = path.join(projectDir, '.claude', 'skills');
  if (fs.existsSync(skillsSrc)) {
    const skillsDest = path.join(workDir, '.claude', 'skills');
    await copyDirRecursive(skillsSrc, skillsDest);
  }

  // Create repos/ subdirectory for working copies
  await fsp.mkdir(path.join(workDir, 'repos'), { recursive: true });

  return workDir;
}

/**
 * Remove the work directory for a finished run.
 * Non-fatal: logs a warning if the directory cannot be removed.
 */
export async function cleanupWorkDir(workDir: string): Promise<void> {
  try {
    await fsp.rm(workDir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[working-copies] Could not clean up ${workDir}:`, e);
  }
}

/**
 * Create an independent git working copy of a project's reference clone inside
 * the session work directory.
 *
 * ## Why --local --no-hardlinks (not --shared)
 *
 * `git clone --shared` creates a lightweight copy that reads loose objects from
 * the reference clone via `objects/info/alternates`. If the reference clone is
 * deleted, repacked, or corrupted, the session copy breaks — silently. On Windows
 * the cross-clone symlink can also fail when the two paths are on different
 * volumes or accessed through different user accounts.
 *
 * `git clone --local --no-hardlinks` writes a full copy of every object file.
 * Slightly slower and uses more disk space but each session is fully independent.
 * This is the safer choice on Windows and in Docker volume mounts.
 *
 * ## Windows long-path support
 *
 * On Windows, paths inside deeply-nested repos can exceed the 260-character MAX_PATH
 * limit, causing `git clone` to fail with "unable to create file … Filename too long".
 * Passing `-c core.longpaths=true` to `git clone` enables the Win32 long-path API
 * for the clone operation itself. We also persist it in the new copy's `.git/config`
 * so subsequent git operations in the working copy (checkout, add, commit) respect it.
 *
 * ## Idempotency and broken-copy detection
 *
 * If `workDir/repos/<repoName>/.git` already exists AND `git rev-parse --verify HEAD`
 * succeeds the function returns immediately (valid copy, no work needed). If HEAD
 * cannot be verified the copy is considered broken (e.g. an interrupted previous
 * clone) — the directory is removed and a fresh clone is performed.
 *
 * ## Atomic placement
 *
 * The clone is performed into `<dest>.wc-tmp`. Only on full success is the temp
 * directory renamed to `dest`. A failure at any stage therefore never leaves a
 * partial directory at `dest`, avoiding the false-idempotency bug where a half-cloned
 * `.git` directory caused subsequent runs to skip re-cloning.
 *
 * @param refCloneDir  Absolute path to the project's reference clone.
 * @param workDir      Absolute path to the session's working directory.
 * @param repoName     Subdirectory name under `workDir/repos/` (raw repo name).
 * @param remoteUrl    The real remote URL to set as `origin` (no credentials embedded).
 * @param defaultBranch  Branch to check out; null leaves HEAD at whatever the clone gives.
 */
export async function checkoutRepoToWorkDir(
  refCloneDir: string,
  workDir: string,
  repoName: string,
  remoteUrl: string,
  defaultBranch: string | null,
): Promise<void> {
  const dest = path.join(workDir, 'repos', repoName);

  // Idempotent check: if dest/.git exists, verify HEAD is resolvable.
  // A broken copy (e.g. an interrupted clone) has .git but no valid HEAD.
  if (fs.existsSync(path.join(dest, '.git'))) {
    try {
      await spawnGit(['rev-parse', '--verify', 'HEAD'], dest, 15_000);
      return; // Valid working copy — nothing to do
    } catch {
      // Broken copy — remove it so we re-clone below
      await fsp.rm(dest, { recursive: true, force: true });
    }
  }

  await fsp.mkdir(path.join(workDir, 'repos'), { recursive: true });

  // Clone into a temp dir first so a failure never leaves a partial copy at dest.
  // On success the temp dir is atomically renamed into place.
  const tmpDest = dest + '.wc-tmp';
  // Remove any leftover temp dir from a previous failed attempt
  await fsp.rm(tmpDest, { recursive: true, force: true }).catch(() => {});

  try {
    // -c core.longpaths=true: enables Win32 long-path API for paths >260 chars.
    // Full independent copy — no alternates dependency on the reference clone.
    await spawnGit(
      ['clone', '-c', 'core.longpaths=true', '--local', '--no-hardlinks', refCloneDir, tmpDest],
      workDir,
    );

    // Persist longpaths in the copy's config so all subsequent git operations
    // (checkout, add, commit, push) also respect long paths.
    await spawnGit(['config', 'core.longpaths', 'true'], tmpDest);

    // The clone-time origin points at refCloneDir (a local path). Replace it with
    // the real remote URL so `git push` and `git fetch` reach the actual server.
    // Credentials are NOT embedded — the agent supplies them via env or .gitconfig.
    await spawnGit(['remote', 'set-url', 'origin', remoteUrl], tmpDest);

    if (defaultBranch) {
      // Best-effort checkout — the branch may be missing if the reference clone is stale
      await spawnGit(['checkout', defaultBranch], tmpDest).catch(() => { /* leave on HEAD */ });
    }

    // Atomic move: rename tmpDest → dest only after full success
    await fsp.rename(tmpDest, dest);
  } catch (e) {
    // Remove the temp dir so no partial copy is left on disk
    await fsp.rm(tmpDest, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['.git', 'node_modules', 'work']);

async function copyDirRecursive(
  src: string,
  dest: string,
  opts: { shallow?: boolean } = {},
): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      if (!opts.shallow) {
        await copyDirRecursive(srcPath, destPath, opts);
      }
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath);
    }
  }
}
