import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SKILLS_GUIDANCE, withSkillsGuidance } from '../server/agent/skills-guidance.ts';
// @ts-expect-error — plain JS module without type declarations
import { syncGoal, SKILLS_DIR } from '../web/src/lib/repoSync.js';

describe('repository skills guidance', () => {
  it('is added only to runs that have repositories', () => {
    assert.equal(withSkillsGuidance('Fix it', false), 'Fix it');
    const out = withSkillsGuidance('Fix it', true);
    assert.ok(out.startsWith('Fix it\n\n') && out.endsWith(SKILLS_GUIDANCE));
  });
  it('points at the index first and says to trust the code over a skill', () => {
    assert.match(SKILLS_GUIDANCE, /agent\/skills\/INDEX\.md/);
    assert.match(SKILLS_GUIDANCE, /trust the code/);
  });
});

describe('docs and skills sync task', () => {
  const goal = syncGoal({ repoName: 'agent-portal', branch: 'main_v3' });
  it('uses the tool-neutral folder, not a tool-specific one', () => {
    assert.equal(SKILLS_DIR, 'agent/skills');
    assert.match(goal, /agent\/skills\/INDEX\.md/);
    assert.match(goal, /do not use \.claude\/, \.kiro\/ or \.codex\//);
  });
  it('is incremental when a previous sync exists and a full build otherwise', () => {
    assert.match(goal, /\.sync\.json/);
    assert.match(goal, /git diff --name-only/);
    assert.match(goal, /FULL BUILD/);
  });
  it('names the branch, opens a pull request and never pushes to the branch directly', () => {
    assert.match(goal, /branch main_v3/);
    assert.match(goal, /open a pull request into main_v3/);
    assert.match(goal, /Do not push to main_v3 directly/);
  });
  it('points every tool at the skills through AGENTS.md', () => {
    assert.match(goal, /AGENTS\.md/);
  });
  it('leaves the documentation part out when asked', () => {
    assert.ok(!/## Documentation/.test(syncGoal({ repoName: 'r', branch: 'b', docs: false })));
  });
});
