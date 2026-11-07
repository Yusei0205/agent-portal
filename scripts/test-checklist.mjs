#!/usr/bin/env node
/**
 * scripts/test-checklist.mjs
 *
 * Regenerates test/TEST_CHECKLIST.md from test/test-map.json and the current
 * .test-pass-record.json. Shows each module's source files, test files, smoke
 * IDs, last-passed commit/date, and current status.
 *
 * npm hook: npm run test:checklist
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');
const MAP_PATH   = path.join(ROOT, 'test', 'test-map.json');
const KF_PATH    = path.join(ROOT, 'test', 'known-failures.json');
const RECORD_PATH = process.env.TEST_RECORD_FILE
  ? path.resolve(process.env.TEST_RECORD_FILE)
  : path.join(ROOT, '.test-pass-record.json');
const OUT_PATH   = path.join(ROOT, 'test', 'TEST_CHECKLIST.md');

// ── Load data ─────────────────────────────────────────────────────────────────

let map;
try {
  map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
} catch (err) {
  console.error(`Cannot read ${MAP_PATH}: ${err.message}`);
  process.exit(1);
}

let record = {};
try {
  record = JSON.parse(fs.readFileSync(RECORD_PATH, 'utf8'));
} catch {
  // No record yet — all modules are "never run"
}

let knownFailures = [];
try {
  const kfRaw = JSON.parse(fs.readFileSync(KF_PATH, 'utf8'));
  knownFailures = Array.isArray(kfRaw.entries) ? kfRaw.entries : [];
} catch {
  // Missing is OK — feature gracefully absent
}

// ── Status helpers ────────────────────────────────────────────────────────────

/**
 * Build a human-readable status from the per-part record entry.
 * New format: { backend: { hash, result, at, commit }, ui: { ... } }
 * Old flat format: { hash, result, timestamp, commit } — shown as stale/discarded.
 */
function getStatus(id) {
  const entry = record[id];
  if (!entry) return { symbol: '❌', label: 'never run', date: '—', commit: '—' };

  // Old flat format (pre-per-part tracking) — was discarded on load, but may
  // still appear if checklist is run against an old record.
  if (!('backend' in entry) && !('ui' in entry)) {
    return { symbol: '❌', label: 'old format (re-run to refresh)', date: '—', commit: '—' };
  }

  const parts  = [];
  let latestAt = '';
  let latestCommit = '—';

  if (entry.backend) {
    const b = entry.backend;
    const sym = b.result === 'pass' ? '✅' : b.result === 'known-failure' ? '⚑' : '⚠️';
    parts.push(`${sym} backend`);
    if (b.at && b.at > latestAt) { latestAt = b.at; latestCommit = b.commit ?? '—'; }
  }
  if (entry.ui) {
    const u = entry.ui;
    const sym = u.result === 'pass' ? '✅' : u.result === 'known-failure' ? '⚑' : '⚠️';
    parts.push(`${sym} ui`);
    if (u.at && u.at > latestAt) { latestAt = u.at; latestCommit = u.commit ?? '—'; }
  }

  if (parts.length === 0) return { symbol: '❌', label: 'never run', date: '—', commit: '—' };

  const anyFailed  = (entry.backend?.result === 'fail') || (entry.ui?.result === 'fail');
  const anyKnown   = (entry.backend?.result === 'known-failure') || (entry.ui?.result === 'known-failure');
  const symbol     = anyFailed ? '⚠️' : anyKnown ? '⚑' : '✅';
  const dateStr    = latestAt ? new Date(latestAt).toISOString().slice(0, 10) : '—';
  return { symbol, label: parts.join(', '), date: dateStr, commit: latestCommit };
}

// ── Section groups ────────────────────────────────────────────────────────────

