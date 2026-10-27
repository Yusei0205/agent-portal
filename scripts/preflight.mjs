/**
 * Pre-flight check for the Agent Portal.
 *
 * Checks every dependency the portal needs and prints one line per item:
 *   ok        <item>   — found / writable
 *   missing   <item>   — not found (REQUIRED items cause a non-zero exit)
 *   warn      <item>   — not found but optional
 *
 * Exit codes:
 *   0 — all REQUIRED items are present
 *   1 — one or more REQUIRED items are missing
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// ── ANSI colours ──────────────────────────────────────────────────────────────

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';

function ok(label) {
  console.log(`${GREEN}ok      ${RESET}  ${label}`);
}
function missing(label, hint = '') {
  console.log(`${RED}missing ${RESET}  ${label}${hint ? '  # ' + hint : ''}`);
}
function warn(label, hint = '') {
  console.log(`${YELLOW}warn    ${RESET}  ${label}${hint ? '  # ' + hint : ''}`);
}

// ── Checks ────────────────────────────────────────────────────────────────────

let failed = false;

// REQUIRED: Node.js version ≥ 22
const [major] = process.versions.node.split('.').map(Number);
if (major >= 22) {
  ok(`Node.js ${process.versions.node}`);
} else {
  missing(`Node.js ${process.versions.node} (need ≥ 22)`, 'upgrade Node.js to v22 or newer');
  failed = true;
}

// REQUIRED: DATA_DIR writable
const dataDir = process.env.DATA_DIR || path.join(here, '..', 'data');
try {
  fs.mkdirSync(dataDir, { recursive: true });
  const probe = path.join(dataDir, '.preflight-write-probe');
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  ok(`DATA_DIR writable (${dataDir})`);
} catch (e) {
  missing(`DATA_DIR writable (${dataDir})`, String(e?.message ?? e));
  failed = true;
}

// OPTIONAL (warn): PORTAL_SECRET_KEY
if (process.env.PORTAL_SECRET_KEY) {
  ok('PORTAL_SECRET_KEY set');
} else if (process.env.SECRET_KEY_ARN) {
  ok('SECRET_KEY_ARN set (AWS Secrets Manager)');
} else if (process.env.PORTAL_SECRET_KEY_SSM_PATH) {
  ok('PORTAL_SECRET_KEY_SSM_PATH set (AWS SSM)');
} else {
  warn('PORTAL_SECRET_KEY not set', 'server will auto-generate data/master.key — back it up');
}

// ── Result ────────────────────────────────────────────────────────────────────

if (failed) {
  console.log(`\n${RED}One or more REQUIRED items are missing. The portal will not start correctly.${RESET}`);
  process.exit(1);
} else {
  console.log(`\n${GREEN}All required items are present.${RESET}`);
  process.exit(0);
}
