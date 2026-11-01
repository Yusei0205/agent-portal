#!/usr/bin/env node
/**
 * Live check for the AgentCore Kiro execution path.
 *
 * Starts a throwaway portal on port 8899 with a copy of data/portal.db,
 * runs a Kiro session via the API with the prompt "Reply with exactly: kiro-cloud-ok",
 * and verifies the run events contain it.
 *
 * Usage:
 *   node scripts/live-check-agentcore.mjs
 *   node scripts/live-check-agentcore.mjs --runtime-arn <arn>
 */

import { DatabaseSync } from 'node:sqlite';
import {
  randomUUID, randomBytes,
  createDecipheriv, createCipheriv, createHash,
} from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const PORT = 8899;

const args = process.argv.slice(2);
const arnIdx = args.indexOf('--runtime-arn');
const RUNTIME_ARN = arnIdx >= 0
  ? args[arnIdx + 1]
  : process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN
    ?? 'arn:aws:bedrock-agentcore:ap-southeast-1:366019841051:runtime/agentPortalSpikeB-bdj4np3GHd';

const PROMPT = 'Reply with exactly: kiro-cloud-ok';

// ── AES-256-GCM helpers ───────────────────────────────────────────────────────

function decrypt(ciphertext, secretKey) {
  const keyBuf = Buffer.from(secretKey, 'hex');
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid ciphertext format');
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function encrypt(plaintext, secretKey) {
  const keyBuf = Buffer.from(secretKey, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

// ── Setup temp DB ─────────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(join(tmpdir(), 'portal-live-check-'));
console.log(`Temp dir: ${tmpDir}`);

// Copy portal.db and master.key to temp dir
// Also copy WAL files if they exist (portal may be in WAL mode)
copyFileSync(join(repoRoot, 'data', 'portal.db'), join(tmpDir, 'portal.db'));
if (existsSync(join(repoRoot, 'data', 'portal.db-wal'))) {
  copyFileSync(join(repoRoot, 'data', 'portal.db-wal'), join(tmpDir, 'portal.db-wal'));
}
if (existsSync(join(repoRoot, 'data', 'portal.db-shm'))) {
  copyFileSync(join(repoRoot, 'data', 'portal.db-shm'), join(tmpDir, 'portal.db-shm'));
}
copyFileSync(join(repoRoot, 'data', 'master.key'), join(tmpDir, 'master.key'));

const secretKey = readFileSync(join(tmpDir, 'master.key'), 'utf8').trim();

// ── Refresh the Kiro IdC token if expired ─────────────────────────────────────

const tmpDb = new DatabaseSync(join(tmpDir, 'portal.db'), { open: true });

const credRow = tmpDb.prepare(
  "SELECT * FROM engine_credentials WHERE engine='kiro' AND mode='identity_center' AND is_default=1 LIMIT 1",
).get();

if (credRow && credRow.extra_config) {
  const extra = JSON.parse(String(credRow.extra_config));
  const tokenExpiry = extra.tokenExpiry ? new Date(String(extra.tokenExpiry)) : null;
  const isExpired = !tokenExpiry || tokenExpiry <= new Date();

  if (isExpired && extra.refreshTokenEnc && extra.clientId && extra.clientSecretEnc) {
    console.log('Refreshing expired Kiro IdC token…');
    try {
      const refreshToken = decrypt(String(extra.refreshTokenEnc), secretKey);
      const clientSecret = decrypt(String(extra.clientSecretEnc), secretKey);
      const clientId = String(extra.clientId);
      const region = String(extra.region ?? 'us-east-1');

      const ssoOidcPath = join(repoRoot, 'node_modules/@aws-sdk/client-sso-oidc/dist-cjs/index.js');
      const ssoMod = await import(pathToFileURL(ssoOidcPath).href);
      const client = new ssoMod.SSOOIDCClient({ region });
      const resp = await client.send(new ssoMod.CreateTokenCommand({
        clientId, clientSecret, grantType: 'refresh_token', refreshToken,
      }));

      const newAccessToken = resp.accessToken;
      const newExpiresIn = resp.expiresIn ?? 28800;
      const newRefreshToken = resp.refreshToken;
      const newExpiresAt = new Date(Date.now() + newExpiresIn * 1000).toISOString();

      const tokenEnc = encrypt(newAccessToken, secretKey);
      const newExtra = {
        ...extra,
        tokenExpiry: newExpiresAt,
        ...(newRefreshToken ? { refreshTokenEnc: encrypt(newRefreshToken, secretKey) } : {}),
      };
      delete newExtra.pendingClientId;
      delete newExtra.pendingClientSecret;
      delete newExtra.pendingDeviceCode;
      delete newExtra.pendingExpireAt;

      tmpDb.prepare(
        'UPDATE engine_credentials SET secret_enc=?, extra_config=?, last4=?, updated_at=? WHERE id=?',
      ).run(tokenEnc, JSON.stringify(newExtra), newAccessToken.slice(-4), new Date().toISOString(), String(credRow.id));

      console.log(`Token refreshed. New expiry: ${newExpiresAt}`);
    } catch (e) {
      console.error(`Token refresh failed: ${e.message}`);
      tmpDb.close();
      process.exit(1);
    }
  } else if (!isExpired) {
    console.log(`Kiro IdC token is valid until ${tokenExpiry?.toISOString()}.`);
  } else {
    console.error('No refresh credentials — cannot auto-refresh token.');
    tmpDb.close();
    process.exit(1);
  }
}

// Find the admin user
const adminUser = tmpDb.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
if (!adminUser) { console.error('No admin user found'); tmpDb.close(); process.exit(1); }
const adminId = String(adminUser.id);
console.log(`Using admin user: ${adminId}`);

// Inject an API token
const rawRand = randomBytes(16).toString('hex');
const tokenRaw = `ap_${rawRand}`;
const tokenPrefix = tokenRaw.slice(0, 10);
const tokenHash = createHash('sha256').update(tokenRaw).digest('hex');
const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
const createdAt = new Date().toISOString();
const tokenId = randomUUID();

tmpDb.prepare(
  `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, scopes, expires_at, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(tokenId, adminId, 'live-check-token', tokenHash, tokenPrefix, 'write', '["read","write"]', expiresAt, createdAt);

tmpDb.close();
console.log('DB prepared.');

// ── Start throwaway portal ────────────────────────────────────────────────────

const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  DATA_DIR: tmpDir,
  PORTAL_KIRO_AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
  PORTAL_KIRO_AGENTCORE_REGION: 'ap-southeast-1',
  AWS_PROFILE: process.env.AWS_PROFILE ?? 'agentcore',
};

console.log(`Starting throwaway portal on port ${PORT}…`);
const server = spawn('node', ['dist/server.mjs'], {
  cwd: repoRoot,
  env: serverEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

const serverOutput = [];
let serverReady = false;

server.stdout.setEncoding('utf8');
server.stdout.on('data', (chunk) => {
  serverOutput.push(chunk);
  if (!serverReady && chunk.includes('Server listening')) serverReady = true;
});
server.stderr.setEncoding('utf8');
server.stderr.on('data', (chunk) => serverOutput.push('[ERR] ' + chunk));

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    reject(new Error('Portal did not start within 15s.\n' + serverOutput.join('')));
  }, 15_000);
  const interval = setInterval(() => {
    if (serverReady) { clearTimeout(timeout); clearInterval(interval); resolve(); }
  }, 100);
});
console.log('Portal started.');

const baseUrl = `http://127.0.0.1:${PORT}`;

// ── API helper ────────────────────────────────────────────────────────────────

async function apiJson(path, opts = {}) {
  const { method = 'GET', body } = opts;
  const headers = {
    Authorization: `Bearer ${tokenRaw}`,
    'Content-Type': 'application/json',
    'X-Requested-With': 'agent-portal',
  };
  const resp = await fetch(`${baseUrl}${path}`, {
    method, headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${method} ${path} → ${resp.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// ── Create project + workflow + run ───────────────────────────────────────────

console.log('Creating test project…');
const projectResp = await apiJson('/api/projects', {
  method: 'POST',
  body: { name: 'AgentCore Live Check', slug: `ac-live-${Date.now()}` },
});
const projectId = projectResp.project.id;
console.log(`Project: ${projectId}`);

console.log('Creating kiro workflow…');
const wfResp = await apiJson(`/api/projects/${projectId}/workflows`, {
  method: 'POST',
  body: { goal: PROMPT, engine: 'kiro' },
});
const workflowId = wfResp.workflow.id;
console.log(`Workflow: ${workflowId}`);

console.log('Starting run…');
const startResp = await apiJson(`/api/projects/${projectId}/workflows/${workflowId}/start`, {
  method: 'POST',
  body: {},
});
const runId = startResp.run?.id ?? startResp.id;
console.log(`Run: ${runId}`);

// Short wait then check status
await new Promise(r => setTimeout(r, 1000));
const runInfo = await apiJson(`/api/runs/${runId}`).catch(e => ({ error: e.message }));
console.log(`Run status (1s): ${runInfo?.run?.status ?? JSON.stringify(runInfo)}`);

// ── Stream SSE events ─────────────────────────────────────────────────────────

console.log('Streaming run events (max 3 min)…');
const t0 = Date.now();
const RUN_TIMEOUT_MS = 3 * 60_000;
const collectedText = [];
let runComplete = false;

await new Promise((resolve, reject) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
    reject(new Error('Run events timed out after 3 minutes'));
  }, RUN_TIMEOUT_MS);

  fetch(`${baseUrl}/api/runs/${runId}/events`, {
    headers: {
      Authorization: `Bearer ${tokenRaw}`,
      Accept: 'text/event-stream',
      'X-Requested-With': 'agent-portal',
    },
    signal: controller.signal,
  }).then(async (resp) => {
    if (!resp.ok) {
      clearTimeout(timeout);
      reject(new Error(`Events endpoint returned ${resp.status}`));
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;
        try {
          const data = JSON.parse(jsonStr);
          // Portal wraps events as { type: 'event', event: { type, payload, ... } }
          const ev = data.type === 'event' ? data.event : data;
          const evType = ev?.type;
          const payload = ev?.payload ?? {};

          if (evType === 'assistant-text') {
            const text = payload?.text ?? '';
            if (text) { collectedText.push(text); process.stdout.write('.'); }
          } else if (evType === 'run-complete') {
            runComplete = true;
            clearTimeout(timeout);
            reader.cancel();
            resolve();
            return;
          } else if (evType === 'run-failed') {
            clearTimeout(timeout);
            const err = payload?.error ?? 'run failed';
            reject(new Error(`Run failed: ${err}`));
            return;
          } else if (evType === 'status') {
            const t = payload?.text ?? '';
            if (t) process.stdout.write(`\n  [status] ${t}`);
          } else if (evType === 'error') {
            console.error(`\n  [run error] ${payload?.message ?? JSON.stringify(payload)}`);
          }
        } catch { /* skip */ }
      }
    }
    clearTimeout(timeout);
    resolve();
  }).catch((err) => {
    if (err.name !== 'AbortError') { clearTimeout(timeout); reject(err); }
  });
});

console.log('\nRun streaming done.');

// ── Check result ──────────────────────────────────────────────────────────────

const fullText = collectedText.join('');
const passed = fullText.includes('kiro-cloud-ok');
const elapsedMs = Date.now() - t0;

console.log(`\n─── Live Check Result ───`);
console.log(`  Elapsed:     ${elapsedMs} ms`);
console.log(`  Text output: ${fullText.slice(0, 200)}`);

if (passed) {
  console.log('\n  ✅ PASS — run events contain "kiro-cloud-ok".');
} else {
  console.log('\n  ❌ FAIL — "kiro-cloud-ok" not found in run events.');
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

console.log('\nStopping throwaway portal…');
server.kill('SIGTERM');
await new Promise(r => setTimeout(r, 1_000));
if (!server.killed) server.kill('SIGKILL');

process.exit(passed ? 0 : 1);
