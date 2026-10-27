// Builds role templates from Claude Code agents and skills on disk.
//
//   node scripts/build-role-library.mjs [--only claude|delivery] [--from <folder>] [--delivery <folder>]
//
//   claude    ~/.claude (agents/ and skills/)           -> server/role-data/roles-library.json   (LIBRARY_ROLES)
//   delivery  "ai-delivery-team (claude)" on the Desktop -> server/role-data/roles-delivery.json  (DELIVERY_ROLES)
//
// The output is a JSON data file (loaded by server/roles-library.ts and roles-delivery.ts) that is committed, so a cloud build needs nothing from your PC.
// The open-source roles (public Agent Skills repositories) are built separately by scripts/build-open-source-roles.mjs.
// Re-run it after you change an agent or skill, then rebuild.
//
// Adaptations (the original text is kept; these are mechanical):
//  - hooks in the frontmatter are dropped (they call scripts that exist only on your PC)
//  - the PowerShell tool is removed (the portal runs on Linux) and plain Bash is kept
//  - ~/.claude/output and ~/.claude/scripts/pptx become work/pptx/... inside the run folder
//  - team leads get a short "Running inside Agent Portal" note before the original instructions
//  - delivery team: three agents whose names clash with the starter roles are renamed delivery-<name>, and the
//    conventions in its CLAUDE.md become the delivery-conventions skill (the portal writes its own CLAUDE.md)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const only = arg('--only');

const WORK_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];

/* ------------------------------------------------------------------ */
/* Source 1: ~/.claude                                                 */
/* ------------------------------------------------------------------ */

/** Which agents and skills make up each role. The first agent is the one the main agent talks to. */
const CLAUDE_ROLES = [
  {
    key: 'aws-backend-engineer',
    title: 'AWS backend engineer',
    summary: 'Serverless backend work: CDK stacks, Lambda handlers, DynamoDB access patterns, AppSync, SQS and EventBridge.',
    agents: ['backend-agent'],
    skills: ['backend-cdk', 'backend-lambda', 'backend-dynamodb', 'backend-patterns'],
  },
  {
    key: 'backend-test-engineer',
    title: 'Backend test engineer',
    summary: 'pytest and moto tests for Lambda and DynamoDB: unit and integration levels, fixtures and mocks.',
    agents: ['backend-testing-agent'],
    skills: ['testing-backend', 'backend-lambda'],
  },
  {
    key: 'react-frontend-engineer',
    title: 'React frontend engineer',
    summary: 'React and TypeScript: architecture, accessibility, performance and code review of components.',
    agents: ['frontend-agent'],
    skills: ['frontend-architecture', 'frontend-patterns', 'frontend-performance'],
  },
  {
    key: 'frontend-test-engineer',
    title: 'Frontend test engineer',
    summary: 'Vitest, React Testing Library, MSW and Playwright end-to-end tests.',
    agents: ['frontend-testing-agent'],
    skills: ['testing-frontend'],
  },
  {
    key: 'pr-code-reviewer',
    title: 'PR code reviewer',
    summary: 'Reviews a change in parallel passes per area, scores each finding and keeps only the confident ones. Works best with the backend and frontend engineers added.',
    agents: ['code-review-agent'],
    skills: [],
  },
  {
    key: 'tech-lead',
    title: 'Tech lead',
    summary: 'Splits a feature across the backend, frontend and test roles and keeps the result consistent. Add those roles too.',
    agents: ['lead-agent'],
    skills: ['lead-orchestration'],
  },
  {
    key: 'tech-doc-team',
    title: 'Technical documentation team',
    summary: 'A lead plus seven section writers (architecture, backend logic, tables, APIs, security, disaster recovery, testing) that produce a Technical Design Document from the repositories.',
    agents: ['doc-lead-agent', 'doc-architecture-agent', 'doc-backend-agent', 'doc-table-design-agent', 'doc-api-design-agent', 'doc-security-agent', 'doc-dr-agent', 'doc-testing-agent'],
    skills: [],
  },
  {
    key: 'presentation-team',
    title: 'Presentation team',
    summary: 'A lead plus content, design, image, render and review specialists that turn a topic or document into a .pptx deck.',
    agents: ['pptx-lead', 'pptx-content', 'pptx-design', 'pptx-image', 'pptx-render', 'pptx-review'],
    skills: ['pptx-generation'],
  },
];

