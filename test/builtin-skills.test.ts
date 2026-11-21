/**
 * The built-in agentcore-browser skill: it is valid for Kiro, it only names tools the browser really has, it reaches Kiro as a skill file
 * and Claude as prompt text, and the owner's own skill of the same name is never replaced.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTCORE_BROWSER_SKILL, AGENTCORE_SKILL_PATH, agentcoreSkillBody, withBuiltinKiroSkills } from '../server/agent/builtin-skills.ts';
import { KIRO_CONFIG_PATH, KIRO_CONFIG_LIMITS } from '../server/agent/kiro-config-files.ts';
import { withBrowserGuidance, BROWSER_GUIDANCE } from '../server/agent/browser-guidance.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseKiroConfig, writeKiroConfig } from '../kiro-runner/src/kiro-config.ts';
import { browserToolSpecs, type AgentCoreBrowser, type GuideKit } from '../agent-runner/src/browser-tools.ts';

describe('agentcore-browser skill', () => {
  it('is a valid Kiro skill file: right path, front matter with name and description, within the size limit', () => {
    assert.match(AGENTCORE_SKILL_PATH, KIRO_CONFIG_PATH);
    const fm = AGENTCORE_BROWSER_SKILL.match(/^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/);
    assert.ok(fm, 'front matter');
    assert.equal(fm![1], 'agentcore-browser');
    assert.ok(fm![2].length > 40 && fm![2].length < 400);
    assert.ok(Buffer.byteLength(AGENTCORE_BROWSER_SKILL) < KIRO_CONFIG_LIMITS.maxFileBytes);
    assert.ok(AGENTCORE_BROWSER_SKILL.length < 7000, 'short enough to send with every turn of a Claude session');
  });

  it('only names browser tools that exist, and names all of them', () => {
    const kit = { capture: async () => ({ ok: false, error: '' }), summary: () => '', signIn: async () => ({ ok: true, message: '' }) } as unknown as GuideKit;
    const browser = {} as AgentCoreBrowser;
    const real = new Set(browserToolSpecs(browser, { workDir: '/w', kit, accounts: [{ role: 'a', username: 'u', password: 'p' }], manualSignIn: true }).map((t) => t.name));
    const named = new Set([...AGENTCORE_BROWSER_SKILL.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((n) => /^(goto|snapshot|get_text|screenshot|capture|click|type|sign_in|wait_for_sign_in)$/.test(n)));
    for (const n of named) assert.ok(real.has(n), `${n} is not a browser tool`);
    for (const n of real) assert.ok(named.has(n), `${n} is not in the skill`);
  });

  it('tells the agent to verify the account first and not to substitute another one', () => {
    assert.match(AGENTCORE_BROWSER_SKILL, /Be sure it is the right account before you capture/);
    assert.match(AGENTCORE_BROWSER_SKILL, /do not substitute another account/);
    assert.match(AGENTCORE_BROWSER_SKILL, /account id in the address/);
    assert.match(AGENTCORE_BROWSER_SKILL, /top-right banner/);
  });

  it('Kiro gets it as a skill file when the run has the browser, never replaces the owner\'s, and gets nothing without a browser', () => {
    const own = [{ path: AGENTCORE_SKILL_PATH, content: 'my own version' }];
    assert.deepEqual(withBuiltinKiroSkills([], false), []);
    const added = withBuiltinKiroSkills([{ path: 'steering/x.md', content: 'x' }], true);
    assert.deepEqual(added.map((f) => f.path), ['steering/x.md', AGENTCORE_SKILL_PATH]);
    assert.equal(added[1].content, AGENTCORE_BROWSER_SKILL);
    assert.equal(withBuiltinKiroSkills(own, true), own);
  });

  it('Claude gets the text in its prompt (without front matter), and only when the run has the browser', () => {
    const body = agentcoreSkillBody();
    assert.ok(!body.startsWith('---') && body.startsWith('# AgentCore browser'));
    const withSkill = withBrowserGuidance('Do the task', true, body);
    assert.ok(withSkill.startsWith('Do the task\n\n') && withSkill.includes(BROWSER_GUIDANCE) && withSkill.includes('Be sure it is the right account'));
    assert.equal(withBrowserGuidance('Do the task', false, body), 'Do the task');
    assert.equal(withBrowserGuidance('Do the task', true), `Do the task\n\n${BROWSER_GUIDANCE}`, 'Kiro: guidance only, the skill is a file');
  });

  it('survives the trip to the Kiro runner: accepted by its parser and written to the skills folder of kiro-cli', () => {
    const files = parseKiroConfig(withBuiltinKiroSkills([], true));
    assert.deepEqual(files.map((f) => f.path), [AGENTCORE_SKILL_PATH]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-home-'));
    try {
      assert.equal(writeKiroConfig(home, files), 1);
      assert.equal(fs.readFileSync(path.join(home, '.kiro', 'skills', 'agentcore-browser', 'SKILL.md'), 'utf8'), AGENTCORE_BROWSER_SKILL);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
