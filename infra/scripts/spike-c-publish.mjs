/**
 * Spike C — AppSync Events publisher (IAM SigV4 auth)
 *
 * Reads spike-c-config.json (generated after `cdk deploy AgentPortalSpikeC`).
 * Publishes a burst of events to the run, project, and global channels.
 *
 * Usage:
 *   node scripts/spike-c-publish.mjs              # burst of 500 events
 *   node scripts/spike-c-publish.mjs --verify     # single test event (smoke check)
 *   node scripts/spike-c-publish.mjs --large      # large-payload size-limit test
 *
 * Prerequisites:
 *   - AWS profile 'agentcore' configured
 *   - agentcore IAM user needs:  appsync:EventPublish on the API ARN
 *   - spike-c-config.json present (see scripts/spike-c-setup.mjs)
 */

import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { fromIni } from '@aws-sdk/credential-providers';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

// ── Minimal SHA-256 HashConstructor for @smithy/signature-v4 ──────────────────
// Uses Node.js built-in crypto; no extra packages needed.
function Sha256(secret) {
  if (secret !== undefined && secret !== null) {
    const key = toBuffer(secret);
    this._h = createHmac('sha256', key);
  } else {
    this._h = createHash('sha256');
  }
}
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  return Buffer.from(data);
}
Sha256.prototype.update = function (data) {
  this._h.update(toBuffer(data));
};
Sha256.prototype.digest = function () {
  return Promise.resolve(this._h.digest());
};

// ── Config ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = join(__dir, 'spike-c-config.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    console.error('spike-c-config.json not found. Run spike-c-setup.mjs first.');
    process.exit(1);
  }
}

// ── SigV4 publisher ───────────────────────────────────────────────────────────
async function makePublisher(httpDomain, region) {
  const signer = new SignatureV4({
    credentials: fromIni({ profile: 'agentcore' }),
    region,
    service: 'appsync',
    sha256: Sha256,
  });

  return async function publish(channel, events) {
    const body = JSON.stringify({
      channel,
      events: events.map((e) => JSON.stringify(e)),
    });

    const requestObj = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: httpDomain,
      },
      hostname: httpDomain,
      path: '/event',
      body,
    };

    const signed = await signer.sign(requestObj);

    // Remove 'host' header — fetch sets it automatically (browser restrictions)
    const fetchHeaders = Object.fromEntries(
      Object.entries(signed.headers).filter(([k]) => k.toLowerCase() !== 'host'),
    );

    const res = await fetch(`https://${httpDomain}/event`, {
      method: 'POST',
      headers: fetchHeaders,
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json().catch(() => ({}));
  };
}

// ── Realistic event shapes (mirrors portal SSE shapes) ────────────────────────
function makeRunEvent(runId, seq) {
  return {
    type: 'event',
    event: {
      id: seq,
      run_id: runId,
      type: 'text',
      payload: { content: `Agent output chunk #${seq} — ${randomString(80)}` },
      created_at: new Date().toISOString(),
    },
    publishedAt: Date.now(),
  };
}

function makeProjectEvent(projectId, seq) {
  return {
    type: 'workflow.updated',
    workflowId: `wf-spike-${seq}`,
    projectId,
    status: ['running', 'done', 'failed'][seq % 3],
    publishedAt: Date.now(),
  };
}

function makeGlobalEvent(seq) {
  return {
    type: 'theme.changed',
    etag: `etag-${seq}`,
    publishedAt: Date.now(),
  };
}

function makeLargeRunEvent(runId, targetBytes) {
  const filler = 'A'.repeat(targetBytes);
  return {
    type: 'event',
    event: {
      id: 9999,
      run_id: runId,
      type: 'large_payload_test',
      payload: { content: filler },
      created_at: new Date().toISOString(),
    },
    publishedAt: Date.now(),
    sizeBytes: targetBytes,
  };
}

