#!/usr/bin/env node
/**
 * infra/scripts/spike-b-login.mjs
 *
 * Invoke kiro-runner in kiro-login mode to obtain a fresh IdC token.
 *
 * Steps:
 *   1. Invoke kiro-runner with kiro-login mode.
 *   2. As soon as the verification URL and user code arrive, write them to:
 *        - stdout (so the user can see them immediately)
 *        - $TEMP/spike-b-login.txt (no tokens)
 *   3. Wait for the user to approve the device code in their browser.
 *   4. Report success or failure and the token payload byte-size.
 *      NEVER print the token itself.
 *
 * The resulting token is returned in the result SSE event. The portal admin
 * would store it in portal.db via the credentials API. In this spike, we only
 * verify the login flow works; no write-back to the portal DB is done here.
 *
 * Usage (run from infra/ directory):
 *   node scripts/spike-b-login.mjs
 *   node scripts/spike-b-login.mjs --runtime-arn <arn>
 *
 * After this script prints the verification URL, open it in a browser,
 * enter the user code, and wait for the script to complete.
 */

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { fromIni } from '@aws-sdk/credential-providers';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// ── Config ────────────────────────────────────────────────────────────────────

const REGION = 'ap-southeast-1';
const PROFILE = 'agentcore';
// Runtime ARN — set by --runtime-arn flag or update after `cdk deploy AgentPortalSpikeB`.
const FALLBACK_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:366019841051:runtime/agentPortalSpikeB-bdj4np3GHd';

// Kiro IAM Identity Center start URL and region (from portal credential)
const IDC_START_URL = 'https://d-906665ee1d.awsapps.com/start';
const IDC_REGION    = 'us-east-1';

const args = process.argv.slice(2);
const runtimeArnIdx = args.indexOf('--runtime-arn');
const RUNTIME_ARN = runtimeArnIdx >= 0 ? args[runtimeArnIdx + 1] : FALLBACK_RUNTIME_ARN;

// ── Login file path ───────────────────────────────────────────────────────────
// Written as soon as the verification URL arrives (no tokens in this file).
const loginFile = join(
  process.env.TEMP || process.env.TMPDIR || tmpdir(),
  'spike-b-login.txt',
);

// ── Invoke AgentCore ──────────────────────────────────────────────────────────

async function invokeKiroLogin(runtimeArn) {
  const credentials = fromIni({ profile: PROFILE });
  const client = new BedrockAgentCoreClient({ region: REGION, credentials });

  const sessionId = randomUUID();
  const runId = `spike-b-login-${Date.now()}`;

  const invocationPayload = {
    mode: 'kiro-login',
    runId,
    startUrl: IDC_START_URL,
    region: IDC_REGION,
  };

  const body = new TextEncoder().encode(JSON.stringify(invocationPayload));

  const t0 = Date.now();
  let firstByteMs = null;
  let challengeEmitted = false;

  console.log(`Invoking kiro-runner login (session=${sessionId.slice(0, 8)}…)`);

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
  let resultEvent = null;

  for await (const chunk of stream) {
    if (firstByteMs === null) firstByteMs = Date.now() - t0;
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : new TextDecoder().decode(chunk);
    const lines = text.split('\n').filter(l => l.startsWith('data:'));
    for (const line of lines) {
      try {
        const ev = JSON.parse(line.slice(5).trim());
        events.push(ev);

        if (ev.type === 'verification' && !challengeEmitted) {
          challengeEmitted = true;
          const { verificationUri, userCode } = ev;

          // Write to stdout immediately
          console.log('\n════════════════════════════════════════════════════════');
          console.log('  KIRO LOGIN — ACTION REQUIRED');
          console.log('════════════════════════════════════════════════════════');
          console.log(`  Verification URL: ${verificationUri}`);
          console.log(`  User code:        ${userCode}`);
          console.log('════════════════════════════════════════════════════════');
          console.log('  1. Open the verification URL in your browser.');
          console.log('  2. Enter the user code when prompted.');
          console.log('  3. Wait for this script to complete.');
          console.log('  (Script will time out after 15 minutes.)');
          console.log('════════════════════════════════════════════════════════\n');

          // Write to temp file (verification info only — NO tokens)
          const loginFileContent = [
            `spike-b-login — ${new Date().toISOString()}`,
            '',
            `Verification URL: ${verificationUri}`,
            `User code:        ${userCode}`,
            '',
            'Open the URL in a browser and enter the user code.',
            'The spike-b-login.mjs script is waiting for approval.',
          ].join('\n');

          try {
            writeFileSync(loginFile, loginFileContent, 'utf8');
            console.log(`(Written to ${loginFile})`);
          } catch (e) {
            console.warn(`Could not write login file: ${e.message}`);
          }
        }

        if (ev.type === 'result') {
          resultEvent = ev;
        }

        if (ev.type === 'error') {
          console.error(`[ERROR] ${ev.message}`);
        }

        if (ev.type === 'status') {
          console.log(`[status] ${ev.text}`);
        }
      } catch { /* non-JSON line */ }
    }
  }

  const durationMs = Date.now() - t0;
  return { sessionId, firstByteMs, durationMs, events, resultEvent };
}

// ── Main ──────────────────────────────────────────────────────────────────────

try {
  if (RUNTIME_ARN === 'REPLACE_WITH_SPIKE_B_RUNTIME_ARN') {
    console.error(
      'ERROR: Runtime ARN not set.\n' +
      'After `cdk deploy AgentPortalSpikeB`, get the ARN from the CloudFormation output\n' +
      'and pass it via: node scripts/spike-b-login.mjs --runtime-arn <arn>\n' +
      'Or update the FALLBACK_RUNTIME_ARN constant in this file.',
    );
    process.exit(1);
  }

  console.log('=== Spike B: kiro-login ===');
  console.log(`Runtime ARN:  ${RUNTIME_ARN}`);
  console.log(`Start URL:    ${IDC_START_URL}`);
  console.log(`IdC region:   ${IDC_REGION}`);
  console.log('');

  const result = await invokeKiroLogin(RUNTIME_ARN);

  console.log('\n─── Login Result ───');
  if (result.resultEvent) {
    const r = result.resultEvent;
    if (r.success) {
      console.log('  ✅ PASS — kiro-cli login completed successfully.');
      console.log(`  Token payload size: ${r.tokenSizeBytes} bytes`);
      console.log('  (Token NOT written to portal DB in this spike.)');
    } else {
      console.log('  ❌ FAIL — kiro-cli login did not complete.');
      if (r.stderrTail) console.log(`  Output: ${r.stderrTail}`);
    }
    console.log(`  Duration:   ${r.durationMs} ms`);
    console.log(`  Cold start: ${r.coldStartMs} ms`);
    console.log(`  Exit code:  ${r.exitCode}`);
  } else {
    console.log('  ❌ No result event received. Check the error events above.');
  }

  console.log(`\n  First byte: ${result.firstByteMs ?? 'N/A'} ms`);
  console.log(`  Total:      ${result.durationMs} ms`);

} catch (e) {
  console.error('\nERROR:', e.message);
  process.exit(1);
}