/** Notes placed before an agent's own instructions so it works inside the portal. */
const CLAUDE_NOTES = {
  'doc-lead-agent': `## Running inside Agent Portal

- Repositories are read-only copies under \`repos/<name>/\` in the project folder. Look there and ask which ones to document; do not ask for absolute paths.
- Write everything into the run folder named in your task, in a \`tech-doc/\` subfolder. Treat that as \`<output_dir>\`.
- You cannot start another \`claude\` process, so do not build \`lambda_analyzer.py\` around one. Analyse the Lambda functions yourself in batches by delegating to doc-backend-agent with the Agent tool, and have each batch write its findings to a file.
- For the final Word file prefer the make-documents skill (the \`make-doc\` command, type \`docx\`, from the compiled Markdown). Use docxtpl only if the team supplied a Word template.
- AWS CLI calls work only if the server has AWS credentials. Otherwise take facts from the infrastructure code in the repositories and mark runtime-only facts as unverified.

---
`,
  'pptx-lead': `## Running inside Agent Portal

- Use \`work/pptx/output/\` inside the run folder wherever the instructions say \`~/.claude/output/\`, and \`work/pptx/scripts/\` for scripts.
- To assemble the deck you may use the make-documents skill (the \`make-doc\` command, type \`pptx\`) instead of python-pptx. Map each slide of slide_content.json to a slide with a title and bullets, a table, or a text block.
- Image generation needs internet access to Pollinations.ai; skip hero images if it is not reachable.

---
`,
  'pptx-render': `## Running inside Agent Portal

Prefer the make-documents skill (the \`make-doc\` command, type \`pptx\`) to build the file. Use python-pptx only when a design needs something the command does not offer.

---
`,
  'code-review-agent': `## Running inside Agent Portal

- The GitHub CLI (\`gh\`) is usually not available here. Read the change with git instead: \`git diff origin/<base>...origin/<head>\` inside the repository copy under \`repos/<name>/\`.
- Report your findings in your reply. Do not try to post comments to a pull request.

---
`,
  'lead-agent': `## Running inside Agent Portal

Delegate with the Agent tool to the role agents installed in this project (backend-agent, frontend-agent, backend-testing-agent, frontend-testing-agent). If one is not installed, say so and continue with the roles that are.

---
`,
};

