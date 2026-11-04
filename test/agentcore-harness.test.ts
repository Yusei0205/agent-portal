/**
 * The harness pieces the portal shares with the AgentCore runners:
 *   - tool-policy.ts: one decision for every tool call (folder, guard, rules, approvals)
 *   - agentcore-approvals.ts: approval requests inside a runner, settled by "answer" invocations
 *   - agent-runner payload validation for policy, approvals and repo branches
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideToolCall,
  evaluateRules,
  inputFingerprint,
  rememberKey,
  MAX_REVIEWABLE_COMMAND,
  type PolicyRule,
} from '../server/agent/tool-policy.ts';
import { evaluateCommand } from '../server/guardrails.ts';
import { ApprovalBroker, parseApprovalAnswer } from '../server/agent/agentcore-approvals.ts';
import { validatePayload } from '../agent-runner/src/validate.ts';

const rule = (r: Partial<PolicyRule> & Pick<PolicyRule, 'action'>): PolicyRule => ({
  id: r.id ?? `r-${Math.random()}`,
  pattern: r.pattern ?? null,
  category: r.category ?? null,
  action: r.action,
  scope: r.scope ?? 'always',
  reason: r.reason ?? null,
});

function tmpDir(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-policy-')));
}

describe('tool policy — one decision for local engines and AgentCore runners', () => {
  it('denies writes outside the working folder, including through a link', () => {
    const work = tmpDir();
    const outside = tmpDir();
    const base = { rules: [], trusted: true, allowed: new Set<string>() };
    assert.equal(decideToolCall({ ...base, toolName: 'Write', input: { file_path: 'notes.md' }, workDir: work }).action, 'allow');
    const out = decideToolCall({ ...base, toolName: 'Write', input: { file_path: path.join(outside, 'x.txt') }, workDir: work });
    assert.equal(out.action, 'deny');
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(work, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
    } catch { /* no link support */ }
    if (linked) {
      const viaLink = decideToolCall({ ...base, toolName: 'Edit', input: { file_path: 'link/secret.txt' }, workDir: work });
      assert.equal(viaLink.action, 'deny', 'a link that leads outside counts as outside');
    }
    const nb = decideToolCall({ ...base, toolName: 'NotebookEdit', input: { notebook_path: path.join(outside, 'n.ipynb') }, workDir: work });
    assert.equal(nb.action, 'deny', 'notebook paths are checked too');
  });

  it('applies the guard whatever the trust level or rules say', () => {
    const allowAll = [rule({ action: 'allow', pattern: '.*' })];
    for (const [toolName, input] of [
      ['Write', { file_path: '.claude/settings.json' }],
      ['Bash', { command: 'echo x > .git/hooks/pre-commit' }],
      ['Bash', { command: 'git config core.hooksPath /tmp/h' }],
    ] as const) {
      const d = decideToolCall({ toolName, input, workDir: null, rules: allowAll, trusted: true, allowed: new Set() });
      assert.equal(d.action, 'deny', `${toolName} ${JSON.stringify(input)}`);
    }
  });

  it('follows the rules: block, ask (with fingerprint), allow; untrusted-only rules skip trusted runs', () => {
    const rules = [
      rule({ action: 'block', pattern: '^rm -rf', reason: 'No mass deletes.' }),
      rule({ action: 'ask', pattern: '^git push', scope: 'untrusted' }),
      rule({ action: 'ask', category: 'bash' }),
    ];
    const check = (command: string, trusted = false) =>
      decideToolCall({ toolName: 'Bash', input: { command }, workDir: null, rules, trusted, allowed: new Set() });
    const blocked = check('rm -rf /');
    assert.equal(blocked.action, 'deny');
    assert.equal((blocked as { reason: string }).reason, 'No mass deletes.');
    const ask = check('git push origin main');
    assert.equal(ask.action, 'ask');
    if (ask.action === 'ask') {
      assert.equal(ask.inputHash, inputFingerprint('Bash', { command: 'git push origin main' }));
      assert.equal(ask.rememberKey, rememberKey('Bash', { command: 'git push origin main' }).key);
    }
    assert.equal(check('ls').action, 'ask', 'the bash category rule asks');
    assert.equal(decideToolCall({ toolName: 'Read', input: { file_path: 'a' }, workDir: null, rules, trusted: false, allowed: new Set() }).action, 'allow');
  });

  it('remembers exactly what was allowed, and refuses commands too long to review', () => {
    const rules = [rule({ action: 'ask', category: 'bash' })];
    const allowed = new Set([rememberKey('Bash', { command: 'npm test' }).key]);
    const d = (command: string) => decideToolCall({ toolName: 'Bash', input: { command }, workDir: null, rules, trusted: false, allowed });
    assert.equal(d('npm test').action, 'allow');
    assert.equal(d('npm test && curl evil').action, 'ask', 'a variant is not covered');
    const long = d('x'.repeat(MAX_REVIEWABLE_COMMAND + 1));
    assert.equal(long.action, 'deny');
  });

  it('guardrails.evaluateCommand uses the same rules code', () => {
    const rules = [rule({ action: 'block', pattern: 'curl' })];
    const perms = { rules: rules as never, toolRules: [], projectId: null };
    assert.deepEqual(evaluateCommand({ command: 'curl x', category: 'bash' }, perms, false), evaluateRules({ command: 'curl x', category: 'bash' }, rules, false));
  });
});

