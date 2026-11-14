/**
 * Esc on a Kiro session: only the current prompt ends (ACP session/cancel) and kiro-cli stays, so the next message carries on in the same
 * conversation. When kiro-cli does not end the prompt in time, it is stopped the hard way and the next message starts a new one.
 * Real runner code (runKiroRun) against the fake kiro-cli; needs a shell script on the PATH, so Linux and macOS only.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runKiroRun, disposeWarmKiro } from '../kiro-runner/src/run.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const skip = process.platform === 'win32' ? 'needs a kiro-cli shell script on the PATH' : false;

const payload = (prompt: string, runId: string) => ({
  mode: 'kiro-run' as const, runId, prompt,
  token: { accessToken: 'a', expiresAt: '2030-01-01T00:00:00Z', region: 'us-east-1', startUrl: 'https://d-1.awsapps.com/start' },
});

describe('Kiro runner: Esc ends the turn and keeps the session', { skip }, () => {
  let bin = '';
  const saved = { PATH: process.env.PATH, SC: process.env.PORTAL_FAKE_KIRO_SCENARIO, SLOW: process.env.PORTAL_FAKE_KIRO_SLOW_MS };

  before(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-kiro-bin-'));
    fs.writeFileSync(path.join(bin, 'kiro-cli'), `#!/bin/sh\nexec node ${JSON.stringify(path.join(here, 'fake-kiro.mjs'))} "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  });
  after(async () => {
    await disposeWarmKiro();
    process.env.PATH = saved.PATH;
    for (const [k, v] of [['PORTAL_FAKE_KIRO_SCENARIO', saved.SC], ['PORTAL_FAKE_KIRO_SLOW_MS', saved.SLOW]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(bin, { recursive: true, force: true });
  });

  const text = (events: Array<Record<string, unknown>>): string => events.map((e) => JSON.stringify(e)).join('\n');

  it('keeps kiro-cli after an interruption: the next message is another prompt in the same process', async () => {
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-interruptible';
    const first: Array<Record<string, unknown>> = [];
    const ctrl = new AbortController();
    const running = runKiroRun(payload('WAIT for me', 'r1') as never, (e) => { first.push(e); if (JSON.stringify(e).includes('working on it')) setTimeout(() => ctrl.abort(), 100); }, Date.now(), undefined, ctrl.signal);
    const started = Date.now();
    await running;
    assert.ok(Date.now() - started < 7_000, 'the prompt ended at once, not after the hard-stop wait');
    assert.match(text(first), /Interrupted\. The session stays open/);
    assert.doesNotMatch(text(first), /Stopping kiro-cli/);

    const second: Array<Record<string, unknown>> = [];
    await runKiroRun(payload('hello again', 'r2') as never, (e) => { second.push(e); }, Date.now());
    assert.match(text(second), /Continuing in the same kiro-cli session/, 'the same kiro-cli carried on');
    assert.match(text(second), /PROMPTS:2/, 'it has seen both prompts (one process)');
    await disposeWarmKiro();
  });

  it('stops it the hard way when kiro-cli does not end the prompt, and the next message starts a new one', async () => {
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-slow';
    process.env.PORTAL_FAKE_KIRO_SLOW_MS = '60000';
    const first: Array<Record<string, unknown>> = [];
    const ctrl = new AbortController();
    const running = runKiroRun(payload('anything', 'r3') as never, (e) => { first.push(e); if (JSON.stringify(e).includes('kiro-cli ACP starting')) setTimeout(() => ctrl.abort(), 4_000); }, Date.now(), undefined, ctrl.signal);
    await running;
    assert.match(text(first), /did not stop in time/);
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-interruptible';
    const second: Array<Record<string, unknown>> = [];
    await runKiroRun(payload('hello', 'r4') as never, (e) => { second.push(e); }, Date.now());
    assert.doesNotMatch(text(second), /Continuing in the same kiro-cli session/, 'a new kiro-cli');
    assert.match(text(second), /PROMPTS:1/);
    await disposeWarmKiro();
  });
});