const CLAUDE_FIXES = [
  [/~\/\.claude\/agents\//g, '.claude/agents/ of this project'],
  [/~\/\.claude\/output\//g, 'work/pptx/output/'],
  [/~\/\.claude\/scripts\/pptx\//g, 'work/pptx/scripts/'],
  [/~\/\.claude\/ExampleTechDocs\/ \(if present\)/g, 'docs/md/ (if example documents were uploaded)'],
  [/~\/\.claude\/output/g, 'work/pptx/output'],
  [/~\/\.claude\/scripts\/pptx/g, 'work/pptx/scripts'],
];

/* ------------------------------------------------------------------ */
/* Source 2: the AI delivery team                                      */
/* ------------------------------------------------------------------ */

const DELIVERY_AGENTS = ['project-manager', 'business-analyst', 'solution-architect', 'tech-lead', 'qa-engineer', 'developer', 'devops-engineer', 'cloud-infra-engineer', 'security-reviewer'];
const DELIVERY_SKILLS = ['deliver-project', 'repo-structure', 'requirements-analysis', 'project-planning', 'solution-architecture', 'task-breakdown', 'test-design', 'feature-implementation', 'cicd-pipeline', 'aws-infrastructure', 'security-review'];

// These three names are also the portal's starter roles. Rename them so both can be added to one project.
const RENAMES = ['business-analyst', 'solution-architect', 'qa-engineer'];
const renameAgents = (s) => RENAMES.reduce((acc, n) => acc.replace(new RegExp(`(?<![\\w-])${n}(?![\\w-])`, 'g'), `delivery-${n}`), s);
const delName = (n) => (RENAMES.includes(n) ? `delivery-${n}` : n);

const PORTAL_PATHS = `## Running inside Agent Portal

- The paths in these instructions (\`docs/\`, \`src/\`, \`infra/\`, \`pipelines/\`, \`tests/\`) are relative to the **repository working copy** named in your task (\`work/<run id>/<repo>/\`). Create and change files only there.
- The project's uploaded requirement documents are Markdown files in \`docs/md/\` of the *project* folder, outside the working copy. Read them from there.
- The team conventions (IDs, coordination protocol, default stack, global rules) are in the \`delivery-conventions\` skill. Wherever these instructions say \`CLAUDE.md\`, read that skill.
- Tools such as terraform, npm and the AWS CLI may not be installed on the server. When a check cannot run, say so plainly in your handoff instead of skipping it silently.

---
`;

const DELIVER_NOTE = `## Running inside Agent Portal

- Start this skill from a run that has the **target repository selected**, so the team gets a working copy on a branch. All \`docs/\`, \`src/\`, \`infra/\`, \`pipelines/\` and \`tests/\` paths below are inside that working copy, and you pass that location to every agent.
- The requirement documents are the Markdown files the team uploaded under \`docs/md/\` of the project folder. Use those paths as \`<path-to-FRD>\`. Copy them into \`docs/00-requirements/source/\` of the working copy.
- The arguments (\`--phase\`, \`--story\`, \`--auto\`) are written in the run's prompt, for example "Use the deliver-project skill on docs/md/frd.md --auto".
- The agent names in this project are \`delivery-business-analyst\`, \`delivery-solution-architect\` and \`delivery-qa-engineer\`; the others keep the names shown. Use these exact names with the Agent tool.
- terraform, npm and the AWS CLI may not be installed on the server. Report a check that cannot run instead of treating it as passed. Never deploy.

---
`;

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Split "---\n frontmatter \n---\n body". */
function split(text) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('missing frontmatter');
  return { fm: m[1], body: m[2] };
}

function scalar(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  if (!m) return undefined;
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

/** "a, b" or a YAML list under the key. */
function listField(fm, key) {
  const inline = scalar(fm, key);
  if (inline) return inline.split(',').map((s) => s.trim()).filter(Boolean);
  const m = fm.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.*\\n?)+)`, 'm'));
  return m ? m[1].split('\n').map((l) => l.replace(/^\s+-\s+/, '').trim()).filter(Boolean) : [];
}

/** Split on commas that are not inside parentheses: "Read, Agent(a, b)" gives ["Read", "Agent(a, b)"]. */
function toolList(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function makeReaders(dir, { fixes = [], notes = {}, transform = (s) => s, rename = (n) => n, perAgentSkills = false }) {
  const fix = (s) => transform(fixes.reduce((acc, [re, to]) => acc.replace(re, to), s));
  return {
    agent(name) {
      const file = path.join(dir, 'agents', `${name}.md`);
      if (!fs.existsSync(file)) throw new Error(`agent not found: ${file}`);
      const { fm, body } = split(fs.readFileSync(file, 'utf8'));
      const declared = scalar(fm, 'tools');
      const tools = (declared ? toolList(declared) : WORK_TOOLS).filter((t) => t !== 'PowerShell');
      const model = scalar(fm, 'model') ?? 'sonnet';
      const out = {
        name: rename(name),
        description: fix(scalar(fm, 'description') ?? name),
        tools,
        model: ['haiku', 'sonnet', 'opus', 'inherit'].includes(model) ? model : 'sonnet',
        prompt: (notes[name] ?? '') + fix(body.trim()) + '\n',
      };
      if (perAgentSkills) out.skills = listField(fm, 'skills');
      return out;
    },
    skill(name, note = '') {
      const file = path.join(dir, 'skills', name, 'SKILL.md');
      if (!fs.existsSync(file)) throw new Error(`skill not found: ${file}`);
      const { fm, body } = split(fs.readFileSync(file, 'utf8'));
      return { name, description: fix(scalar(fm, 'description') ?? name), body: note + fix(body.trim()) + '\n' };
    },
  };
}

function write(file, exportName, source, roles) {
  fs.writeFileSync(path.join(root, file), JSON.stringify(roles, null, 2) + String.fromCharCode(10));
  const agents = roles.reduce((n, r) => n + 1 + (r.team?.length ?? 0), 0);
  const skills = new Set(roles.flatMap((r) => r.skills.map((s) => s.name))).size;
  console.log(`${file}: ${roles.length} role${roles.length === 1 ? '' : 's'}, ${agents} agents, ${skills} skills (from ${source})`);
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

if (!only || only === 'claude') {
  const dir = path.resolve(arg('--from') ?? path.join(os.homedir(), '.claude'));
  const r = makeReaders(dir, { fixes: CLAUDE_FIXES, notes: CLAUDE_NOTES });
  const roles = CLAUDE_ROLES.map((def) => {
    const [lead, ...team] = def.agents.map(r.agent);
    const out = { key: def.key, title: def.title, summary: def.summary, agent: lead };
    if (team.length) out.team = team;
    out.skills = def.skills.map((s) => r.skill(s));
    return out;
  });
  write('server/role-data/roles-library.json', 'LIBRARY_ROLES', dir, roles);
}

if (!only || only === 'delivery') {
  const base = path.resolve(arg('--delivery') ?? path.join(os.homedir(), 'Desktop', 'ai-delivery-team (claude)'));
  const dir = path.join(base, '.claude');
  const notes = Object.fromEntries(DELIVERY_AGENTS.map((n) => [n, PORTAL_PATHS]));
  const fixes = [[/`CLAUDE\.md`/g, '`delivery-conventions` skill']];
  const r = makeReaders(dir, { fixes, notes, transform: renameAgents, rename: delName, perAgentSkills: true });

  const [lead, ...team] = DELIVERY_AGENTS.map(r.agent);
  // The team conventions file becomes a skill, because the portal writes its own CLAUDE.md for every project.
  const conventions = fs.readFileSync(path.join(base, 'CLAUDE.md'), 'utf8').replace(/\r\n/g, '\n');
  const conventionsBody = renameAgents(conventions.replace(/^# .*\n+/, '').replace(/\bin this file\b/g, 'in this skill').replace(/\bthis file,/g, 'this skill,'));
  const skills = DELIVERY_SKILLS.map((n) => r.skill(n, n === 'deliver-project' ? DELIVER_NOTE : ''));
  skills.push({
    name: 'delivery-conventions',
    description: 'Use in every AI delivery team task: the ID and traceability conventions, coordination protocol, default technology stack and global rules every delivery agent follows.',
    body: '# AI Delivery Team: project conventions\n\n' + conventionsBody.trim() + '\n',
  });
  // Every delivery agent also reads the conventions.
  for (const a of [lead, ...team]) if (!a.skills.includes('delivery-conventions')) a.skills.push('delivery-conventions');

  const role = {
    key: 'ai-delivery-team',
    title: 'AI delivery team',
    summary: 'Takes a requirements document (FRD/BRD) to planned, designed, implemented and tested code with AWS infrastructure and CI/CD, using nine roles, quality gates and a requirement-to-test trace. Run the deliver-project skill with a repository selected; it never deploys.',
    agent: lead,
    team,
    skills,
  };
  write('server/role-data/roles-delivery.json', 'DELIVERY_ROLES', base, [role]);
}
