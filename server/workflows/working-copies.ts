/**
 * Work directory management for agent runs.
 *
 * Each run gets its own folder under DATA_DIR/projects/<slug>/work/<runId>/.
 * The project skeleton (CLAUDE.md, skills, config files) is copied in;
 * repos are symlinked (or directory-copied on Windows) under repos/.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

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

  // Create repos/ subdirectory for linked repositories
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
 * Link (or copy) a repo's reference clone into workDir/repos/<repoName>/.
 * On Windows junction/symlink creation may require elevated privileges, so we
 * fall back to a shallow copy.
 */
export async function linkRepoToWorkDir(
  repoPath: string,
  workDir: string,
  repoName: string,
): Promise<void> {
  if (!fs.existsSync(repoPath)) return;
  const dest = path.join(workDir, 'repos', repoName);
  if (fs.existsSync(dest)) return; // already linked

  // Try a symlink first (fast, space-efficient)
  try {
    await fsp.symlink(repoPath, dest, process.platform === 'win32' ? 'junction' : 'dir');
    return;
  } catch {
    // Fall through to copy
  }

  // Fallback: shallow directory copy (top-level files only, skip .git and node_modules)
  await copyDirRecursive(repoPath, dest, { shallow: true });
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