function randomString(len) {
  return Math.random().toString(36).repeat(Math.ceil(len / 11)).slice(0, len);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes('--verify');
  const largeOnly = args.includes('--large');

  const cfg = loadConfig();
  const { httpDomain, region, runId, projectId } = cfg;

  console.log(`\n=== Spike C Publisher ===`);
  console.log(`HTTP endpoint: https://${httpDomain}`);
  console.log(`Run ID: ${runId}  |  Project ID: ${projectId}`);

  const publish = await makePublisher(httpDomain, region);

  // ── Smoke check ────────────────────────────────────────────────────────────
  console.log('\n[1] Smoke-check: single event to /run channel...');
  const smokeStart = Date.now();
  try {
    await publish(`/run/${runId}`, [
      { type: 'smoke_check', msg: 'IAM publish works', publishedAt: Date.now() },
    ]);
    console.log(`    ✅ OK (${Date.now() - smokeStart} ms round-trip HTTP)`);
  } catch (err) {
    console.error(`    ❌ FAILED: ${err.message}`);
    process.exit(1);
  }

  if (verifyOnly) {
    console.log('\nVerify-only mode — done.');
    return;
  }

  // ── Large payload test ─────────────────────────────────────────────────────
  console.log('\n[2] Large-payload test...');
  const payloadSizes = [4096, 5120, 6000, 10240, 20480];
  const largeResults = [];
  for (const sz of payloadSizes) {
    const event = makeLargeRunEvent(runId, sz);
    const ops = Math.ceil(sz / 5120); // billed operations per this event
    const t0 = Date.now();
    try {
      await publish(`/run/${runId}`, [event]);
      const ms = Date.now() - t0;
      console.log(`    ${sz} bytes → ✅  ${ms} ms  (billed as ${ops} operation${ops > 1 ? 's' : ''})`);
      largeResults.push({ sizeBytes: sz, ms, billedOps: ops, ok: true });
    } catch (err) {
      console.log(`    ${sz} bytes → ❌  ${err.message}`);
      largeResults.push({ sizeBytes: sz, error: err.message, ok: false });
    }
  }

  if (largeOnly) {
    console.log('\nLarge-only mode — done.');
    console.log(JSON.stringify({ largeResults }, null, 2));
    return;
  }

  // ── Burst of 500 events ────────────────────────────────────────────────────
  console.log('\n[3] Burst: 500 run events in batches of 10...');
  const TOTAL = 500;
  const BATCH = 5;  // AppSync Events enforces max 5 events per publish request
  const latencyResults = [];
  let totalPublished = 0;
  let totalBatches = 0;
  let totalErrors = 0;

  const burstStart = Date.now();
  for (let i = 0; i < TOTAL; i += BATCH) {
    const batch = [];
    for (let j = i; j < Math.min(i + BATCH, TOTAL); j++) {
      batch.push(makeRunEvent(runId, j));
    }
    try {
      await publish(`/run/${runId}`, batch);
      totalPublished += batch.length;
      totalBatches++;
    } catch (err) {
      totalErrors++;
      console.error(`    batch ${totalBatches} failed: ${err.message}`);
    }
    // Small delay to avoid overwhelming the API during testing
    if (i % 100 === 90) process.stdout.write('.');
  }
  const burstDuration = Date.now() - burstStart;
  console.log(`\n    Published ${totalPublished} events in ${totalBatches} batches (${totalErrors} errors) — ${burstDuration} ms`);
  console.log(`    Throughput: ${(totalPublished / (burstDuration / 1000)).toFixed(1)} events/s`);

  // ── Project and global events ─────────────────────────────────────────────
  console.log('\n[4] Publishing to project and global channels...');
  for (let i = 0; i < 10; i++) {
    await publish(`/project/${projectId}`, [makeProjectEvent(projectId, i)]);
  }
  console.log('    Published 10 project events');
  for (let i = 0; i < 5; i++) {
    await publish('/global/portal', [makeGlobalEvent(i)]);
  }
  console.log('    Published 5 global events');

  // ── Cost estimate ─────────────────────────────────────────────────────────
  // Pricing: $1.00 per million operations
  // Each published event = 1 publish op + 1 deliver op per subscriber
  // Large events (>5 KB) = ceil(size/5120) ops each for pub + deliver
  const pubOps = totalPublished + 10 + 5; // run + project + global events published
  const largeOpsExtra = largeResults.filter(r => r.ok).reduce((s, r) => s + r.billedOps - 1, 0);
  // Connection + subscribe ops (estimated): 1 connect + 3 subscribe + ~30 keepalives
  const wsOps = 34;
  const totalOps = pubOps + largeOpsExtra + wsOps;
  const costUsd = (totalOps / 1_000_000) * 1.00;
  // Plus connection minutes: assume 5 min connection = 5 ops at $0.08/million-min
  const connMinutes = 5;
  const connCost = (connMinutes / 1_000_000) * 0.08;

  console.log('\n=== Estimated operation count and cost ===');
  console.log(`  Run events published:     ${totalPublished}`);
  console.log(`  Project events published: 10`);
  console.log(`  Global events published:  5`);
  console.log(`  Large payload extra ops:  ${largeOpsExtra}`);
  console.log(`  WS connect/subscribe ops: ${wsOps}`);
  console.log(`  Total publish-side ops:   ${totalOps}`);
  console.log(`  (+ 1 outbound op per subscriber per event if 1 subscriber is connected)`);
  console.log(`  Estimated publish cost:   $${costUsd.toFixed(6)}`);
  console.log(`  Estimated connect cost:   $${connCost.toFixed(8)}`);
  console.log(`  Total estimated cost:     $${(costUsd + connCost).toFixed(6)}`);
  console.log('\nNote: Add subscriber deliver ops to the total when measuring end-to-end.');
  console.log('      Costs are well below $0.01 for this spike test run.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