// Group modules into logical sections matching the original checklist structure
const GROUPS = [
  {
    title: '1 — Authentication & Users',
    ids: ['auth', 'setup', 'api-tokens', 'permissions', 'audit', 'delegation'],
  },
  {
    title: '2 — Projects & Workspaces',
    ids: ['projects', 'workspaces'],
  },
  {
    title: '3 — Sessions, Workflows & IDE',
    ids: ['sessions', 'workflows', 'ide'],
  },
  {
    title: '4 — Dashboard',
    ids: ['dashboard'],
  },
  {
    title: '5 — Knowledge',
    ids: ['knowledge'],
  },
  {
    title: '6 — Create (Diagrams / Documents / Decks)',
    ids: ['create', 'diagrams', 'generated-docs', 'presentations'],
  },
  {
    title: '7 — Vault',
    ids: ['vault'],
  },
  {
    title: '8 — Insights',
    ids: ['insights'],
  },
  {
    title: '9 — Inbox',
    ids: ['inbox'],
  },
  {
    title: '10 — Connections & Repositories',
    ids: ['connections', 'repos'],
  },
  {
    title: '11 — Integrations',
    ids: ['integrations'],
  },
  {
    title: '12 — AWS Accounts & Credentials',
    ids: ['aws-accounts', 'credentials', 'bedrock-sso'],
  },
  {
    title: '13 — Settings & Configuration',
    ids: ['settings', 'config', 'user-config'],
  },
  {
    title: '14 — Code Reviews',
    ids: ['reviews'],
  },
  {
    title: '15 — Branch Scans',
    ids: ['branch-scans'],
  },
  {
    title: '16 — Testing Module',
    ids: ['testing-module'],
  },
  {
    title: '17 — API Access',
    ids: ['api-access'],
  },
  {
    title: '18 — Loop Specs',
    ids: ['loop-specs'],
  },
  {
    title: '19 — Engines & Models',
    ids: ['engines'],
  },
  {
    title: '20 — Kiro Integration',
    ids: ['kiro'],
  },
  {
    title: '21 — App Shell & Theme',
    ids: ['shell', 'theme'],
  },
  {
    title: '22 — Attachments',
    ids: ['attachments'],
  },
  {
    title: '23 — Backend-only modules',
    ids: ['security', 'storage', 'db', 'health', 'guardrails', 'output-files'],
  },
];

// ── Render table row ──────────────────────────────────────────────────────────

function renderRow(id) {
  const mod    = map.modules[id];
  const status = getStatus(id);

  if (!mod) return `| ${id} | (not in map) | — | — | ❌ | — |`;

  const sources = (mod.sources ?? []).join('<br>') || '—';
  const tests   = (mod.tests ?? []).join('<br>') || '—';
  const smoke   = (mod.smokeIds ?? []).join(', ') || '—';
  const note    = status.commit !== '—' ? `${status.commit} · ${status.date}` : status.date;

  return `| ${id} | ${mod.description ?? ''} | ${sources} | ${tests} | ${smoke} | ${status.symbol} ${status.label} | ${note} |`;
}

// ── Build markdown ────────────────────────────────────────────────────────────

const now = new Date().toISOString().slice(0, 10);

const lines = [
  '# Agent Portal — Test Checklist',
  '',
  `> **Auto-generated** by \`npm run test:checklist\` on ${now}.`,
  '> Do not edit by hand — changes will be overwritten.',
  '> Source of truth: \`test/test-map.json\` + \`.test-pass-record.json\`.',
  '',
  '## How to use',
  '',
  '1. Find every module whose files you changed.',
  '2. Run: `npm run test:affected -- --dry-run` to preview what will run.',
  '3. Run: `npm run test:affected` to run only affected modules and record passes.',
  '4. To force a full run: `npm run test:affected -- --all`',
  '5. To run one module: `npm run test:affected -- --module <id>`',
  '6. To run backend only: `npm run test:affected -- --backend-only`',
  '7. To run UI smoke only: `npm run test:affected -- --ui-only`',
  '8. Regenerate this file: `npm run test:checklist`',
  '',
  '## Status key',
  '',
  '| Symbol | Meaning |',
  '|--------|---------|',
  '| ✅ | Passed (hash recorded) |',
  '| ⚑ | Known failure (skipped until files change) |',
  '| ⚠️ | Last run failed |',
  '| ❌ | Never run / not yet tested |',
  '',
  '## Direct test commands',
  '',
  '```sh',
  '# Run all backend tests',
  'npm test',
  '',
  '# Run backend tests for a single file',
  'npm run test:file -- test/dashboard.test.ts',
  '',
  '# Run affected modules (recommended)',
  'npm run test:affected',
  '',
  '# Dry-run: see what would run without running it',
  'npm run test:affected -- --dry-run',
  '',
  '# Full smoke suite (build first)',
  'npm run test:ui',
  '',
  '# Fast smoke suite (skip build)',
  'npm run test:ui:fast',
  '',
  '# Validate the module map',
  'npm run test:map:check',
  '```',
  '',
];