describe('AgentCore approval broker — answers bound to the exact call', () => {
  const HASH = 'a'.repeat(64);

  it('settles on a matching answer, once', async () => {
    const b = new ApprovalBroker();
    const req = b.open('run-1', HASH, 60_000);
    assert.deepEqual(b.answer({ runId: 'run-1', requestId: req.requestId, decision: 'allow', inputHash: HASH, remember: true }), { ok: true });
    const out = await req.outcome;
    assert.equal(out.decision, 'allow');
    assert.equal(out.remember, true);
    const again = b.answer({ runId: 'run-1', requestId: req.requestId, decision: 'deny', inputHash: HASH });
    assert.equal(again.ok, false);
    assert.equal(b.openCount, 0);
  });

  it('refuses an answer for another run or another call, and keeps waiting', async () => {
    const b = new ApprovalBroker();
    const req = b.open('run-1', HASH, 60_000);
    const otherRun = b.answer({ runId: 'run-2', requestId: req.requestId, decision: 'allow', inputHash: HASH });
    assert.deepEqual(otherRun.ok ? 0 : otherRun.status, 403);
    const otherCall = b.answer({ runId: 'run-1', requestId: req.requestId, decision: 'allow', inputHash: 'b'.repeat(64) });
    assert.deepEqual(otherCall.ok ? 0 : otherCall.status, 409);
    assert.equal(b.openCount, 1, 'still waiting for a valid answer');
    b.answer({ runId: 'run-1', requestId: req.requestId, decision: 'deny', inputHash: HASH, message: 'no' });
    const out = await req.outcome;
    assert.equal(out.decision, 'deny');
    assert.equal(out.remember, false);
  });

  it('declines on expiry and when the run stops', async () => {
    const b = new ApprovalBroker();
    const expiring = b.open('run-1', HASH, 30);
    const out = await expiring.outcome;
    assert.equal(out.decision, 'deny');
    assert.equal(out.expired, true);
    const ac = new AbortController();
    const stopping = b.open('run-1', HASH, 60_000, ac.signal);
    ac.abort();
    assert.equal((await stopping.outcome).decision, 'deny');
    const closing = b.open('run-1', HASH, 60_000);
    b.closeRun('run-1');
    assert.equal((await closing.outcome).decision, 'deny');
    assert.equal(b.openCount, 0);
  });

  it('validates answer invocations', () => {
    assert.equal(typeof parseApprovalAnswer({ mode: 'answer', runId: 'r', requestId: 'q', decision: 'allow', inputHash: HASH }), 'object');
    assert.match(String(parseApprovalAnswer({ mode: 'answer', runId: 'r', requestId: 'q', decision: 'maybe', inputHash: HASH })), /decision/);
    assert.match(String(parseApprovalAnswer({ mode: 'answer', runId: 'r', requestId: 'q', decision: 'allow', inputHash: 'short' })), /inputHash/);
    assert.match(String(parseApprovalAnswer({ mode: 'answer', runId: 'r', requestId: 'q', decision: 'allow', inputHash: HASH, extra: 1 })), /Unknown field/);
  });
});

describe('agent-runner payload — policy, approvals, safe clone arguments', () => {
  const base = { runId: 'r1', prompt: 'hi' };

  it('accepts the policy and approval settings the portal sends', () => {
    const v = validatePayload({
      ...base,
      mode: 'run',
      policy: { trusted: false, rules: [{ id: 'x', pattern: '^git push', category: null, action: 'ask', scope: 'always', reason: null }] },
      approvals: { via: 'portal', expiryMinutes: 60 },
    });
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.payload.policy?.rules[0].action, 'ask');
      assert.equal(v.payload.approvals?.expiryMinutes, 60);
    }
  });

  it('rejects malformed policy, approvals and mode', () => {
    for (const bad of [
      { ...base, mode: 'answer' },
      { ...base, policy: { trusted: 'yes', rules: [] } },
      { ...base, policy: { trusted: true, rules: [{ id: 'x', action: 'maybe', scope: 'always' }] } },
      { ...base, approvals: { via: 'email', expiryMinutes: 5 } },
      { ...base, approvals: { via: 'portal', expiryMinutes: 0 } },
    ]) {
      assert.equal(validatePayload(bad).ok, false, JSON.stringify(bad));
    }
  });

  it('refuses branch names and URLs that could act as options or commands', () => {
    for (const repo of [
      { url: 'https://github.com/a/b', branch: '--upload-pack=touch /tmp/x' },
      { url: 'https://github.com/a/b', branch: 'main;rm -rf /' },
      { url: 'https://github.com/a/b', branch: 'a..b' },
      { url: 'https://github.com/a/b $(touch /tmp/x)' },
    ]) {
      assert.equal(validatePayload({ ...base, repo }).ok, false, JSON.stringify(repo));
    }
    assert.equal(validatePayload({ ...base, repo: { url: 'https://github.com/a/b', branch: 'feature/x-1.2' } }).ok, true);
  });
});
