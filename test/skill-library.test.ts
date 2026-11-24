/** Skills loaded on demand: the library a run carries, what read_skill returns, the index in an agent's prompt, and the tool policy. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillLibrary, readSkillResult, skillIndexSection, SKILL_TOOL_FULL_NAME, SKILL_LIBRARY_LIMITS } from '../server/agent/skill-library.ts';
import { decideToolCall } from '../server/agent/tool-policy.ts';

describe('skill library', () => {
  it('keeps valid names with text bodies and drops everything else', () => {
    const lib = parseSkillLibrary({ 'backend-python': 'Use FastAPI.', 'Bad Name': 'x', empty: '  ', num: 5, '../etc': 'x' });
    assert.deepEqual(lib, { 'backend-python': 'Use FastAPI.' });
    assert.deepEqual(parseSkillLibrary(null), {});
    assert.deepEqual(parseSkillLibrary(['a']), {});
  });

  it('caps the number of skills, each body and the total', () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`s${i}`, 'x']));
    assert.equal(Object.keys(parseSkillLibrary(many)).length, SKILL_LIBRARY_LIMITS.skills);
    assert.equal(parseSkillLibrary({ big: 'y'.repeat(50_000) }).big!.length, SKILL_LIBRARY_LIMITS.bodyChars);
    const heavy = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`h${i}`, 'z'.repeat(39_000)]));
    const total = Object.values(parseSkillLibrary(heavy)).reduce((t, b) => t + b.length, 0);
    assert.ok(total <= SKILL_LIBRARY_LIMITS.totalChars, String(total));
  });

  it('read_skill returns the skill, or the names that exist', () => {
    const lib = { 'backend-python': 'Use FastAPI.', 'api-design': 'Contract first.' };
    assert.deepEqual(readSkillResult(lib, 'backend-python'), { text: '# Skill: backend-python\n\nUse FastAPI.', found: true });
    assert.equal(readSkillResult(lib, '$api-design').found, true, 'a Codex-style $name works too');
    const miss = readSkillResult(lib, 'backend-go');
    assert.equal(miss.found, false);
    assert.match(miss.text, /no skill named "backend-go".*api-design, backend-python/);
    assert.equal(readSkillResult(lib, { name: 'x' }).found, false);
    assert.equal(readSkillResult({}, 'x').text, 'There is no skill named "x". Skills you can read: none.');
    assert.equal(readSkillResult(lib, 'toString').found, false, 'no prototype keys');
  });

  it('the index names each skill with its description and tells the agent to load before working', () => {
    assert.equal(skillIndexSection([]), '');
    const s = skillIndexSection([{ name: 'backend-python', description: 'Python back ends.\nUse for FastAPI work.' }]);
    assert.match(s, /# Skills you can load/);
    assert.match(s, /call the read_skill tool/);
    assert.match(s, /- backend-python: Python back ends\. Use for FastAPI work\./);
  });

  it('the tool policy allows read_skill without asking, also in plan mode', () => {
    const base = { input: { name: 'backend-python' }, rules: [], trusted: false, allowed: new Set<string>(), workDir: '/tmp/w' };
    assert.equal(SKILL_TOOL_FULL_NAME, 'mcp__portal-skills__read_skill');
    assert.deepEqual(decideToolCall({ ...base, toolName: SKILL_TOOL_FULL_NAME } as Parameters<typeof decideToolCall>[0]), { action: 'allow' });
    assert.deepEqual(decideToolCall({ ...base, toolName: SKILL_TOOL_FULL_NAME, planMode: true } as Parameters<typeof decideToolCall>[0]), { action: 'allow' });
  });
});
