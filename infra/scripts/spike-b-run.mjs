#!/usr/bin/env node
/**
 * infra/scripts/spike-b-run.mjs
 *
 * Invoke kiro-runner in kiro-run mode and report the result.
 *
 * Steps:
 *   1. Read data/portal.db (read-only) and find the Kiro IdC credential.
 *   2. Read data/master.key for the portal secret key.
 *   3. Decrypt the credential fields (AES-256-GCM, same algorithm as server/secrets.ts).
 *   4. Build the token payload object (never print it).
 *   5. Invoke the kiro-runner via AgentCore (InvokeAgentRuntime).
 *   6. Stream SSE events; print agent output, timings, and refresh status.
 *
 * Security:
 *   - Token values are NEVER printed or logged.
 *   - Only the refreshed-token FACT is reported (not the token itself).
 *   - If the refresh token is expired, that is reported as a clear blocker.
 *
 * Usage (run from infra/ directory):
 *   node scripts/spike-b-run.mjs
 *   node scripts/spike-b-run.mjs --runtime-arn <arn>
 */

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { fromIni } from '@aws-sdk/credential-providers';
import { randomUUID, createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// ── Resolve paths ─────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');   // infra/scripts → infra → repo root
const dataDir  = join(repoRoot, 'data');
const dbPath   = join(dataDir, 'portal.db');
const keyPath  = join(dataDir, 'master.key');

// ── Config ────────────────────────────────────────────────────────────────────

const REGION = 'ap-southeast-1';
const PROFILE = 'agentcore';
// Runtime ARN — set by --runtime-arn flag or update this constant after `cdk deploy`.
// After deploy: check CloudFormation stack AgentPortalSpikeB output "RuntimeArn".
const FALLBACK_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:366019841051:runtime/agentPortalSpikeB-bdj4np3GHd';

const args = process.argv.slice(2);
const runtimeArnIdx = args.indexOf('--runtime-arn');
const RUNTIME_ARN = runtimeArnIdx >= 0 ? args[runtimeArnIdx + 1] : FALLBACK_RUNTIME_ARN;

const PROMPT = 'Reply with exactly: kiro-cloud-ok';

// ── AES-256-GCM decrypt/encrypt (same as server/secrets.ts) ─────────────────

function decrypt(ciphertext, secretKey) {
  const keyBuf = Buffer.from(secretKey, 'hex');
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid ciphertext format — expected iv:authTag:ciphertext');
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

// ── Token refresh via OIDC (same logic as server/credentials.ts) ─────────────

/**
 * Attempt to refresh an expired/expiring IdC access token using the stored
 * refresh token and OIDC client credentials.
 * Returns the new token payload on success, or null on failure.
 * Never logs token values.
 */
async function tryRefreshToken(extra, secretKey, credName) {
  const clientId = String(extra.clientId ?? '');
  const clientSecretExpiresAt = Number(extra.clientSecretExpiresAt ?? 0);

  if (!extra.refreshTokenEnc || !clientId || !extra.clientSecretEnc) {
    console.log('  No refresh credentials stored — cannot auto-refresh.');
    return null;
  }
  if (clientSecretExpiresAt > 0 && clientSecretExpiresAt * 1000 < Date.now()) {
    console.log('  Client registration expired — cannot auto-refresh. Run spike-b-login.mjs.');
    return null;
  }

  let clientSecret, refreshToken;
  try {
    clientSecret = decrypt(String(extra.clientSecretEnc), secretKey);
    refreshToken = decrypt(String(extra.refreshTokenEnc), secretKey);
  } catch {
    console.log('  Could not decrypt refresh credentials.');
    return null;
  }

  const region = String(extra.region ?? 'us-east-1');
  console.log(`  Attempting token refresh (region=${region})…`);

  try {
    // Use dynamic import to access @aws-sdk/client-sso-oidc from portal root
    // Use pathToFileURL to handle Windows absolute paths as valid file:// URLs
    const ssoOidcPath = join(repoRoot, 'node_modules/@aws-sdk/client-sso-oidc/dist-cjs/index.js');
    const ssoOidcMod = await import(pathToFileURL(ssoOidcPath).href);
    const client = new ssoOidcMod.SSOOIDCClient({ region });
    const resp = await client.send(new ssoOidcMod.CreateTokenCommand({
      clientId,
      clientSecret,
      grantType: 'refresh_token',
      refreshToken,
    }));

    const newAccessToken = resp.accessToken;
    const newExpiresIn = resp.expiresIn ?? 28800;
    const newRefreshToken = resp.refreshToken;
    const newExpiresAt = new Date(Date.now() + newExpiresIn * 1000).toISOString();

    console.log(`  ✅ Token refreshed successfully. New expiry: ${newExpiresAt}`);
    return {
      accessToken: newAccessToken,
      expiresAt: newExpiresAt,
      ...(newRefreshToken ? { refreshToken: newRefreshToken } : {}),
    };
  } catch (e) {
    console.log(`  Token refresh failed: ${e.name ?? 'Error'} — ${e.message?.slice(0, 200)}`);
    return null;
  }
}

// ── Read portal credential ────────────────────────────────────────────────────

async function readKiroIdcCredential() {
  // Read secret key
  let secretKey;
  try {
    secretKey = readFileSync(keyPath, 'utf8').trim();
  } catch (e) {
    throw new Error(`Cannot read ${keyPath}: ${e.message}. Set PORTAL_SECRET_KEY env var instead.`);
  }

  // Override with env var if set (same priority as server/config.ts)
  if (process.env.PORTAL_SECRET_KEY) {
    secretKey = process.env.PORTAL_SECRET_KEY.trim();
  }

  // Open portal.db read-only
  let db;
  try {
    db = new DatabaseSync(dbPath, { open: true });
  } catch (e) {
    throw new Error(`Cannot open ${dbPath}: ${e.message}`);
  }

  let cred;
  try {
    cred = db.prepare(
      "SELECT * FROM engine_credentials WHERE engine = 'kiro' AND mode = 'identity_center' LIMIT 1",
    ).get();
  } finally {
    try { db.close(); } catch { /* ok */ }
  }

  if (!cred) {
    throw new Error(
      "No Kiro IdC credential found in portal.db (engine='kiro', mode='identity_center'). " +
      'Sign in via Settings › Credentials first.',
    );
  }

  if (!cred.secret_enc) {
    throw new Error('Kiro IdC credential has no access token yet — complete the device-code sign-in first.');
  }

  // Decrypt access token
  const accessToken = decrypt(cred.secret_enc, secretKey);

  // Parse extra_config
  let extra = {};
  try { extra = JSON.parse(cred.extra_config || '{}'); } catch { /* ok */ }

  const region = String(extra.region ?? 'us-east-1');
  const startUrl = String(extra.startUrl ?? '');
  const expiresAt = extra.tokenExpiry
    ? String(extra.tokenExpiry)
    : new Date(Date.now() + 28_800_000).toISOString();

  // Decrypt optional fields (non-fatal if they fail)
  let refreshToken = '';
  if (extra.refreshTokenEnc) {
    try { refreshToken = decrypt(extra.refreshTokenEnc, secretKey); } catch { /* best-effort */ }
  }

  let clientSecret = '';
  if (extra.clientSecretEnc) {
    try { clientSecret = decrypt(extra.clientSecretEnc, secretKey); } catch { /* best-effort */ }
  }

  const clientId = String(extra.clientId ?? '');
  const clientSecretExpiresAt = Number(extra.clientSecretExpiresAt ?? 0);
  const profileArn = String(extra.selectedProfileArn ?? '');
  const profileName = String(extra.selectedProfileName ?? '');

  // Check token expiry
  const expiresMs = new Date(expiresAt).getTime();
  const isExpired = expiresMs <= Date.now();
  const isExpiringSoon = expiresMs <= Date.now() + 5 * 60 * 1000;

  // Log status (never log token values)
  console.log(`Credential: "${cred.name}" (engine_id=${cred.id})`);
  console.log(`Token expiry: ${expiresAt} (${isExpired ? 'EXPIRED' : isExpiringSoon ? 'expiring soon' : 'valid'})`);
  console.log(`Has refresh token: ${Boolean(refreshToken)}`);
  console.log(`Has client registration: ${Boolean(clientId && clientSecret)}`);
  console.log(`Profile ARN: ${profileArn || '(none)'}`);

  if (isExpired && !refreshToken) {
    throw new Error(
      'Kiro IdC token is expired and no refresh token is stored. ' +
      'Run `node scripts/spike-b-login.mjs` to obtain a fresh token.',
    );
  }

  // Always attempt a proactive refresh so we invoke kiro-runner with the freshest token.
  // This tests the refresh path AND ensures kiro-cli gets a brand-new access token.
  if (refreshToken) {
    console.log('Attempting proactive OIDC token refresh…');
    const refreshed = await tryRefreshToken(extra, secretKey, cred.name);
    if (refreshed) {
      console.log('Using refreshed token.');
      return {
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
        region,
        startUrl,
        ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : { refreshToken }),
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
        ...(clientSecretExpiresAt ? { clientSecretExpiresAt } : {}),
        ...(profileArn ? { profileArn } : {}),
        ...(profileName ? { profileName } : {}),
      };
    }
    console.log('OIDC refresh failed. Continuing with stored token.');
  }

  return {
    accessToken,
    expiresAt,
    region,
    startUrl,
    ...(refreshToken ? { refreshToken } : {}),
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(clientSecretExpiresAt ? { clientSecretExpiresAt } : {}),
    ...(profileArn ? { profileArn } : {}),
    ...(profileName ? { profileName } : {}),
  };
}

// ── Invoke AgentCore ──────────────────────────────────────────────────────────

async function invokeKiroRun(runtimeArn, tokenPayload) {
  const credentials = fromIni({ profile: PROFILE });
  const client = new BedrockAgentCoreClient({ region: REGION, credentials });

  const sessionId = randomUUID();
  const runId = `spike-b-run-${Date.now()}`;

  const invocationPayload = {
    mode: 'kiro-run',
    runId,
    prompt: PROMPT,
    token: tokenPayload,
  };

  const body = new TextEncoder().encode(JSON.stringify(invocationPayload));

  const t0 = Date.now();
  let firstByteMs = null;
  let firstTextMs = null;

  console.log(`\nInvoking kiro-runner (session=${sessionId.slice(0, 8)}…)`);
  console.log(`Prompt: "${PROMPT}"`);

  const cmd = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: runtimeArn,
    runtimeSessionId: sessionId,
    payload: body,
    contentType: 'application/json',
    accept: 'text/event-stream',
  });

  const resp = await client.send(cmd);
  const stream = resp.response;

  const events = [];
  let rawChunks = '';
  let resultEvent = null;

  for await (const chunk of stream) {
    if (firstByteMs === null) firstByteMs = Date.now() - t0;
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : new TextDecoder().decode(chunk);
    rawChunks += text;
    const lines = text.split('\n').filter(l => l.startsWith('data:'));
    for (const line of lines) {
      try {
        const ev = JSON.parse(line.slice(5).trim());
        events.push(ev);
        if (ev.type === 'text' && firstTextMs === null) {
          firstTextMs = Date.now() - t0;
        }
        if (ev.type === 'result') {
          resultEvent = ev;
        }
      } catch { /* non-JSON line */ }
    }
  }

  const durationMs = Date.now() - t0;
  return { sessionId, firstByteMs, firstTextMs, durationMs, events, resultEvent };
}

