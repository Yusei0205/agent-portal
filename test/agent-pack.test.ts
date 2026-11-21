/**
 * The agent pack (web/src/lib/agent-pack): a lead agent, specialists and their skills for Kiro and Claude Code,
 * and the wiring that makes runs use them (agents with preloaded skills, the lead agent, cloud Kiro config).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// @ts-expect-error — plain JS module without type declarations
import { PACK_AGENTS, PACK_SKILLS, kiroPackFiles, claudePackFiles, agentPackFiles, packUpdatePlan, packFileLabel } from '../web/src/lib/agent-pack/index.js';
import { parseAgentFile, parseFrontMatter, loadAgentDefinitions, AGENT_NAME, SKILL_NAME, AGENT_LIMITS } from '../server/agent/agent-defs.ts';
import { leadAgentFor, anthropicAgentModel } from '../server/agent/run-agents.ts';
import { collectKiroConfig, hasKiroAgent, KIRO_CONFIG_PATH } from '../server/agent/kiro-config-files.ts';
import { parseKiroConfig, writeKiroConfig } from '../kiro-runner/src/kiro-config.ts';
import { validatePayload } from '../agent-runner/src/validate.ts';
import { invokeAgentCore, _setAgentCoreInvokerOverride } from '../server/agent/kiro-agentcore.ts';

type PackAgent = { name: string; skills: string[]; lead?: boolean; kiro: { tools: string[] }; claudeTools?: string[] };
type PackSkill = { name: string; description: string; body: string };
type PackFile = { path: string; content: string };

const agents = PACK_AGENTS as PackAgent[];
const skills = PACK_SKILLS as PackSkill[];

function writeTree(root: string, files: PackFile[]): void {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f.path)), { recursive: true });
    fs.writeFileSync(path.join(root, f.path), f.content);
  }
}

describe('agent pack content', () => {
  it('has the lead agent and the six specialists, each with existing skills', () => {
    assert.deepEqual(agents.map((a) => a.name), [
      'lead-orchestrator', 'backend-engineer', 'frontend-engineer', 'infra-engineer', 'security-reviewer', 'slide-designer', 'tech-writer',
    ]);
    assert.equal(agents.filter((a) => a.lead).length, 1);
    const skillNames = new Set(skills.map((s) => s.name));
    for (const a of agents) {
      assert.match(a.name, AGENT_NAME);
      assert.ok(a.skills.length > 0, a.name);
      for (const s of a.skills) assert.ok(skillNames.has(s), `${a.name}: skill ${s} missing`);
    }
    // Every skill is used by some agent.
    for (const s of skills) assert.ok(agents.some((a) => a.skills.includes(s.name)), `${s.name} unused`);
  });

  it('skills follow the Kiro / Claude Code rules', () => {
    assert.equal(new Set(skills.map((s) => s.name)).size, skills.length);
    for (const s of skills) {
      assert.match(s.name, SKILL_NAME);
      assert.ok(s.description.length >= 40 && s.description.length <= 1024, `${s.name}: description length`);
      assert.ok(s.body.split('\n').length < 500, `${s.name}: body too long`);
      assert.ok(!s.body.includes('${'), `${s.name}: stray template placeholder`);
    }
  });

  it('covers the backend languages, frontend stack, AWS networking and the OWASP Top 10:2025', () => {
    const text = (n: string) => skills.find((s) => s.name === n)!.body;
    assert.match(text('backend-python'), /FastAPI/);
    assert.match(text('backend-java'), /Spring Boot/);
    assert.match(text('frontend-react-typescript'), /TypeScript/);
    assert.match(text('tailwind-ui'), /Tailwind/);
    for (const w of ['VPC', 'subnet', 'Security groups', 'NAT']) assert.match(text('aws-networking'), new RegExp(w));
    const owasp = text('owasp-top-10');
    for (let i = 1; i <= 10; i++) assert.match(owasp, new RegExp(`## A${String(i).padStart(2, '0')} `), `A${i} missing`);
    for (const c of ['Broken Access Control', 'Security Misconfiguration', 'Software Supply Chain Failures', 'Cryptographic Failures', 'Injection',
      'Insecure Design', 'Authentication Failures', 'Software or Data Integrity Failures', 'Logging & Alerting Failures', 'Mishandling of Exceptional Conditions']) {
      assert.ok(owasp.includes(c), c);
    }
    assert.match(text('statement-of-work'), /Out of scope/);
    assert.match(text('slide-design'), /python-pptx/);
    for (const w of ['Express', 'Fastify', 'NestJS', 'zod', 'tsc --noEmit']) assert.ok(text('backend-node-typescript').includes(w), `node skill: ${w}`);
    for (const w of ['ECS Fargate', 'Lambda', 'DynamoDB', 'OIDC', 'CodePipeline']) assert.ok(text('aws-compute-cicd').includes(w), `compute/CI-CD skill: ${w}`);
    for (const w of ['Prompt injection', 'Excessive agency', 'Improper output handling', 'Unbounded consumption']) assert.ok(owasp.includes(w), `LLM risk: ${w}`);
    assert.ok(agents.find((a) => a.name === 'backend-engineer')!.skills.includes('backend-node-typescript'));
    assert.ok(agents.find((a) => a.name === 'infra-engineer')!.skills.includes('aws-compute-cicd'));
  });

  it('every agent knows what its machine has, and the lead knows how to hand work off', () => {
    const prompts = agents.map((a) => (a as PackAgent & { prompt: string }).prompt);
    for (const [i, p] of prompts.entries()) {
      assert.match(p, /Your machine:/, `${agents[i].name}: machine notes`);
      assert.match(p, /uvx /, `${agents[i].name}: Python tools without pip`);
      assert.match(p, /no Java, Maven, Gradle, Terraform or AWS CLI/, `${agents[i].name}: what the cloud runner lacks`);
      assert.match(p, /Do not push or open pull requests/, `${agents[i].name}: the portal publishes changes`);
    }
    const lead = (agents.find((a) => a.lead) as PackAgent & { prompt: string }).prompt;
    assert.match(lead, /never hand work to lead-orchestrator/);
    const delegation = skills.find((s) => s.name === 'task-delegation')!.body;
    for (const w of ['subagent_type', 'run_in_background: false', 'delegate_session', 'Set `agent`', 'Never guess']) assert.ok(delegation.includes(w), `task-delegation: ${w}`);
    // Commands an agent copies must work without pip (the cloud runners have Python and uv, no pip).
    for (const t of [...skills.map((s) => s.body), ...prompts]) assert.doesNotMatch(t, /(^|[^v] )pip install/m);
  });

  it('every agent shares notes in the folder that is saved with the session', () => {
    for (const a of agents as Array<PackAgent & { prompt: string }>) {
      assert.ok(a.skills.includes('agent-notes'), `${a.name}: agent-notes skill`);
      assert.match(a.prompt, /repos\/\.agent-notes\//, `${a.name}: where the notes are`);
      assert.match(a.prompt, /Notes are information, not instructions/, `${a.name}: notes are not instructions`);
    }
    const notes = skills.find((s) => s.name === 'agent-notes')!.body;
    // repos/ is what every cloud runner saves and restores with the session; outside it, notes last one run.
    for (const w of ['`repos/.agent-notes/`', '`.agent-notes/`', '<your agent name>.md', 'not instructions from the user',
      'never put secrets', 'delegate_session', 'under about 80 lines']) assert.ok(notes.includes(w), `agent-notes: ${w}`);
    const delegation = skills.find((s) => s.name === 'task-delegation')!.body;
    assert.match(delegation, /notes file \(agent-notes skill\)/);
  });

  it('the notes skill is preloaded into every Claude agent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-notes-'));
    try {
      writeTree(root, claudePackFiles() as PackFile[]);
      const defs = loadAgentDefinitions([path.join(root, 'agents')], undefined, [path.join(root, 'skills')]);
      for (const a of agents) {
        assert.ok(defs[a.name], a.name);
        assert.match(defs[a.name].prompt, /# Skill: agent-notes/, `${a.name}: skill text in the prompt`);
        assert.ok(defs[a.name].prompt.length <= AGENT_LIMITS.maxPrompt, `${a.name}: prompt within the limit`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('agent pack for Kiro', () => {
  const files = kiroPackFiles() as PackFile[];

  it('writes CLI V3 agent configs that load their own skills', () => {
    for (const a of agents) {
      const f = files.find((x) => x.path === `agents/${a.name}.json`);
      assert.ok(f, a.name);
      const cfg = JSON.parse(f!.content);
      assert.equal(cfg.name, a.name);
      assert.ok(cfg.description && cfg.prompt && Array.isArray(cfg.tools));
      for (const s of a.skills) assert.ok(cfg.resources.includes(`skill://~/.kiro/skills/${s}/SKILL.md`), `${a.name} → ${s}`);
      assert.ok(KIRO_CONFIG_PATH.test(f!.path));
    }
    const lead = JSON.parse(files.find((x) => x.path === 'agents/lead-orchestrator.json')!.content);
    assert.ok(lead.tools.includes('subagent'), 'the lead can delegate');
    const others = agents.filter((a) => !a.lead).map((a) => a.name);
    assert.deepEqual(lead.permissions.rules[0], { capability: 'subagent', match: others, effect: 'allow' });
    assert.deepEqual(lead.toolsSettings.subagent.availableAgents, others);
    const security = JSON.parse(files.find((x) => x.path === 'agents/security-reviewer.json')!.content);
    assert.ok(!security.tools.includes('write'), 'the security reviewer does not edit code');
  });

  it('writes each SKILL.md with front matter whose name matches its folder', () => {
    for (const s of skills) {
      const f = files.find((x) => x.path === `skills/${s.name}/SKILL.md`)!;
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(f.content);
      assert.ok(fm, s.name);
      const meta = parseFrontMatter(fm![1]);
      assert.equal(meta.name, s.name);
      assert.equal(meta.description, s.description);
    }
  });
});

describe('agent pack for Claude Code', () => {
  const files = claudePackFiles() as PackFile[];

  it('agent files parse, and their skills are preloaded into the prompt', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-claude-'));
    try {
      writeTree(home, files);
      const defs = loadAgentDefinitions([path.join(home, 'agents')], anthropicAgentModel, [path.join(home, 'skills')]);
      assert.deepEqual(Object.keys(defs).sort(), agents.map((a) => a.name).sort());
      for (const a of agents) {
        for (const s of a.skills) assert.ok(defs[a.name].prompt.includes(`# Skill: ${s}`), `${a.name} preloads ${s}`);
        assert.equal(defs[a.name].model, 'inherit');
        // With room to spare: a skill that would pass the limit is left out without a word.
        assert.ok(defs[a.name].prompt.length < AGENT_LIMITS.maxPrompt / 2, `${a.name}: ${defs[a.name].prompt.length} characters with its skills`);
      }
      assert.equal(defs['lead-orchestrator'].tools, undefined, 'the lead keeps every tool, including Agent');
      assert.ok(!defs['security-reviewer'].tools!.includes('Agent'));
      assert.ok(defs['backend-engineer'].prompt.includes('Spring Boot'));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('the portal lists them with their names (front matter)', () => {
    for (const f of files.filter((x) => x.path.startsWith('agents/'))) {
      const parsed = parseAgentFile(f.content, 'fallback');
      assert.ok(parsed && parsed.name !== 'fallback', f.path);
    }
  });

  it('agentPackFiles picks the folder', () => {
    assert.equal(agentPackFiles('kiro').length, agents.length + skills.length);
    assert.equal(agentPackFiles('claude').length, agents.length + skills.length);
    assert.equal(agentPackFiles('aws'), null);
  });
});

describe('updating a pack that is already there (Agent setup › Agent pack)', () => {
  type Plan = { add: PackFile[]; change: PackFile[]; same: PackFile[]; kept: PackFile[] };
  const paths = (fs: PackFile[]) => fs.map((f) => f.path).sort();

  it('adds everything to a folder without the pack, and nothing to one that is up to date', () => {
    for (const folder of ['claude', 'kiro']) {
      const files = agentPackFiles(folder) as PackFile[];
      const none = packUpdatePlan(folder, {}) as Plan;
      assert.deepEqual(paths(none.add), paths(files));
      assert.equal(none.change.length + none.same.length, 0);

      // The same files, saved by an editor with Windows line endings and a trailing newline, count as up to date.
      const saved = Object.fromEntries(files.map((f) => [f.path, f.content.replace(/\n/g, '\r\n') + '\r\n']));
      const current = packUpdatePlan(folder, saved) as Plan;
      assert.equal(current.add.length + current.change.length, 0, `${folder}: up to date`);
      assert.equal(current.same.length, files.length);
    }
  });

  it('replaces pack files that differ, adds missing ones, and looks at no other file', () => {
    const files = claudePackFiles() as PackFile[];
    const existing: Record<string, string> = Object.fromEntries(files.map((f) => [f.path, f.content]));
    existing['agents/backend-engineer.md'] = existing['agents/backend-engineer.md'].replace('Node.js / TypeScript', 'Go');   // an older version
    delete existing['skills/backend-node-typescript/SKILL.md'];                                                               // a skill added since
    existing['agents/my-own-agent.md'] = '---\nname: my-own-agent\ndescription: mine\n---\nMine.\n';                          // the person's own
    existing['CLAUDE.md'] = '# Mine\n';
    const plan = packUpdatePlan('claude', existing) as Plan;
    assert.deepEqual(paths(plan.change), ['agents/backend-engineer.md']);
    assert.deepEqual(paths(plan.add), ['skills/backend-node-typescript/SKILL.md']);
    assert.equal(plan.same.length, files.length - 2);
    const touched = [...plan.add, ...plan.change, ...plan.same].map((f) => f.path);
    assert.ok(!touched.includes('agents/my-own-agent.md') && !touched.includes('CLAUDE.md'), 'other files are never part of an update');
    assert.equal(packUpdatePlan('aws', {}), null);
  });

  it('Codex: your own config.toml and AGENTS.md are kept; the pack\'s agents and skills are updated', () => {
    const files = agentPackFiles('codex') as PackFile[];
    const none = packUpdatePlan('codex', {}) as Plan;
    assert.deepEqual(paths(none.add), paths(files), 'a folder without the pack gets all of it');
    assert.equal(none.kept.length, 0);

    const existing: Record<string, string> = Object.fromEntries(files.map((f) => [f.path, f.content]));
    existing['config.toml'] = 'model_reasoning_effort = "medium"\n';   // the person's own settings (the Codex starter writes this)
    existing['AGENTS.md'] = '# My team\n';
    const older = existing['agents/backend-engineer.toml'].replace('Node.js / TypeScript', 'Go');
    assert.notEqual(older, existing['agents/backend-engineer.toml'], 'the older version differs');
    existing['agents/backend-engineer.toml'] = older;
    const plan = packUpdatePlan('codex', existing) as Plan;
    assert.deepEqual(paths(plan.kept), ['AGENTS.md', 'config.toml'], 'never replaced');
    assert.deepEqual(paths(plan.change), ['agents/backend-engineer.toml']);
    assert.equal(plan.add.length, 0);

    // The pack's own config.toml, as written by an earlier add, is up to date: nothing to do.
    const current = packUpdatePlan('codex', Object.fromEntries(files.map((f) => [f.path, f.content]))) as Plan;
    assert.equal(current.add.length + current.change.length + current.kept.length, 0);
  });

  it('names pack files the way people know them', () => {
    assert.equal(packFileLabel('agents/lead-orchestrator.md'), 'lead-orchestrator');
    assert.equal(packFileLabel('agents/tech-writer.json'), 'tech-writer');
    assert.equal(packFileLabel('agents/tech-writer.toml'), 'tech-writer');
    assert.equal(packFileLabel('skills/task-delegation/SKILL.md'), 'skill task-delegation');
    assert.equal(packFileLabel('config.toml'), 'config.toml');
  });
});

describe('agent skills preloading', () => {
  it('a later skills folder wins, unknown or invalid names are skipped', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    try {
      writeTree(root, [
        { path: 'user/agents/a.md', content: '---\nname: a\ndescription: d\nskills: [one, missing, "../etc"]\n---\nBase prompt.' },
        { path: 'user/skills/one/SKILL.md', content: '---\nname: one\ndescription: x\n---\nUser version.' },
        { path: 'project/skills/one/SKILL.md', content: '---\nname: one\ndescription: x\n---\nProject version.' },
      ]);
      const defs = loadAgentDefinitions([path.join(root, 'user/agents')], undefined, [path.join(root, 'user/skills'), path.join(root, 'project/skills')]);
      assert.equal(defs.a.prompt, 'Base prompt.\n\n---\n# Skill: one\n\nProject version.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leadAgentFor and anthropicAgentModel', () => {
    const defs = { 'backend-engineer': { description: 'd', prompt: 'p' } };
    assert.equal(leadAgentFor({ leadAgent: 'backend-engineer' }, defs), 'backend-engineer');
    assert.equal(leadAgentFor({ leadAgent: 'nobody' }, defs), null);
    assert.equal(leadAgentFor({ leadAgent: null }, defs), null);
    assert.equal(anthropicAgentModel('Sonnet'), 'sonnet');
    assert.equal(anthropicAgentModel('claude-sonnet-5-5'), 'claude-sonnet-5-5');
    assert.equal(anthropicAgentModel('global.anthropic.x:0'), undefined);
    assert.equal(anthropicAgentModel('Inherit'), 'inherit');
    // An agent file written for Bedrock keeps its model on an Anthropic key or Claude plan.
    assert.equal(anthropicAgentModel('global.anthropic.claude-opus-4-6-v1'), 'claude-opus-4-6');
  });
});

describe('cloud Kiro runs get the agents and skills', () => {
  it('collects agents, skills and steering, not settings', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-home-'));
    try {
      writeTree(path.join(home, '.kiro'), [
        ...(kiroPackFiles() as PackFile[]),
        { path: 'steering/project.md', content: '# Steering' },
        { path: 'settings/mcp.json', content: '{"mcpServers":{}}' },
        { path: 'hooks/x.json', content: '{}' },
      ]);
      const files = collectKiroConfig(home);
      assert.equal(files.length, agents.length + skills.length + 1);
      assert.ok(!files.some((f) => f.path.startsWith('settings/') || f.path.startsWith('hooks/')));
      assert.ok(hasKiroAgent(files, 'lead-orchestrator'));
      assert.ok(!hasKiroAgent(files, 'nobody'));
      assert.deepEqual(collectKiroConfig(null), []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('the runner keeps only safe paths and writes them under ~/.kiro', () => {
    const files = parseKiroConfig([
      { path: 'agents/a.json', content: '{}' },
      { path: 'skills/s/SKILL.md', content: 'x' },
      { path: '../escape.md', content: 'x' },
      { path: 'skills/../../escape.md', content: 'x' },
      { path: 'settings/mcp.json', content: '{}' },
      { path: 'agents/a.json', content: 5 },
      'junk',
    ]);
    assert.deepEqual(files.map((f) => f.path), ['agents/a.json', 'skills/s/SKILL.md']);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-run-home-'));
    try {
      assert.equal(writeKiroConfig(home, files), 2);
      assert.ok(fs.existsSync(path.join(home, '.kiro', 'skills', 's', 'SKILL.md')));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('cloud Claude runs: the lead agent', () => {
  const agentsPayload = { 'backend-engineer': { description: 'd', prompt: 'p' } };
  it('the runner accepts a lead agent that is one of the agents', () => {
    const r = validatePayload({ runId: 'r1', prompt: 'hi', agents: agentsPayload, agent: 'backend-engineer' });
    assert.ok(r.ok && r.payload.agent === 'backend-engineer');
    assert.equal(validatePayload({ runId: 'r1', prompt: 'hi', agents: agentsPayload, agent: 'other' }).ok, false);
    assert.equal(validatePayload({ runId: 'r1', prompt: 'hi', agent: 'backend-engineer' }).ok, false);
  });

  it('an older runner that rejects "agent" is asked again without it', async () => {
    const seen: Array<Record<string, unknown>> = [];
    _setAgentCoreInvokerOverride(async function* (_arn, _sid, payload) {
      seen.push(payload);
      if ('agent' in payload) throw new Error('AgentCore returned HTTP 400: {"error":"Unknown field: \\"agent\\""}');
      yield { type: 'result' } as never;
    });
    try {
      const events: unknown[] = [];
      for await (const ev of invokeAgentCore('arn', 'sid', { runId: 'r', prompt: 'p', agent: 'x', agents: {} })) events.push(ev);
      assert.equal(seen.length, 2);
      assert.ok(!('agent' in seen[1]));
      assert.match(String((events[0] as { text: string }).text), /does not support "agent"/);
    } finally {
      _setAgentCoreInvokerOverride(null);
    }
  });
});
