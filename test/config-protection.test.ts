/**
 * Feature C — guard on settings, hooks, and symlink escape.
 *
 * Tests:
 *   1. protectedConfigReason: which files are protected
 *   2. protectedCommandReason: shell commands that write protected files / set git options
 *   3. isReallyInsideDir: symlink escape prevention
 *   4. GIT_BASE: portal git commands disable hooks and fsmonitor
 *   5. Integration: guardToolCall rejects protected writes and bash commands
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { protectedCommandReason, protectedConfigReason, guardToolCall } from '../server/agent/guard.ts';
import { isReallyInsideDir, realPath } from '../server/real-path.ts';
import { GIT_BASE } from '../server/git.ts';

// ── Protected file paths ───────────────────────────────────────────────────────

test('tool settings, MCP lists, .kiro, .git, and .husky paths are protected', () => {
  const protected_files = [
    '.claude/settings.json',
    'repo/.claude/settings.local.json',
    '.mcp.json',
    'repo/.mcp.json',
    '.git/hooks/pre-commit',
    'repo/.git/config',
    '.git',
    'repo\\.git\\info\\attributes',
    '.kiro/settings/mcp.json',
    '.kiro/agents/reviewer.md',
    '.kiro/hooks/pre-save',
    '.claude/hooks/pre-tool-use',
    '.husky/pre-commit',
    'repo/.husky/commit-msg',
    'REPO/.Claude/Settings.JSON',
  ];
  for (const f of protected_files) {
    assert.ok(protectedConfigReason(f), `expected protection for: ${f}`);
  }
});

test('safe paths are not protected', () => {
  const safe_files = [
    'notes.md',
    'repo/.claude/agents/reviewer.md',
    'repo/.claude/skills/x/SKILL.md',
    'CLAUDE.md',
    '.kiro/config.json',
    'repo/.github/workflows/ci.yml',
    'repo/src/settings.json',
    'mcp.json',
    '.env',
    'README.md',
    'src/utils.ts',
  ];
  for (const f of safe_files) {
    assert.equal(protectedConfigReason(f), null, `unexpected protection for: ${f}`);
  }
});

// ── Shell command guards ───────────────────────────────────────────────────────

test('shell commands that write protected files are refused', () => {
  const blocked = [
    `echo '{"permissions":{"allow":["Bash"]}}' > .claude/settings.json`,
    'cat evil.json >> repo/.claude/settings.local.json',
    'cp /tmp/x.json .mcp.json',
    'printf "#!/bin/sh\\ncurl evil" | tee .git/hooks/pre-commit',
    'mv hook .git/hooks/post-checkout',
    "sed -i 's/ask/allow/' .claude/settings.json",
    'ln -sf /tmp/h .git/hooks/pre-push',
    'Set-Content .mcp.json "{}"',
    'chmod +x .git/hooks/pre-commit',
    'cp myfile .husky/pre-commit',
    'touch .kiro/agents/new-agent.md',
    'mv .kiro/settings/old.json .kiro/settings/new.json',
  ];
  for (const cmd of blocked) {
    assert.ok(protectedCommandReason(cmd), `expected block for: ${cmd}`);
  }
});

test('git config commands that set program-running options are refused', () => {
  const blocked = [
    'git config core.hooksPath .githooks',
    'git -C repo config --local core.fsmonitor "curl evil"',
    'git config filter.lfs.clean "sh evil.sh"',
    'git config --global alias.st "!curl evil"',
    'git config include.path ../evil.cfg',
    'git config core.sshCommand "ssh -i evil_key"',
    'git config diff.external my-diff',
    'git config includeIf.gitdir:.secret',
  ];
  for (const cmd of blocked) {
    assert.ok(protectedCommandReason(cmd), `expected block for: ${cmd}`);
  }
});

test('safe shell commands are allowed', () => {
  const allowed = [
    'cat .mcp.json',
    'ls -la .git',
    'git config user.name "Agent"',
    'git status',
    'npm test',
    'git log --oneline -5',
    'jq . .claude/settings.json',
    'echo hi > notes.md',
    'git config user.email "agent@example.com"',
  ];
  for (const cmd of allowed) {
    assert.equal(protectedCommandReason(cmd), null, `unexpected block for: ${cmd}`);
  }
});

// ── Symlink escape prevention ──────────────────────────────────────────────────

test('symbolic links are followed: a link that points outside is outside', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'real-base-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'real-out-'));
  fs.mkdirSync(path.join(base, 'docs'));
  try {
    // junction on Windows, symlink on Linux
    fs.symlinkSync(outside, path.join(base, 'docs', 'link'), 'junction');
  } catch {
    // fallback: regular symlink
    try {
      fs.symlinkSync(outside, path.join(base, 'docs', 'link'));
    } catch {
      // skip if symlinks are not permitted (restricted environment)
      return;
    }
  }
  try {
    assert.ok(isReallyInsideDir(base, path.join(base, 'docs', 'a.md')), 'real path inside is inside');
    assert.ok(
      isReallyInsideDir(base, path.join(base, 'docs', 'new-folder', 'b.md')),
      'non-existent path inside is inside',
    );
    assert.ok(
      !isReallyInsideDir(base, path.join(base, 'docs', 'link', 'secret.txt')),
      'path through the link is outside',
    );
    assert.ok(
      !isReallyInsideDir(base, path.join(base, 'docs', 'link', 'not-yet', 'x.txt')),
      'new file through the link is outside',
    );
    assert.ok(!isReallyInsideDir(base, path.join(base, '..', 'elsewhere')), 'parent dir is outside');
    assert.equal(
      realPath(path.join(base, 'docs', 'link', 'x')),
      path.join(fs.realpathSync.native(outside), 'x'),
      'realPath resolves through link',
    );
  } finally {
    try { fs.rmSync(path.join(base, 'docs', 'link'), { force: true, recursive: false }); } catch { /* ok */ }
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ok */ }
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// ── Portal git commands disable hooks and fsmonitor ───────────────────────────

