/**
 * The person's Kiro setup (agents, steering, skills) travels to a cloud Kiro run and is written under its home.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kiroConfigPathOk, writeKiroConfigFiles, KIRO_CONFIG_LIMITS } from '../server/agent/runner-files.ts';
import { validatePayload } from '../kiro-runner/src/validate.ts';
import type { KiroRunPayload } from '../kiro-runner/src/validate.ts';

const b64 = (s: string): string => Buffer.from(s).toString('base64');
let home = '';
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-cfg-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('kiro config files', () => {
  it('accepts agents, steering, skills and prompts, and nothing else', () => {
    assert.equal(kiroConfigPathOk('agents/reviewer.json'), true);
    assert.equal(kiroConfigPathOk('steering/style.md'), true);
    assert.equal(kiroConfigPathOk('skills/x/SKILL.md'), true);
    assert.equal(kiroConfigPathOk('settings/mcp.json'), false, 'MCP settings and tokens stay behind');
    assert.equal(kiroConfigPathOk('../agents/a.json'), false);
    assert.equal(kiroConfigPathOk('agents/../../etc/passwd.json'), false);
    assert.equal(kiroConfigPathOk('/agents/a.json'), false);
    assert.equal(kiroConfigPathOk('agents\a.json'), false);
    assert.equal(kiroConfigPathOk('agents/a.exe'), false);
    assert.equal(kiroConfigPathOk('agents//a.json'), false);
  });

  it('writes the files under <home>/.kiro and skips what is not allowed', () => {
    const n = writeKiroConfigFiles(home, [
      { path: 'agents/reviewer.json', data: b64('{"name":"reviewer"}') },
      { path: 'steering/style.md', data: b64('# style') },
      { path: 'settings/mcp.json', data: b64('{"secret":1}') },
      { path: '../escape.json', data: b64('x') },
      { path: 'agents/big.json', data: Buffer.alloc(KIRO_CONFIG_LIMITS.fileBytes + 1).toString('base64') },
      { path: 'agents/nodata.json' },
    ]);
    assert.equal(n, 2);
    assert.equal(fs.readFileSync(path.join(home, '.kiro', 'agents', 'reviewer.json'), 'utf8'), '{"name":"reviewer"}');
    assert.equal(fs.existsSync(path.join(home, '.kiro', 'settings')), false);
    assert.equal(fs.existsSync(path.join(path.dirname(home), 'escape.json')), false);
  });

  it('the runner payload keeps the config and a safe agent name', () => {
    const base = {
      mode: 'kiro-run', runId: 'r1', prompt: 'hi',
      token: { accessToken: 'a', expiresAt: '2030-01-01T00:00:00Z', region: 'us-east-1', startUrl: 'https://d-1.awsapps.com/start' },
    };
    const ok = validatePayload({ ...base, agent: 'reviewer', kiroConfig: [{ path: 'agents/reviewer.json', data: b64('{}') }] });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      const p = ok.payload as KiroRunPayload;
      assert.equal(p.agent, 'reviewer');
      assert.equal(p.kiroConfig?.length, 1);
    }
    const bad = validatePayload({ ...base, agent: '--trust-all-tools' });
    assert.equal(bad.ok && (bad.payload as KiroRunPayload).agent, undefined, 'a flag-looking agent name is dropped');
  });
});
