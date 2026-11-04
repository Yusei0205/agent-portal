/**
 * Backfill session output artifacts for existing sessions.
 *
 * For every workflow that has a work_dir set, this script runs the same
 * output-file collection logic that the runner now executes automatically
 * at the end of each run.  It is idempotent: if a file has already been
 * collected with the same content hash it is skipped.
 *
 * Usage:
 *   node --import tsx scripts/backfill-session-outputs.ts [--db <path>]
 *
 * Environment:
 *   DATA_DIR  — portal data directory (default: data/)
 *               The database is opened from DATA_DIR/portal.db unless
 *               --db <path> overrides the path.
 *
 * IMPORTANT: Run this against a COPY of the database, not the live one.
 * Take a backup first:
 *   cp data/portal.db data/portal.db.bak
 *   node --import tsx scripts/backfill-session-outputs.ts --db data/portal.db.bak
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb, all, one } from '../server/db.ts';
import { setConfig } from '../server/config.ts';
import { collectOutputFiles } from '../server/output-files.ts';
import type { Row } from '../server/db.ts';

// ── CLI argument parsing ──────────────────────────────────────────────────────

function parseArgs(): { dbPath: string; dataDir: string } {
  const args = process.argv.slice(2);
  let dbPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--db' || args[i] === '-d') && args[i + 1]) {
      dbPath = args[++i];
    }
  }

  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

  const resolvedDb = dbPath
    ? path.resolve(dbPath)
    : path.join(dataDir, 'portal.db');

  return { dbPath: resolvedDb, dataDir };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { dbPath, dataDir } = parseArgs();

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    console.error('Pass --db <path> or set DATA_DIR to point at the correct data directory.');
    process.exit(1);
  }

  console.log(`Opening database: ${dbPath}`);
  console.log(`Data directory:   ${dataDir}`);
  console.log();

  // Configure the portal so path helpers resolve correctly
  setConfig({
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    port: 0,
    host: '127.0.0.1',
    dataDir,
    webDir: '',
    secretKey: 'backfill-script-not-used-for-crypto',
    cookieSecure: 'false',
    demoSpeed: 0,
    maxUploadBytes: 50 * 1024 * 1024,
    trustProxy: false,
    awsRegion: 'us-east-1',
    deployTarget: null,
  });

  openDb(dbPath);

  // Find all workflows that have a persistent work_dir
  const workflows = all<Row>(
    `SELECT w.id, w.work_dir, w.project_id, w.goal, w.title
       FROM p6_workflows w
      WHERE w.work_dir IS NOT NULL
        AND w.work_dir != ''
      ORDER BY w.created_at ASC`,
  );

  console.log(`Found ${workflows.length} workflow(s) with a persistent work directory.`);
  console.log();

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const wf of workflows) {
    const workflowId = String(wf.id);
    const workDir = String(wf.work_dir);
    const goal = String(wf.goal ?? '').slice(0, 60);

    if (!fs.existsSync(workDir)) {
      console.log(`  SKIP  ${workflowId} — work dir not on disk: ${workDir}`);
      skipped++;
      continue;
    }

    // Find the earliest run for this workflow to use as the mtime cutoff.
    // For backfill, using epoch (new Date(0)) is also correct because the
    // collection is idempotent via hash checks.
    const earliestRun = one<{ started_at: string | null }>(
      `SELECT MIN(started_at) AS started_at FROM p6_runs WHERE workflow_id = ?`,
      workflowId,
    );
    const startedAt = earliestRun?.started_at ?? new Date(0).toISOString();

    // Find any run id to use (latest is fine — only affects the run_id FK on rows)
    const latestRun = one<{ id: string }>(
      `SELECT id FROM p6_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1`,
      workflowId,
    );
    if (!latestRun) {
      console.log(`  SKIP  ${workflowId} — no runs found`);
      skipped++;
      continue;
    }

    const runId = latestRun.id;

    try {
      process.stdout.write(`  RUN   ${workflowId} "${goal}" … `);
      await collectOutputFiles(runId, workflowId, workDir, startedAt);
      const count = (one<{ c: number }>(
        'SELECT COUNT(*) AS c FROM output_files WHERE workflow_id = ? AND refused_reason IS NULL',
        workflowId,
      )?.c ?? 0);
      console.log(`done (${count} file(s) recorded)`);
      processed++;
    } catch (err: unknown) {
      console.log(`ERROR: ${String((err as Error)?.message ?? err)}`);
      errors++;
    }
  }

  closeDb();

  console.log();
  console.log('Backfill complete.');
  console.log(`  Processed: ${processed}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Errors:    ${errors}`);

  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
