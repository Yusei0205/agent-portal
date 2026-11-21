/**
 * The runner sends the turn's Kiro credits to the portal when kiro-cli reports them the way the real one does: in the turn-end
 * `_kiro.dev/metadata` notification, with no standard usage_update at all. (The fake kiro-cli used to send only a usage_update, which
 * real Kiro never does, so everything passed while every real run recorded 0 credits.) Real runner code against the fake kiro-cli.
 * Needs a shell script on the PATH, so Linux and macOS only.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const runnerDir = path.join(here, '..', 'kiro-runner');
if (process.platform !== 'win32' && !fs.existsSync(path.join(runnerDir, 'shared', 'runner-files.ts'))) {
  execFileSync(process.execPath, ['build.mjs'], { cwd: runnerDir, stdio: 'inherit' });
}
const { runKiroRun, disposeWarmKiro } = await import(pathToFileURL(path.join(runnerDir, 'src', 'run.ts')).href) as {
  runKiroRun(payload: unknown, emit: (e: Record<string, unknown>) => void, startMs: number): Promise<void>;
  disposeWarmKiro(): Promise<void>;
};
const skip = process.platform === 'win32' ? 'needs a kiro-cli shell script on the PATH' : false;

describe('Kiro runner: credits from the metadata notification', { skip }, () => {
  let bin = '';
  const saved = { PATH: process.env.PATH, SC: process.env.PORTAL_FAKE_KIRO_SCENARIO };
  before(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-kiro-bin-'));
    fs.writeFileSync(path.join(bin, 'kiro-cli'), `#!/bin/sh\nexec node ${JSON.stringify(path.join(here, 'fake-kiro.mjs'))} "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  });
  after(async () => {
    await disposeWarmKiro();
    process.env.PATH = saved.PATH;
    if (saved.SC === undefined) delete process.env.PORTAL_FAKE_KIRO_SCENARIO; else process.env.PORTAL_FAKE_KIRO_SCENARIO = saved.SC;
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it('sends a usage event with the sum of the per-call entries of the turn, and none for the frame that only has the context percentage', async () => {
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-metering';
    const events: Array<Record<string, unknown>> = [];
    await runKiroRun({
      mode: 'kiro-run', runId: 'metering-1', prompt: 'do the thing',
      token: { accessToken: 'a', expiresAt: '2030-01-01T00:00:00Z', region: 'us-east-1', startUrl: 'https://d-1.awsapps.com/start' },
    }, (e) => { events.push(e); }, Date.now());
    const usage = events.filter((e) => e.type === 'usage');
    assert.equal(usage.length, 1, JSON.stringify(usage));
    assert.ok(Math.abs(Number(usage[0].credits) - 0.35) < 1e-9, `0.1 + 0.25, got ${usage[0].credits}`);
    assert.ok(events.some((e) => e.type === 'context'), 'and the context percentage still comes through');
  });
});
