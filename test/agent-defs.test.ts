/**
 * Agent files (.claude/agents/*.md) → the subagent definitions an AgentCore run takes with it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAgentFile, parseFrontMatter, loadAgentDefinitions, loadSkillLibrary, AGENT_LIMITS } from '../server/agent/agent-defs.ts';
import { agentModelFor } from '../server/agent/claude-agentcore-bedrock.ts';

const reviewer = `---
name: code-reviewer
description: Reviews a diff for bugs. Use after making changes.
tools: Read, Grep, Glob
model: sonnet
---
You are a careful reviewer.

Report each bug with its file and line.
`;

describe('agent files', () => {
  it('reads name, description, tools, model and the prompt', () => {
    const a = parseAgentFile(reviewer, 'ignored');
    assert.deepEqual(a, {
      name: 'code-reviewer',
      def: {
        description: 'Reviews a diff for bugs. Use after making changes.',
        prompt: 'You are a careful reviewer.\n\nReport each bug with its file and line.',
        tools: ['Read', 'Grep', 'Glob'],
        model: 'sonnet',
      },
    });
  });

  it('understands YAML lists, block text, quotes and CRLF', () => {
    const text = [
      '---',
      'name: "planner"',
      'description: >-',
      '  Plans the work.',
      '  Use first.',
      'tools:',
      '  - Read',
      '  - "WebSearch"',
      'disallowedTools: [Bash, Write]',
      'maxTurns: 12',
      '---',
      'Plan it.',
    ].join('\r\n');
    assert.deepEqual(parseAgentFile(text, 'x'), {
      name: 'planner',
      def: { description: 'Plans the work. Use first.', prompt: 'Plan it.', tools: ['Read', 'WebSearch'], disallowedTools: ['Bash', 'Write'], maxTurns: 12 },
    });
    assert.deepEqual(parseFrontMatter('a: |\n  line one\n  line two\nb: x'), { a: 'line one\nline two', b: 'x' });
  });

  it('uses the file name when there is no name; skips files Claude Code would not load', () => {
    assert.equal(parseAgentFile('---\ndescription: d\n---\nPrompt', 'from-file')?.name, 'from-file');
    assert.equal(parseAgentFile('# Just markdown\nNo front matter', 'x'), null, 'no front matter');
    assert.equal(parseAgentFile('---\nname: a\n---\nPrompt', 'x'), null, 'no description');
    assert.equal(parseAgentFile('---\nname: a\ndescription: d\n---\n', 'x'), null, 'no prompt');
    assert.equal(parseAgentFile('---\nname: has space\ndescription: d\n---\nP', 'x'), null, 'bad name');
  });

  it('maps the model to one the run can use, or leaves it to the run\'s model', () => {
    const withModel = (m: string) => parseAgentFile(`---\nname: a\ndescription: d\nmodel: ${m}\n---\nP`, 'x', agentModelFor)?.def.model;
    assert.equal(withModel('haiku'), 'haiku');
    assert.equal(withModel('Inherit'), 'inherit');
    assert.equal(withModel('claude-opus-4-5'), 'global.anthropic.claude-opus-4-5-20251101-v1:0');
    assert.equal(withModel('global.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'global.anthropic.claude-sonnet-4-5-20250929-v1:0');
    assert.equal(withModel('gpt-5'), undefined, 'not a Claude model: the run\'s model');
  });

  it('preloads `skills:` and lists `on-demand-skills:` as an index the agent reads with read_skill', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ondemand-'));
    const skill = (name: string, desc: string, body: string) => {
      fs.mkdirSync(path.join(root, 'skills', name), { recursive: true });
      fs.writeFileSync(path.join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`);
    };
    skill('rules', 'House rules.', 'RULES-BODY');
    skill('backend-python', 'Python back ends. Use for FastAPI work.', 'PYTHON-BODY');
    skill('backend-java', 'Java back ends.', 'JAVA-BODY');
    fs.mkdirSync(path.join(root, 'agents'));
    fs.writeFileSync(path.join(root, 'agents', 'be.md'), '---\nname: be\ndescription: Backend\nskills: [rules]\non-demand-skills: [backend-python, backend-java, missing, rules]\n---\nYou build back ends.');
    fs.writeFileSync(path.join(root, 'agents', 'rev.md'), '---\nname: rev\ndescription: Reviewer\ntools: Read, Grep\non-demand-skills: [backend-python]\n---\nYou review.');
    const defs = loadAgentDefinitions([path.join(root, 'agents')], undefined, [path.join(root, 'skills')]);
    const be = defs.be!.prompt;
    assert.match(be, /# Skill: rules\n\nRULES-BODY/, 'rules preloaded');
    assert.doesNotMatch(be, /PYTHON-BODY|JAVA-BODY/, 'on-demand bodies are not in the prompt');
    assert.match(be, /# Skills you can load/);
    assert.match(be, /- backend-python: Python back ends\. Use for FastAPI work\./);
    assert.match(be, /- backend-java: Java back ends\./);
    assert.doesNotMatch(be, /- missing:/, 'a skill that does not exist is not listed');
    assert.doesNotMatch(be, /- rules:/, 'a preloaded skill is not listed again');
    // An agent limited to some tools gets read_skill added, so it can load its skills.
    assert.deepEqual(defs.rev!.tools, ['Read', 'Grep', 'mcp__portal-skills__read_skill']);
    // The library holds every skill in the folders, by name, without front matter.
    const lib = loadSkillLibrary([path.join(root, 'skills'), null, path.join(root, 'nope')]);
    assert.deepEqual(Object.keys(lib).sort(), ['backend-java', 'backend-python', 'rules']);
    assert.equal(lib['backend-python'], 'PYTHON-BODY');
    // A later folder (the project's) wins.
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-project-'));
    fs.mkdirSync(path.join(project, 'backend-python'));
    fs.writeFileSync(path.join(project, 'backend-python', 'SKILL.md'), '---\nname: backend-python\ndescription: d\n---\nPROJECT-PYTHON');
    assert.equal(loadSkillLibrary([path.join(root, 'skills'), project])['backend-python'], 'PROJECT-PYTHON');
  });

  it('loads folders in order: a later folder wins on a name clash; bad files are skipped', () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-user-'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-project-'));
    fs.writeFileSync(path.join(user, 'code-reviewer.md'), reviewer);
    fs.writeFileSync(path.join(user, 'helper.md'), '---\nname: helper\ndescription: Helps\n---\nHelp.');
    fs.writeFileSync(path.join(project, 'review.md'), '---\nname: code-reviewer\ndescription: The project\'s reviewer\n---\nProject rules.');
    fs.writeFileSync(path.join(project, 'notes.txt'), 'not an agent');
    fs.writeFileSync(path.join(project, 'broken.md'), 'no front matter');
    fs.writeFileSync(path.join(project, 'huge.md'), `---\nname: huge\ndescription: d\n---\n${'x'.repeat(AGENT_LIMITS.maxFileBytes)}`);
    const agents = loadAgentDefinitions([user, null, path.join(project, 'missing'), project]);
    assert.deepEqual(Object.keys(agents).sort(), ['code-reviewer', 'helper']);
    assert.equal(agents['code-reviewer'].description, 'The project\'s reviewer');
    assert.equal(agents['code-reviewer'].prompt, 'Project rules.');
  });

  it('keeps at most 50 agents', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-many-'));
    for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, `a${String(i).padStart(2, '0')}.md`), `---\ndescription: d\n---\nP${i}`);
    assert.equal(Object.keys(loadAgentDefinitions([dir])).length, AGENT_LIMITS.maxAgents);
  });
});
