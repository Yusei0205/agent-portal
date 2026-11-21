#!/usr/bin/env node
/**
 * infra/scripts/invoke.mjs
 *
 * Invoke the AgentCore Runtime and measure cold/warm start, token and cost metrics.
 *
 * Usage (run from infra/ directory):
 *   node scripts/invoke.mjs                      # single normal run (cold start)
 *   node scripts/invoke.mjs --cold               # 3 cold-start runs
 *   node scripts/invoke.mjs --warm <sessionId>   # warm call (reuse session)
 *   node scripts/invoke.mjs --guard              # guard test
 *   node scripts/invoke.mjs --repo               # repo clone test
 *   node scripts/invoke.mjs --diag               # diagnostic run (df -h /tmp etc.)
 *
 * AWS credentials: loaded from the agentcore profile via @aws-sdk/credential-providers.
 */

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { fromIni } from '@aws-sdk/credential-providers';
import { randomUUID } from 'crypto';

const REGION = 'ap-southeast-1';
const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:366019841051:runtime/agentPortalSpikeA-1BMsBp5VDV';
const MODEL = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

const args = process.argv.slice(2);

const credentials = fromIni({ profile: 'agentcore' });
const client = new BedrockAgentCoreClient({ region: REGION, credentials });

const PROMPTS = {
  normal:     'Write hello.txt containing hi, then read it back and confirm its contents.',
  guard:      'Write the JSON {"blocked":true} to .claude/settings.json',
  repo:       'List all files, then summarise what this repository contains and its purpose.',
  diag:       'Run: df -h /tmp && echo "---" && free -m && echo "---" && nproc && echo "---" && cat /proc/meminfo | grep -i memtotal',
  persist_a:  'Write persist_test.txt containing the text "session-A". Confirm it was written.',
  persist_b:  'Read persist_test.txt and tell me its contents.',
};

const MAX_TURNS = { normal: 5, guard: 8, repo: 5, diag: 3, persist_a: 3, persist_b: 3 };

/** Build the SSE body for a given mode. */
function makePayload(mode) {
  const base = {
    runId: `${mode}-${Date.now()}`,
    prompt: PROMPTS[mode],
    model: MODEL,
    maxTurns: MAX_TURNS[mode] ?? 5,
    maxBudgetUsd: 0.25,
  };
  if (mode === 'repo') base.repo = { url: 'https://github.com/octocat/Hello-World' };
  return base;
}

/** Invoke the Runtime and collect SSE events. Returns timing + parsed events. */
async function invoke(runtimeSessionId, mode) {
  const payload = makePayload(mode);
  const body = new TextEncoder().encode(JSON.stringify(payload));

  const t0 = Date.now();
  let firstByteMs = null;
  let firstTokenMs = null;

  const cmd = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: RUNTIME_ARN,
    runtimeSessionId,          // session ID header
    payload: body,
    contentType: 'application/json',
    accept: 'text/event-stream',
  });

  const resp = await client.send(cmd);
  const stream = resp.response;

  const events = [];
  let metrics = null;
  let rawChunks = '';

  // The response stream is a Node.js Readable or AsyncIterable
  for await (const chunk of stream) {
    if (firstByteMs === null) firstByteMs = Date.now() - t0;
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : new TextDecoder().decode(chunk);
    rawChunks += text;
    const lines = text.split('\n').filter(l => l.startsWith('data:'));
    for (const line of lines) {
      try {
        const ev = JSON.parse(line.slice(5).trim());
        events.push(ev);
        if (ev.type === 'assistant-text' && firstTokenMs === null) {
          firstTokenMs = Date.now() - t0;
        }
        if (ev.type === 'result') {
          metrics = ev.metrics;
        }
      } catch { /* non-JSON line */ }
    }
  }

  const durationMs = Date.now() - t0;
  return { runtimeSessionId, firstByteMs, firstTokenMs, durationMs, events, metrics };
}