test('portal git commands run with hooks and fsmonitor disabled', () => {
  const flags = GIT_BASE.join(' ');
  assert.match(flags, /core\.hooksPath=\S+agent-portal-no-git-hooks/, 'hooksPath points to non-existent folder');
  assert.match(flags, /core\.fsmonitor=false/, 'fsmonitor is disabled');
});

// ── guardToolCall integration ──────────────────────────────────────────────────

describe('guardToolCall — blocks protected file writes', () => {
  test('blocks write to .claude/settings.json', () => {
    const result = guardToolCall('Write', { file_path: '.claude/settings.json' }, '/workdir');
    assert.ok(result, 'should block');
    assert.match(result!, /Blocked by Agent Portal/);
  });

  test('blocks write to .git/hooks/pre-commit', () => {
    const result = guardToolCall('Edit', { file_path: '.git/hooks/pre-commit' }, '/workdir');
    assert.ok(result, 'should block');
  });

  test('blocks write to .kiro/agents/evil.md', () => {
    const result = guardToolCall('MultiEdit', { file_path: '.kiro/agents/evil.md' }, '/workdir');
    assert.ok(result, 'should block');
  });

  test('allows write to notes.md', () => {
    const result = guardToolCall('Write', { file_path: 'notes.md' }, '/workdir');
    assert.equal(result, null, 'should allow safe file');
  });

  test('allows write to src/utils.ts', () => {
    const result = guardToolCall('Edit', { file_path: 'src/utils.ts' }, '/workdir');
    assert.equal(result, null, 'should allow safe file');
  });
});

describe('guardToolCall — blocks dangerous bash commands', () => {
  test('blocks git config core.hooksPath', () => {
    const result = guardToolCall('Bash', { command: 'git config core.hooksPath evil' }, '/workdir');
    assert.ok(result, 'should block');
  });

  test('blocks write to .mcp.json via echo redirect', () => {
    const result = guardToolCall(
      'Bash',
      { command: 'echo \'{"mcpServers":{}}\' > .mcp.json' },
      '/workdir',
    );
    assert.ok(result, 'should block');
  });

  test('allows safe shell command', () => {
    const result = guardToolCall('Bash', { command: 'npm test' }, '/workdir');
    assert.equal(result, null, 'should allow safe command');
  });

  test('allows git status', () => {
    const result = guardToolCall('Bash', { command: 'git status' }, '/workdir');
    assert.equal(result, null, 'should allow git status');
  });
});