// ── Main ──────────────────────────────────────────────────────────────────────

try {
  if (RUNTIME_ARN === 'REPLACE_WITH_SPIKE_B_RUNTIME_ARN') {
    console.error(
      'ERROR: Runtime ARN not set.\n' +
      'After `cdk deploy AgentPortalSpikeB`, get the ARN from the CloudFormation output\n' +
      'and pass it via: node scripts/spike-b-run.mjs --runtime-arn <arn>\n' +
      'Or update the FALLBACK_RUNTIME_ARN constant in this file.',
    );
    process.exit(1);
  }

  console.log('=== Spike B: kiro-run ===');
  console.log(`Runtime ARN: ${RUNTIME_ARN}`);

  // Step 1: read and decrypt credential
  const tokenPayload = await readKiroIdcCredential();

  // Step 2: invoke
  const t0 = Date.now();
  const result = await invokeKiroRun(RUNTIME_ARN, tokenPayload);
  const totalMs = Date.now() - t0;

  // Step 3: print results
  console.log('\n─── Results ───');
  console.log(`  Session:      ${result.sessionId}`);
  console.log(`  First byte:   ${result.firstByteMs ?? 'N/A'} ms`);
  console.log(`  First text:   ${result.firstTextMs ?? 'N/A'} ms`);
  console.log(`  Duration:     ${result.durationMs} ms`);
  console.log(`  Total:        ${totalMs} ms`);

  console.log('\n  Agent output:');
  for (const ev of result.events) {
    if (ev.type === 'text')   console.log(`    [text]   ${ev.text}`);
    if (ev.type === 'status') console.log(`    [status] ${ev.text}`);
    if (ev.type === 'error')  console.log(`    [ERROR]  ${ev.message}`);
  }

  if (result.resultEvent) {
    const r = result.resultEvent;
    console.log(`\n  Exit code:    ${r.exitCode}`);
    console.log(`  Cold start:   ${r.coldStartMs} ms`);

    if (r.tokenRefreshed) {
      console.log('\n  ✅ Token was refreshed by kiro-cli during the run.');
      console.log('     (New token not written to portal DB in this spike — caller must handle write-back.)');
    } else {
      console.log('\n  ℹ️  Token was NOT refreshed (still valid, or refresh not attempted).');
    }

    if (r.stderrTail) {
      console.log(`\n  kiro-cli stderr: ${r.stderrTail}`);
    }
  }

  // Determine pass/fail — join text chunks without separator (ACP streams partial text)
  const agentOutputEvents = result.events.filter(e => e.type === 'text');
  const agentText = agentOutputEvents.map(e => e.text).join('');
  const passed = agentText.includes('kiro-cloud-ok');

  console.log('\n─── Verdict ───');
  if (passed) {
    console.log('  ✅ PASS — kiro-cli replied with "kiro-cloud-ok" inside AgentCore.');
  } else if (agentOutputEvents.length > 0) {
    console.log('  ⚠️  PARTIAL — kiro-cli ran but response did not contain "kiro-cloud-ok".');
    console.log(`     Response: ${agentText.slice(0, 500)}`);
  } else {
    console.log('  ❌ FAIL — no text output from kiro-cli. Check the error events above.');
  }

  console.log(`\n  Timing:  firstByte=${result.firstByteMs}ms  firstText=${result.firstTextMs}ms  duration=${result.durationMs}ms`);

} catch (e) {
  console.error('\nERROR:', e.message);
  process.exit(1);
}
