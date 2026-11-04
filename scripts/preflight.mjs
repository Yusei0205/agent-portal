/**
 * Pre-flight check for the Agent Portal.
 *
 * Prints one line per check:
 *   [ok]   <item>   — check passed
 *   [warn] <item>   — optional / recommended but not blocking
 *   [FAIL] <item>   — required item missing (causes non-zero exit)
 *
 * Exit codes:
 *   0 — all REQUIRED checks passed
 *   1 — one or more REQUIRED checks failed
 *
 * Usage:
 *   node scripts/preflight.mjs
 *   DEPLOY_TARGET=cloud node scripts/preflight.mjs
 *   STORAGE_BACKEND=s3 STORAGE_S3_BUCKET=my-bucket node scripts/preflight.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// ── ANSI colours ──────────────────────────────────────────────────────────────

const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const RESET  = '\x1b[0m';

let failed = false;

function printOk(label) {
  console.log(`${GREEN}[ok]  ${RESET} ${label}`);
}

function printWarn(label) {
  console.log(`${YELLOW}[warn]${RESET} ${label}`);
}

function printFail(label) {
  console.log(`${RED}[FAIL]${RESET} ${label}`);
  failed = true;
}

// ── 1. Node version ≥ 22.13 ───────────────────────────────────────────────────

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13)) {
  printOk(`node 22.13+ (${process.versions.node})`);
} else {
  printFail(`node ${process.versions.node} — need ≥ 22.13 (uses built-in node:sqlite)`);
}

// ── 2. DATA_DIR writable ──────────────────────────────────────────────────────

const dataDir = process.env.DATA_DIR ?? path.join(here, '..', 'data');
try {
  fs.mkdirSync(dataDir, { recursive: true });
  const probe = path.join(dataDir, '.preflight-write-probe');
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  printOk(`DATA_DIR writable (${dataDir})`);
} catch (e) {
  printFail(`DATA_DIR not writable (${dataDir}) — ${e?.message ?? e}`);
}

// ── 3. PORTAL_SECRET_KEY ──────────────────────────────────────────────────────

const hasSecretKey = !!process.env.PORTAL_SECRET_KEY;
const hasSecretArn = !!process.env.SECRET_KEY_ARN;
const hasSsmPath   = !!process.env.PORTAL_SECRET_KEY_SSM_PATH;

if (hasSecretKey) {
  printOk('PORTAL_SECRET_KEY set');
} else if (hasSecretArn) {
  printOk(`SECRET_KEY_ARN set (${process.env.SECRET_KEY_ARN})`);
} else if (hasSsmPath) {
  printOk(`PORTAL_SECRET_KEY_SSM_PATH set (${process.env.PORTAL_SECRET_KEY_SSM_PATH})`);
} else {
  printWarn('PORTAL_SECRET_KEY not set — using auto-generated file (not recommended for cloud)');
}

// ── 4. Cloud-specific checks (DEPLOY_TARGET=cloud) ────────────────────────────

const isCloud = process.env.DEPLOY_TARGET === 'cloud';

if (isCloud) {
  // Secret key is REQUIRED in cloud mode
  if (!hasSecretKey && !hasSecretArn && !hasSsmPath) {
    printFail(
      'DEPLOY_TARGET=cloud requires PORTAL_SECRET_KEY, SECRET_KEY_ARN, or PORTAL_SECRET_KEY_SSM_PATH',
    );
  } else {
    printOk('secret key configured for cloud');
  }

  // TRUST_PROXY=1 is required in cloud mode (behind a load balancer)
  if (process.env.TRUST_PROXY === '1') {
    printOk('TRUST_PROXY=1');
  } else {
    printFail('DEPLOY_TARGET=cloud requires TRUST_PROXY=1 (portal is behind a load balancer)');
  }

  // Kiro: if MODEL_PROVIDER=kiro, need KIRO_API_KEY or an existing session file
  const provider = process.env.MODEL_PROVIDER ?? '';
  if (provider === 'kiro') {
    const kiroApiKey = !!process.env.KIRO_API_KEY;
    const kiroHome = process.env.KIRO_HOME ?? path.join(dataDir, 'kiro-models', '.kiro');
    const kiroSessionFile = path.join(kiroHome, 'credentials');
    const kiroSessionExists = fs.existsSync(kiroSessionFile);

    if (kiroApiKey) {
      printOk('KIRO_API_KEY set');
    } else if (kiroSessionExists) {
      printOk(`kiro session file found (${kiroSessionFile})`);
    } else {
      printFail(
        'MODEL_PROVIDER=kiro requires KIRO_API_KEY or an existing kiro session file in ' +
          kiroSessionFile,
      );
    }
  }
}

// ── 5. S3 storage checks (STORAGE_BACKEND=s3) ────────────────────────────────

const storageBackend = process.env.STORAGE_BACKEND ?? 'local';

if (storageBackend === 's3') {
  const bucket = process.env.STORAGE_S3_BUCKET;
  if (!bucket) {
    printFail('STORAGE_BACKEND=s3 requires STORAGE_S3_BUCKET to be set');
  } else {
    printOk(`STORAGE_S3_BUCKET=${bucket}`);

    // Optional connectivity test
    try {
      const region = process.env.STORAGE_S3_REGION ?? process.env.AWS_REGION ?? 'us-east-1';
      const prefix = process.env.STORAGE_S3_PREFIX ?? '';
      // Dynamically import so this script works without AWS SDK installed
      const { S3StorageBackend } = await import(
        new URL('../server/storage/s3.ts', import.meta.url).href
      );
      const backend = new S3StorageBackend({ bucket, prefix, region });
      await backend.ping();
      printOk(`S3 bucket reachable (${bucket})`);
    } catch (e) {
      printWarn(`S3 bucket ping failed (${e?.message ?? e}) — check credentials and bucket name`);
    }
  }
} else {
  printOk(`STORAGE_BACKEND=${storageBackend}`);
}

// ── 6. Summary ────────────────────────────────────────────────────────────────

console.log('');
if (failed) {
  console.log(
    `${RED}One or more required checks failed. The portal may not start correctly.${RESET}`,
  );
  process.exit(1);
} else {
  console.log(`${GREEN}All required checks passed.${RESET}`);
  process.exit(0);
}