// Collect all module IDs mentioned in groups to detect any that are missing
const mentionedIds = new Set(GROUPS.flatMap(g => g.ids));
const allIds = Object.keys(map.modules);
const ungrouped = allIds.filter(id => !mentionedIds.has(id));

for (const group of GROUPS) {
  lines.push(`## ${group.title}`);
  lines.push('');
  lines.push('| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |');
  lines.push('|-----------|-------------|-------------|-----------|-----------|--------|-----------|');
  for (const id of group.ids) {
    lines.push(renderRow(id));
  }
  lines.push('');
}

if (ungrouped.length > 0) {
  lines.push('## Other modules (not yet grouped)');
  lines.push('');
  lines.push('| Module ID | Description | Source files | Test files | Smoke IDs | Status | Last pass |');
  lines.push('|-----------|-------------|-------------|-----------|-----------|--------|-----------|');
  for (const id of ungrouped) {
    lines.push(renderRow(id));
  }
  lines.push('');
}

// ── Known failures summary ────────────────────────────────────────────────────

if (knownFailures.length > 0) {
  lines.push('## Known failures');
  lines.push('');
  lines.push('These test failures are listed as known issues. They are skipped until the');
  lines.push('relevant source files change. Add entries to `test/known-failures.json`');
  lines.push('deliberately — each entry must name the exact failing test, include a reason,');
  lines.push('and be removed once the underlying issue is fixed.');
  lines.push('');
  lines.push('| Module | Part | File | Test name | Reason | Added |');
  lines.push('|--------|------|------|-----------|--------|-------|');
  for (const e of knownFailures) {
    const file      = e.file      ?? '—';
    const sectionId = e.sectionId ? `§${e.sectionId}` : '—';
    const fileOrSec = e.part === 'backend' ? file : sectionId;
    const testName  = e.testName  ?? '—';
    const reason    = e.reason    ?? '—';
    const addedAt   = e.addedAt   ?? '—';
    lines.push(`| ${e.module} | ${e.part} | ${fileOrSec} | ${testName} | ${reason} | ${addedAt} |`);
  }
  lines.push('');
}

// ── Shared blast-radius summary ───────────────────────────────────────────────

lines.push('## Shared file blast-radius decisions');
lines.push('');
lines.push('These files affect multiple modules when changed.');
lines.push('');
lines.push('| Sources | Affects | Rationale |');
lines.push('|---------|---------|-----------|');

for (const entry of (map.shared ?? [])) {
  const srcs    = (entry.sources ?? []).join(', ');
  const affects = entry.affects === '*' ? '**all modules**' : (Array.isArray(entry.affects) ? entry.affects.join(', ') : String(entry.affects));
  const reason  = entry.rationale ?? entry.description ?? '—';
  lines.push(`| ${srcs} | ${affects} | ${reason} |`);
}
lines.push('');

// ── Backend-only additions note ───────────────────────────────────────────────

lines.push('## Backend-only modules (added beyond UI contract)');
lines.push('');
lines.push('These modules have no smoke section but have backend tests:');
lines.push('`security`, `storage`, `db`, `health`, `guardrails`, `output-files`, `user-config`');
lines.push('');

// ── Write output ──────────────────────────────────────────────────────────────

fs.writeFileSync(OUT_PATH, lines.join('\n') + '\n');
console.log(`\n✓ Wrote ${OUT_PATH}\n`);
