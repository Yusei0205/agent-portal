import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCursorFiles, validateCursorFile, applyCursorRules } from '../server/agent/cursor-config.ts';
import { shouldIncludeLocalFile } from '../server/user-config.ts';

describe('Cursor setup files', () => {
  it('accepts rule files and nothing that runs commands or widens permissions', () => {
    for (const p of ['rules/team.mdc', 'rules/notes.md', 'rules/a-b_c.1.mdc']) validateCursorFile({ path: p, content: 'x' });
    for (const p of ['mcp.json', 'cli-config.json', 'cli.json', 'hooks.json', 'commands/x.md', 'rules/../mcp.json', 'rules/sub/x.mdc', 'rules/x.sh', '../rules/x.mdc', '/rules/x.mdc'])
      assert.throws(() => validateCursorFile({ path: p, content: 'x' }), /Unsupported Cursor setup file/, p);
    assert.throws(() => validateCursorFile({ path: 'rules/big.mdc', content: 'x'.repeat(200_001) }), /200 KB/);
  });

  it('rejects malformed, duplicate (any case) and oversized bundles', () => {
    assert.throws(() => parseCursorFiles('nope'), /Invalid Cursor setup bundle/);
    assert.throws(() => parseCursorFiles([{ path: 'rules/a.mdc' }]), /Invalid Cursor setup file/);
    assert.throws(() => parseCursorFiles([{ path: 'rules/a.mdc', content: '1' }, { path: 'rules/A.mdc', content: '2' }]), /duplicate/i);
    assert.throws(() => parseCursorFiles(Array.from({ length: 101 }, (_, i) => ({ path: `rules/r${i}.mdc`, content: '' }))), /Invalid Cursor setup bundle/);
  });

  it('is what the local importer picks from ~/.cursor, and only that', () => {
    assert.equal(shouldIncludeLocalFile('cursor', 'rules/team.mdc', 100).include, true);
    for (const p of ['mcp.json', 'cli-config.json', 'chats/x/store.db', 'projects/p/worker.log', 'skills-cursor/x.md'])
      assert.equal(shouldIncludeLocalFile('cursor', p, 100).include, false, p);
  });
});

describe('applyCursorRules', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-rules-test-'));
  it('writes rules under portal-user-, replaces earlier ones, and keeps the repository’s own rules', () => {
    const dir = tmp();
    try {
      fs.mkdirSync(path.join(dir, '.cursor', 'rules'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.cursor', 'rules', 'own.mdc'), 'mine');
      assert.equal(applyCursorRules(dir, [{ path: 'rules/a.mdc', content: 'A' }, { path: 'rules/b.md', content: 'B' }]), 2);
      assert.equal(applyCursorRules(dir, [{ path: 'rules/c.mdc', content: 'C' }]), 1);
      assert.deepEqual(fs.readdirSync(path.join(dir, '.cursor', 'rules')).sort(), ['own.mdc', 'portal-user-c.mdc']);
      assert.equal(fs.readFileSync(path.join(dir, '.cursor', 'rules', 'portal-user-c.mdc'), 'utf8'), 'C');
      assert.equal(applyCursorRules(dir, []), 0);
      assert.deepEqual(fs.readdirSync(path.join(dir, '.cursor', 'rules')), ['own.mdc']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses to write through a link', (t) => {
    const dir = tmp(); const outside = tmp();
    try {
      try { fs.symlinkSync(outside, path.join(dir, '.cursor'), 'junction'); } catch { t.skip('links not permitted here'); return; }
      assert.throws(() => applyCursorRules(dir, [{ path: 'rules/a.mdc', content: 'A' }]), /link is in the way/);
      assert.deepEqual(fs.readdirSync(outside), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
  });
});
