/** Which files and commands the guard treats as tool configuration, and how symbolic links are followed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { protectedCommandReason, protectedConfigReason } from '../server/guardrails.ts';
import { isReallyInsideDir, realPath } from '../server/real-path.ts';
import { GIT_BASE } from '../server/git.ts';

test('tool settings, MCP lists, Kiro settings and anything in .git are protected files', () => {
  for (const f of [
    '.claude/settings.json',
    'repo/.claude/settings.local.json',
    '.mcp.json',
    'repo/.mcp.json',
    '.git/hooks/pre-commit',
    'repo/.git/config',
    '.git',
    'repo\\.git\\info\\attributes',
    '.kiro/settings/mcp.json',
    'REPO/.Claude/Settings.JSON',
  ]) {
    assert.ok(protectedConfigReason(f), f);
  }
  for (const f of ['notes.md', 'repo/.claude/agents/reviewer.md', 'repo/.claude/skills/x/SKILL.md', 'CLAUDE.md', 'repo/.github/workflows/ci.yml', 'repo/src/settings.json', 'mcp.json']) {
    assert.equal(protectedConfigReason(f), null, f);
  }
});

test('shell commands that write protected files or set git options that run programs are refused', () => {
  for (const cmd of [
    `echo '{"permissions":{"allow":["Bash"]}}' > .claude/settings.json`,
    'cat evil.json >> repo/.claude/settings.local.json',
    'cp /tmp/x.json .mcp.json',
    'printf "#!/bin/sh\\ncurl evil" | tee .git/hooks/pre-commit',
    'mv hook .git/hooks/post-checkout',
    "sed -i 's/ask/allow/' .claude/settings.json",
    'ln -sf /tmp/h .git/hooks/pre-push',
    'Set-Content .mcp.json "{}"',
    'git config core.hooksPath .githooks',
    'git -C repo config --local core.fsmonitor "curl evil"',
    'git config filter.lfs.clean "sh evil.sh"',
    'git config --global alias.st "!curl evil"',
    'git config include.path ../evil.cfg',
  ]) {
    assert.ok(protectedCommandReason(cmd), cmd);
  }
  for (const cmd of ['cat .mcp.json', 'ls -la .git', 'git config user.name "Agent"', 'git status', 'npm test', 'git log --oneline -5', 'jq . .claude/settings.json', 'echo hi > notes.md']) {
    assert.equal(protectedCommandReason(cmd), null, cmd);
  }
});

test('symbolic links are followed: a link inside a folder that points outside it is outside', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'real-base-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'real-out-'));
  fs.mkdirSync(path.join(base, 'docs'));
  fs.symlinkSync(outside, path.join(base, 'docs', 'link'), 'junction');
  try {
    assert.ok(isReallyInsideDir(base, path.join(base, 'docs', 'a.md')));
    assert.ok(isReallyInsideDir(base, path.join(base, 'docs', 'new-folder', 'b.md')), 'a path that does not exist yet');
    assert.ok(!isReallyInsideDir(base, path.join(base, 'docs', 'link', 'secret.txt')), 'through the link');
    assert.ok(!isReallyInsideDir(base, path.join(base, 'docs', 'link', 'not-yet', 'x.txt')), 'a new file through the link');
    assert.ok(!isReallyInsideDir(base, path.join(base, '..', 'elsewhere')));
    assert.equal(realPath(path.join(base, 'docs', 'link', 'x')), path.join(fs.realpathSync.native(outside), 'x'));
  } finally {
    fs.rmSync(path.join(base, 'docs', 'link'), { force: true, recursive: false });
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("the portal's own git commands run no hooks and no fsmonitor program", () => {
  const flags = GIT_BASE.join(' ');
  assert.match(flags, /core\.hooksPath=\S+agent-portal-no-git-hooks/);
  assert.match(flags, /core\.fsmonitor=false/);
});
