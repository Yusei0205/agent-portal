/**
 * One-off script: import the OS user's local .kiro and .claude setup into the
 * portal's per-user configuration for a specific portal user.
 *
 * Usage (run from repo root):
 *   node --disable-warning=ExperimentalWarning --import tsx scripts/import-local-config.ts [userId]
 *
 * If userId is omitted the script defaults to Yusei (5d79c616-...).
 */

import { loadConfig, setConfig } from '../server/config.ts';
import { openDb, closeDb } from '../server/db.ts';
import { importLocalConfig } from '../server/user-config.ts';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const YUSEI_ID = '5d79c616-9cc1-4c2a-9876-51a7107ec3f0';
const userId = process.argv[2] ?? YUSEI_ID;

const cfg = await loadConfig();
setConfig(cfg);
openDb(path.join(cfg.dataDir, 'portal.db'));

// ── Print helpers ─────────────────────────────────────────────────────────────

const line = '─'.repeat(60);

function printSummary(folder: 'kiro' | 'claude', summary: Awaited<ReturnType<typeof importLocalConfig>>): void {
  const totalImported = Object.values(summary.imported).flat().length;

  console.log(`\n▶  folder: ${folder}`);
  console.log(`   imported: ${totalImported} files`);

  for (const [top, files] of Object.entries(summary.imported).sort()) {
    console.log(`   ${top}/ (${files.length}):`);
    for (const f of files.sort()) {
      console.log(`     ${f}`);
    }
  }

  if (summary.valuesRedacted.length > 0) {
    console.log(`\n   redacted: ${summary.valuesRedacted.length} secret value(s)`);
    for (const k of summary.valuesRedacted) {
      console.log(`     [redacted] ${k}`);
    }
  }

  console.log(`\n   skipped: ${summary.skipped.length} files`);
  for (const { path: p, reason } of summary.skipped) {
    console.log(`     skip  ${p}  (${reason})`);
  }

  if (summary.backupPath) {
    console.log(`\n   backup: ${summary.backupPath}`);
  } else {
    console.log(`\n   backup: (none — no existing config)`);
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────

console.log(line);
console.log(`import-local-config`);
console.log(`user:     ${userId}`);
console.log(`home dir: ${os.homedir()}`);
console.log(line);

let anyError = false;

for (const folder of ['kiro', 'claude'] as const) {
  try {
    const summary = await importLocalConfig(userId, folder);
    printSummary(folder, summary);
  } catch (err) {
    console.error(`\n▶  folder: ${folder}`);
    console.error(`   ERROR: ${err instanceof Error ? err.message : String(err)}`);
    anyError = true;
  }
}

console.log(`\n${line}`);
console.log(anyError ? 'Done (with errors).' : 'Done.');

closeDb();

// Satisfy TypeScript strict import meta check
void (fileURLToPath as unknown);
