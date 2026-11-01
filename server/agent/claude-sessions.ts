/**
 * Claude Code session transcript persistence.
 *
 * Path rule (from bridge.mjs analysis, SDK 0.3.303 / CLI 2.1.303):
 *
 *   config home = CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
 *
 *   os.homedir() on Windows reads USERPROFILE from the spawned process's
 *   environment.  Because claude-code.ts sets USERPROFILE = homeDir in the
 *   sdkEnv it passes to sdk.query(), the CLI's config home is:
 *     <homeDir>/.claude
 *
 *   project dir = CLAUDE_CODE_PROJECT_DIR_NAME env var
 *     Validated as /^[A-Za-z0-9_-]{1,64}$/ (bridge.mjs, function Yq).
 *     The portal sets this to a sanitised workflowId so the directory name
 *     is the same on every run for the same workflow.
 *
 *   session transcript = <sessionId>.jsonl inside the project dir.
 *
 *   Full path: <homeDir>/.claude/projects/<dirName>/<sessionId>.jsonl
 *
 * After each run   → persistClaudeTranscripts copies .jsonl files to
 *                    <workDir>/.portal/claude-sessions/<dirName>/
 * Before next run  → restoreClaudeTranscripts copies them back.
 *
 * Only .jsonl transcript files are ever copied.  All other files
 * (credentials, settings, cookies) are explicitly excluded.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Subdirectory inside the workflow workDir where transcripts are stored. */
export const CLAUDE_SESSIONS_STORE = path.join('.portal', 'claude-sessions');

/**
 * Return the stable project directory name for a workflow.
 * Replaces any character outside [A-Za-z0-9_-] with '-' and caps at 64 chars
 * to satisfy CLAUDE_CODE_PROJECT_DIR_NAME's validation regex.
 */
export function claudeProjectDirName(workflowId: string): string {
  return workflowId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
}

/** Recursively copy only .jsonl files from src to dst. */
async function copyJsonlOnly(src: string, dst: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(src, { withFileTypes: true });
  } catch {
    return; // src doesn't exist or is unreadable
  }
  await fsp.mkdir(dst, { recursive: true });
  for (const e of entries) {
    const srcP = path.join(src, e.name);
    const dstP = path.join(dst, e.name);
    if (e.isDirectory()) {
      await copyJsonlOnly(srcP, dstP).catch(() => {});
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      // Only copy transcript files — never credentials, settings, or anything else
      try { await fsp.copyFile(srcP, dstP); } catch { /* skip unreadable */ }
    }
  }
}

/**
 * After a Claude Code run: copy .jsonl transcripts out of the temp home's
 * .claude/projects/ tree into the persistent workflow work dir so they
 * survive cleanupRunHome().  Non-fatal: errors are silently swallowed.
 */
export async function persistClaudeTranscripts(
  homeDir: string,
  workDir: string,
): Promise<void> {
  const src = path.join(homeDir, '.claude', 'projects');
  const dst = path.join(workDir, CLAUDE_SESSIONS_STORE);
  if (!fs.existsSync(src)) return;
  await copyJsonlOnly(src, dst).catch(() => {});
}

/**
 * Before a Claude Code run: restore .jsonl transcripts from the persistent
 * work dir back into the freshly materialised home's .claude/projects/ tree.
 * Non-fatal: errors are silently swallowed.
 */
export async function restoreClaudeTranscripts(
  workDir: string,
  homeDir: string,
): Promise<void> {
  const src = path.join(workDir, CLAUDE_SESSIONS_STORE);
  if (!fs.existsSync(src)) return;
  const dst = path.join(homeDir, '.claude', 'projects');
  await copyJsonlOnly(src, dst).catch(() => {});
}