function printResult(r, label) {
  const m = r.metrics ?? {};
  console.log(`\n─── ${label} ───`);
  console.log(`  Session:       ${r.runtimeSessionId}`);
  console.log(`  First byte:    ${r.firstByteMs ?? 'N/A'} ms`);
  console.log(`  First token:   ${r.firstTokenMs ?? 'N/A'} ms`);
  console.log(`  Duration:      ${r.durationMs} ms`);
  console.log(`  Cold start:    ${m.coldStartMs ?? 'N/A'} ms   (process start → invoke)`);
  console.log(`  Turns:         ${m.turns ?? 'N/A'}`);
  console.log(`  Input tokens:  ${m.inputTokens ?? 'N/A'}`);
  console.log(`  Output tokens: ${m.outputTokens ?? 'N/A'}`);
  console.log(`  Cache write:   ${m.cacheWriteTokens ?? 'N/A'}`);
  console.log(`  Cache read:    ${m.cacheReadTokens ?? 'N/A'}`);
  console.log(`  Cost (SDK):    $${(m.costUsd ?? 0).toFixed(5)}`);
  console.log(`  Peak RSS:      ${m.peakRssMb ?? 'N/A'} MB`);
  console.log(`  Disk (work):   ${m.workDirDiskMb ?? 'N/A'} MB`);
  console.log(`  Stop reason:   ${r.events.find(e => e.type === 'result')?.stop_reason ?? 'N/A'}`);
  console.log('\n  Events:');
  for (const ev of r.events) {
    if (ev.type === 'assistant-text')  console.log(`    [text]    ${ev.text.slice(0, 200)}`);
    else if (ev.type === 'tool-blocked') console.log(`    [BLOCKED] ${ev.toolName}: ${ev.reason.slice(0, 200)}`);
    else if (ev.type === 'tool-call')  console.log(`    [call]    ${ev.name}: ${ev.input.slice(0, 100)}`);
    else if (ev.type === 'tool-result') console.log(`    [result]  ${String(ev.output).slice(0, 200)}`);
    else if (ev.type === 'status')     console.log(`    [status]  ${ev.text}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (args.includes('--cold')) {
  console.log('=== Cold Start Measurement (3 runs with new sessions) ===');
  const results = [];
  for (let i = 1; i <= 3; i++) {
    const sessionId = randomUUID();
    process.stdout.write(`Run ${i}/3 (${sessionId.slice(0, 8)}…) `);
    const r = await invoke(sessionId, 'normal');
    results.push(r);
    const m = r.metrics ?? {};
    console.log(`→ firstByte=${r.firstByteMs}ms firstToken=${r.firstTokenMs}ms duration=${r.durationMs}ms coldStart=${m.coldStartMs ?? '?'}ms cost=$${(m.costUsd ?? 0).toFixed(5)}`);
  }
  console.log('\nSummary:');
  const fbs = results.map(r => r.firstByteMs).filter(Boolean);
  const fts = results.map(r => r.firstTokenMs).filter(Boolean);
  const colds = results.map(r => r.metrics?.coldStartMs).filter(Boolean);
  if (fbs.length) console.log(`  Avg first-byte:   ${Math.round(fbs.reduce((a,b)=>a+b)/fbs.length)} ms`);
  if (fts.length) console.log(`  Avg first-token:  ${Math.round(fts.reduce((a,b)=>a+b)/fts.length)} ms`);
  if (colds.length) console.log(`  Avg cold start:   ${Math.round(colds.reduce((a,b)=>a+b)/colds.length)} ms`);
  console.log('\nFirst session ID for warm follow-up:', results[0].runtimeSessionId);

} else if (args.includes('--warm')) {
  const sessionId = args[args.indexOf('--warm') + 1];
  if (!sessionId) { console.error('--warm requires a session ID'); process.exit(1); }
  const r = await invoke(sessionId, 'normal');
  printResult(r, 'Warm call');

} else {
  const mode = args.includes('--guard') ? 'guard' :
               args.includes('--repo') ? 'repo' :
               args.includes('--diag') ? 'diag' :
               args.includes('--persist-a') ? 'persist_a' :
               args.includes('--persist-b') ? 'persist_b' : 'normal';
  const sessionId = randomUUID();
  const r = await invoke(sessionId, mode);
  printResult(r, `Single run (mode=${mode})`);
  if (mode === 'diag') {
    console.log('\n=== Diagnostic output (bash results) ===');
    for (const ev of r.events.filter(e => e.type === 'tool-result')) {
      console.log(String(ev.output));
    }
  }
  console.log('\nSession ID:', sessionId);
}
