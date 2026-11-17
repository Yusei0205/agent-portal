/**
 * Plan mode: the agent is told to plan only, and the portal refuses tool calls that change anything.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideToolCall, planModeDenial } from '../server/agent/tool-policy.ts';
import { PLAN_GUIDANCE, withPlanGuidance } from '../server/agent/plan-guidance.ts';

const call = (toolName: string, input: Record<string, unknown>, planMode: boolean) =>
  decideToolCall({ toolName, input, workDir: null, rules: [], trusted: true, allowed: new Set(), planMode });

describe('plan mode guidance', () => {
  it('adds the plan-only instructions every turn, and nothing when it is off', () => {
    assert.equal(withPlanGuidance('Fix it', false), 'Fix it');
    assert.equal(withPlanGuidance('Fix it', true), `Fix it\n\n${PLAN_GUIDANCE}`);
    assert.match(PLAN_GUIDANCE, /plan mode is on/i);
    assert.match(PLAN_GUIDANCE, /\/plan off/);
  });
});

describe('plan mode tool policy', () => {
  it('lets reads, searches and planning aids through', () => {
    for (const t of ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'ExitPlanMode']) {
      assert.equal(planModeDenial(t, {}), null, t);
    }
  });
  it('refuses writes even when tools are trusted', () => {
    for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'str_replace_editor']) {
      const d = call(t, { file_path: 'a.ts' }, true);
      assert.equal(d.action, 'deny', t);
      assert.match((d as { reason: string }).reason, /Plan mode is on/);
    }
  });
  it('allows look-only commands and refuses anything that could change state', () => {
    for (const c of ['ls -la', 'git status', 'git log --oneline -5', 'grep -rn foo src', 'cat package.json', 'pwd']) {
      assert.equal(planModeDenial('Bash', { command: c }), null, c);
    }
    for (const c of ['rm -rf build', 'npm install', 'echo hi > a.txt', 'ls; rm a', 'cat a | sh', 'git commit -m x', 'git branch newone', 'find . -delete', 'ls $(rm a)', 'git push']) {
      assert.ok(planModeDenial('Bash', { command: c }), c);
    }
  });
  it('allows read-looking MCP tools and refuses the rest', () => {
    assert.equal(planModeDenial('mcp__jira__get_issue', {}), null);
    assert.equal(planModeDenial('mcp__jira__search_issues', {}), null);
    assert.ok(planModeDenial('mcp__jira__create_issue', {}));
    assert.ok(planModeDenial('SomethingElse', {}));
  });
  it('changes nothing when plan mode is off', () => {
    assert.notEqual(call('Write', { file_path: 'a.ts' }, false).action, 'deny');
    assert.equal(call('Write', { file_path: 'a.ts' }, false).action, 'allow');
  });
});
