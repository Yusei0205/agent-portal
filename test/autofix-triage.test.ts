import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triage, type TriageContext } from '../server/autofix/triage.ts';
import { DEFAULT_POLICY, type AutofixPolicy } from '../server/autofix/policy.ts';
import type { AutofixFinding } from '../server/repositories/autofix-findings.ts';

const NOW = new Date('2026-11-17T12:00:00Z');
const policy = (o: Partial<AutofixPolicy> = {}): AutofixPolicy => ({ ...JSON.parse(JSON.stringify(DEFAULT_POLICY)), mode: 'draft_pr', ...o });
const finding = (o: Partial<AutofixFinding> = {}): AutofixFinding => ({
  id: 'f1', project_id: 'p1', source: 'ci' as AutofixFinding['source'], kind: 'tests', fingerprint: 'fp', severity: 'low', evidence: '',
  status: 'new' as AutofixFinding['status'], repo_id: null, branch: 'main', commit_sha: null, workflow_id: null, fix_branch: null, pr_number: null,
  pr_url: null, attempts: 0, occurrences: 1, cost_usd: 0, cooldown_until: null, pr_branch: null, pr_head_sha: null, previous_attempt: null, created_at: '', updated_at: '', ...o,
});
const ctx = (o: Partial<TriageContext> = {}): TriageContext => ({ paused: false, openPrCount: 0, costTodayUsd: 0, defaultBranch: 'main', portalPrBranches: ['portal/pr-1'], now: NOW, ...o });

test('mode off is suppressed', () => {
  assert.equal(triage(finding(), policy({ mode: 'off' }), ctx()).decision, 'suppressed');
});
test('paused is deferred', () => {
  assert.equal(triage(finding(), policy(), ctx({ paused: true })).decision, 'deferred');
});
test('class not allowed is suppressed', () => {
  assert.equal(triage(finding({ kind: 'security' }), policy(), ctx()).decision, 'suppressed');
});
test('branch not eligible is suppressed', () => {
  assert.equal(triage(finding({ branch: 'feature/x' }), policy(), ctx()).decision, 'suppressed');
  const p = policy(); p.branches.default_branch = false;
  assert.equal(triage(finding({ branch: 'main' }), p, ctx()).decision, 'suppressed');
});
test('branch eligibility: null is default, portal PR branches, extra globs', () => {
  assert.equal(triage(finding({ branch: null }), policy(), ctx()).decision, 'triaged');
  assert.equal(triage(finding({ branch: 'portal/pr-1' }), policy(), ctx()).decision, 'triaged');
  const off = policy(); off.branches.portal_prs = false;
  assert.equal(triage(finding({ branch: 'portal/pr-1' }), off, ctx()).decision, 'suppressed');
  const extra = policy(); extra.branches.extra = ['release/*']; extra.branches.default_branch = false; extra.branches.portal_prs = false;
  assert.equal(triage(finding({ branch: 'release/1.0' }), extra, ctx()).decision, 'triaged');
  assert.equal(triage(finding({ branch: 'hotfix/1' }), extra, ctx()).decision, 'suppressed');
});
test('a null branch that is not eligible gives a no-branch reason', () => {
  const p = policy(); p.branches.default_branch = false;
  const r = triage(finding({ branch: null }), p, ctx());
  assert.equal(r.decision, 'suppressed');
  assert.match((r as { reason: string }).reason, /no branch recorded/);
});
test('future cooldown_until is deferred, past cooldown is not', () => {
  const r = triage(finding({ cooldown_until: '2026-11-17T13:00:00Z' }), policy(), ctx());
  assert.equal(r.decision, 'deferred');
  assert.equal(triage(finding({ cooldown_until: '2026-11-17T11:00:00Z' }), policy(), ctx()).decision, 'triaged');
});
test('attempts at max_attempts is needs_human', () => {
  assert.equal(triage(finding({ attempts: 2 }), policy(), ctx()).decision, 'needs_human');
});
test('open PR cap reached is deferred', () => {
  assert.equal(triage(finding(), policy(), ctx({ openPrCount: 3 })).decision, 'deferred');
});
test('daily cost cap reached is deferred', () => {
  assert.equal(triage(finding(), policy(), ctx({ costTodayUsd: 10 })).decision, 'deferred');
});
test('per-finding cost cap reached goes to a person (needs_human, cost limit reached), not deferred forever', () => {
  const r = triage(finding({ cost_usd: 2 }), policy(), ctx());
  assert.equal(r.decision, 'needs_human');
  assert.equal((r as { reason: string }).reason, 'cost limit reached');
});
test('a portal/ branch (a PR the portal opened) is eligible when portal_prs is on, not otherwise', () => {
  const none = ctx({ portalPrBranches: [] });
  assert.equal(triage(finding({ branch: 'portal/RLP-12-fix-login' }), policy(), none).decision, 'triaged');
  const off = policy(); off.branches.portal_prs = false;
  assert.equal(triage(finding({ branch: 'portal/RLP-12-fix-login' }), off, none).decision, 'suppressed');
  assert.equal(triage(finding({ branch: 'portalx/y' }), policy(), none).decision, 'suppressed');
});
test("a finding on the default branch with kind 'tests' in mode draft_pr is triaged", () => {
  assert.deepEqual(triage(finding(), policy(), ctx()), { decision: 'triaged' });
});
test('precedence: the first rule in order wins', () => {
  const all = finding({ kind: 'security', branch: 'x', cooldown_until: '2027-01-01T00:00:00Z', attempts: 9, cost_usd: 99 });
  const c = ctx({ paused: true, openPrCount: 9, costTodayUsd: 99 });
  assert.equal(triage(all, policy({ mode: 'off' }), c).decision, 'suppressed');
  const r1 = triage(all, policy(), c);
  assert.equal(r1.decision, 'deferred'); assert.match((r1 as { reason: string }).reason, /paus/i);
  const r2 = triage(all, policy(), { ...c, paused: false });
  assert.equal(r2.decision, 'suppressed'); assert.match((r2 as { reason: string }).reason, /class/i);
  const r3 = triage({ ...all, kind: 'tests' }, policy(), { ...c, paused: false });
  assert.equal(r3.decision, 'suppressed'); assert.match((r3 as { reason: string }).reason, /branch/i);
  const r4 = triage({ ...all, kind: 'tests', branch: 'main' }, policy(), { ...c, paused: false });
  assert.equal(r4.decision, 'deferred'); assert.match((r4 as { reason: string }).reason, /cooldown/i);
  const r5 = triage({ ...all, kind: 'tests', branch: 'main', cooldown_until: null }, policy(), { ...c, paused: false });
  assert.equal(r5.decision, 'needs_human');
  const r6 = triage({ ...all, kind: 'tests', branch: 'main', cooldown_until: null, attempts: 0 }, policy(), { ...c, paused: false });
  assert.equal(r6.decision, 'deferred'); assert.match((r6 as { reason: string }).reason, /open PR/i);
});
