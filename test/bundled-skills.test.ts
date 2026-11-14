/**
 * The skills bundled with the portal (frontend-design, caveman, security-guidance): what is written into a project, and that a
 * person's edits and deletions are respected.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUNDLED_SKILLS, ensureBundledSkills } from '../server/bundled-skills.ts';
import { skillReader, SKILL_NAME } from '../server/agent/agent-defs.ts';

describe('bundled skills', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-skills-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const skills = () => path.join(dir, '.claude', 'skills');

  it('ships the three skills, each with its licence and a notice of where it came from', () => {
    assert.deepEqual(BUNDLED_SKILLS.map((s) => s.name).sort(), ['caveman', 'frontend-design', 'security-guidance']);
    for (const s of BUNDLED_SKILLS) {
      assert.match(s.name, SKILL_NAME);
      assert.deepEqual(Object.keys(s.files).sort(), ['LICENSE.txt', 'NOTICE.txt', 'SKILL.md']);
      assert.match(s.files['LICENSE.txt'], /Apache License\s+Version 2\.0/);
      assert.match(s.files['NOTICE.txt'], /anthropics\/claude-plugins-official|JuliusBrussee\/caveman/);
      const front = /^---\n([\s\S]*?)\n---\n/.exec(s.files['SKILL.md']);
      assert.ok(front, `${s.name} has front matter`);
      assert.match(front[1], new RegExp(`^name: ${s.name}$`, 'm'));
      assert.match(front[1], /^description:/m);
    }
  });

  it('writes them into .claude/skills, and the agent skill reader can load each one', async () => {
    const written = await ensureBundledSkills(dir);
    assert.deepEqual(written.sort(), ['caveman', 'frontend-design', 'security-guidance']);
    const read = skillReader([skills()]);
    for (const name of written) {
      assert.ok(fs.existsSync(path.join(skills(), name, 'LICENSE.txt')));
      const text = read(name);
      assert.ok(text && text.length > 500, `${name} has instructions`);
      assert.doesNotMatch(String(text), /^---/, 'the front matter is not part of the instructions');
    }
    assert.match(String(read('security-guidance')), /execFile\(/);
    assert.match(String(read('security-guidance')), /\^\[0-9\]\+\$/);
    assert.match(String(read('caveman')), /Answer first/);
    assert.match(String(read('frontend-design')), /Typography/);
  });

  it('seeds each skill once: an edit is kept, a deleted skill stays deleted, a second run writes nothing', async () => {
    await ensureBundledSkills(dir);
    fs.writeFileSync(path.join(skills(), 'caveman', 'SKILL.md'), '# my own caveman\n');
    fs.rmSync(path.join(skills(), 'frontend-design'), { recursive: true });
    const again = await ensureBundledSkills(dir);
    assert.deepEqual(again, []);
    assert.equal(fs.readFileSync(path.join(skills(), 'caveman', 'SKILL.md'), 'utf8'), '# my own caveman\n');
    assert.equal(fs.existsSync(path.join(skills(), 'frontend-design')), false);
    assert.equal(fs.existsSync(path.join(skills(), 'security-guidance', 'SKILL.md')), true);
  });

  it('leaves a skill folder of the same name that someone already made', async () => {
    fs.mkdirSync(path.join(skills(), 'caveman'), { recursive: true });
    fs.writeFileSync(path.join(skills(), 'caveman', 'SKILL.md'), '# theirs\n');
    const written = await ensureBundledSkills(dir);
    assert.deepEqual(written.sort(), ['frontend-design', 'security-guidance']);
    assert.equal(fs.readFileSync(path.join(skills(), 'caveman', 'SKILL.md'), 'utf8'), '# theirs\n');
    assert.equal(fs.existsSync(path.join(skills(), 'caveman', 'LICENSE.txt')), false);
  });
});
