/**
 * The runner stops a turn at its time limit and says so: "the turn reached the runner's time limit ... (kiro-cli process exited)",
 * not only the bare "kiro-cli process exited" that the dying process produces. Real runner code against the fake kiro-cli, with the
 * limit set to 1.5 seconds. Needs a shell script on the PATH, so Linux and macOS only.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { interruptionOf } from '../server/workflows/recovery.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const runnerDir = path.join(here, '..', 'kiro-runner');
if (process.platform !== 'win32' && !fs.existsSync(path.join(runnerDir, 'shared', 'runner-files.ts'))) {
  execFileSync(process.execPath, ['build.mjs'], { cwd: runnerDir, stdio: 'inherit' });
}
// The limit is read when the runner loads.
process.env.KIRO_TURN_LIMIT_MS = '1500';
const { runKiroRun, disposeWarmKiro } = await import(pathToFileURL(path.join(runnerDir, 'src', 'run.ts')).href) as {
  runKiroRun(payload: unknown, emit: (e: Record<string, unknown>) => void, startMs: number): Promise<void>;
  disposeWarmKiro(): Promise<void>;
};
const skip = process.platform === 'win32' ? 'needs a kiro-cli shell script on the PATH' : false;

describe('Kiro runner: the turn time limit', { skip }, () => {
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
    for (const [k, v] of [['PORTAL_FAKE_KIRO_SCENARIO', saved.SC], ['PORTAL_FAKE_KIRO_SLOW_MS', saved.SLOW], ['KIRO_TURN_LIMIT_MS', undefined]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it('a turn still going at the limit is stopped, the error says why, and the portal counts it as an interruption it can recover from', async () => {
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-slow';
    process.env.PORTAL_FAKE_KIRO_SLOW_MS = '60000';
    const events: Array<Record<string, unknown>> = [];
    const started = Date.now();
    await runKiroRun({
      mode: 'kiro-run', runId: 'limit-1', prompt: 'a very long job',
      token: { accessToken: 'a', expiresAt: '2030-01-01T00:00:00Z', region: 'us-east-1', startUrl: 'https://d-1.awsapps.com/start' },
    }, (e) => { events.push(e); }, Date.now());
    const took = Date.now() - started;
    assert.ok(took >= 1_400 && took < 15_000, `stopped at the limit, not before and not after the long wait (${took} ms)`);
    const error = events.find((e) => e.type === 'error');
    assert.ok(error, 'an error event was sent');
    assert.match(String(error!.message), /the turn reached the runner's time limit of \d+ minutes and was stopped/);
    assert.ok(events.some((e) => String(e.text ?? '').includes('wall-clock timeout')), 'and the stop was announced');
    // What the portal makes of that text.
    assert.equal(interruptionOf(new Error(`AgentCore kiro-run error: ${error!.message}`))?.kind, 'engine-stopped');
  });
});
