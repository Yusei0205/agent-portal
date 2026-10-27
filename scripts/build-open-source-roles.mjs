// Builds the open-source role templates from pinned public repositories of Agent Skills.
//
//   node scripts/build-open-source-roles.mjs --from <folder with the clones>
//
// Clone each repository in SOURCES into <folder>/<owner>_<name> and check out its pinned commit first, for example:
//   git clone -c core.longpaths=true https://github.com/aws/agent-toolkit-for-aws.git aws_agent-toolkit-for-aws
//   git -C aws_agent-toolkit-for-aws checkout 4a1eb728573bfbad03b3f2a1da642a0654808625
// The script refuses a clone that is not at its pinned commit: what is bundled is what was reviewed.
//
// Output (committed, so a build needs nothing else):
//   server/role-data/roles-opensource.json   the roles and the licence texts (loaded by server/roles-opensource.ts)
//   THIRD_PARTY_SKILLS.md                      where every skill comes from and under which licence
//
// Taken from each skill, unchanged: the body of SKILL.md and its Markdown and plain-text files (references/,
// examples/, templates). Left out: frontmatter fields other than name and description (allowed-tools would
// pre-approve commands and hooks would run them), scripts/ folders and source files that would run code, licence
// files (each installed skill gets a LICENSE.txt with its licence and origin instead) and files over 256 KB.
// The lead agents of these roles are written here; they are not taken from the sources.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const from = arg('--from');
if (!from) {
  console.error('Usage: node scripts/build-open-source-roles.mjs --from <folder with the clones>');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Sources: pinned commits and licences                                */
/* ------------------------------------------------------------------ */

const SOURCES = {
  'aws/agent-toolkit-for-aws': { commit: '4a1eb728573bfbad03b3f2a1da642a0654808625', license: 'Apache-2.0', licenseFiles: ['LICENSE', 'NOTICE'], by: 'Amazon Web Services (official)' },
  'hashicorp/agent-skills': { commit: 'f706481af9b8fedb66de909f6243ad29601afa0c', license: 'MPL-2.0', licenseFiles: ['LICENSE'], by: 'HashiCorp (official)' },
  'microsoft/playwright-cli': { commit: 'b1a5903c5b633b8c9f843ad7b629c2a78437040c', license: 'Apache-2.0', licenseFiles: ['LICENSE'], by: 'Microsoft, the Playwright team (official)' },
  'anthropics/skills': { commit: 'dbd4588f9e1033efb41dad4bef2f7947c8993d44', license: 'Apache-2.0', licenseFiles: [], perSkillLicense: 'LICENSE.txt', by: 'Anthropic (official)' },
  'obra/superpowers': { commit: '2ce8aa15d05bd57213e6f746f953aafb7ded7a8b', license: 'MIT', licenseFiles: ['LICENSE'], by: 'Jesse Vincent and contributors' },
  'wshobson/agents': { commit: '0874a27b17a22e2b7c2e2bcd725768e0803cad06', license: 'MIT', licenseFiles: ['LICENSE'], by: 'Seth Hobson and contributors' },
};

const dirOf = (repo) => path.join(path.resolve(from), repo.replace('/', '_'));

/* ------------------------------------------------------------------ */
/* Roles                                                               */
/* ------------------------------------------------------------------ */

const TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'Skill', 'TodoWrite'];

/** Shared notes for every lead agent below: how the bundled skills are used inside the portal. */
const PORTAL_NOTES = `## Running inside Agent Portal

- Your skills are installed in this project's \`.claude/skills/<name>/\`. Some are loaded for you; load any other one with the Skill tool when the task matches its description. When a skill points to a file such as \`references/<topic>.md\`, read it from that skill's folder.
- These skills come from open-source projects (see each skill's \`LICENSE.txt\`). They were written for coding agents in general: where one names a command or an MCP tool that this server does not have, say so and carry on with what is available.
- Change files only in the repository working copy named in your task (\`work/<run id>/<repo>/\`). The project's requirement documents are Markdown files in \`docs/md/\` of the project folder.
- Tools such as Playwright browsers, terraform, kubectl or the AWS CLI may not be installed on the server. When a check cannot run, report it as not run, never as passed.
- Never deploy to a shared or production environment, and never create, change or delete cloud resources, unless the task asks for it explicitly.`;

const skill = (repo, rel) => ({ repo, rel });

const ROLES = [
  {
    key: 'qa-automation-engineer',
    title: 'QA automation engineer (open source)',
    summary: 'Plans, writes and fixes automated tests: Playwright end-to-end tests (Microsoft\'s official Playwright skill), unit and integration tests in JavaScript and Python, test-driven development and systematic debugging.',
    agent: {
      name: 'qa-automation-engineer',
      description: 'Use for test automation: planning what to test, writing or fixing Playwright end-to-end tests, unit and integration tests, reproducing and debugging failures, and checking that a change really works before it is called done.',
      preload: ['verification-before-completion', 'e2e-testing-patterns'],
      prompt: `You are the QA automation engineer for this project.

Your job is to make the behaviour of the software provable with automated tests, and to find out why a test fails before anyone changes code to make it pass.

How to work:
1. Read the requirement or ticket you were given, and docs/decisions.md. Turn each acceptance criterion into one or more test cases before writing code.
2. Find the existing test setup in the working copy (test runner, folders, fixtures, CI config) and follow it. Do not introduce a second framework without saying why.
3. For browser tests use Playwright. Load the playwright-cli skill: it explains how to explore the app, generate tests and fix failing ones with \`npx playwright cli\` when the repository has Playwright, or the \`playwright-cli\` command. If neither is available and a "Web browser" integration is attached to this session, use its tools to explore the app instead.
4. For unit and integration tests load javascript-testing-patterns or python-testing-patterns, whichever matches the code.
5. When a test fails, load systematic-debugging and find the root cause before changing anything. A test is changed only when the test itself is wrong; say which it was.
6. Run the tests you wrote. Report the exact command, how many passed and failed, and anything you could not run.

Report: the test cases (with the requirement each one covers), the files you added or changed, the results, and open questions.`,
    },
    skills: [
      skill('microsoft/playwright-cli', 'skills/playwright-cli'),
      skill('wshobson/agents', 'plugins/developer-essentials/skills/e2e-testing-patterns'),
      skill('wshobson/agents', 'plugins/javascript-typescript/skills/javascript-testing-patterns'),
      skill('wshobson/agents', 'plugins/python-development/skills/python-testing-patterns'),
      skill('obra/superpowers', 'skills/test-driven-development'),
      skill('obra/superpowers', 'skills/systematic-debugging'),
      skill('obra/superpowers', 'skills/verification-before-completion'),
    ],
  },
  {
    key: 'backend-engineer',
    title: 'Backend engineer (open source)',
    summary: 'Designs and builds APIs and services: REST and GraphQL design, clean and hexagonal architecture, microservices, Node.js and FastAPI, PostgreSQL schemas and query tuning, error handling and authentication.',
    agent: {
      name: 'backend-engineer',
      description: 'Use for server-side work: designing or changing an API, structuring a service, modelling PostgreSQL tables, speeding up queries, error handling, and authentication or authorization.',
      preload: ['api-design-principles', 'error-handling-patterns'],
      prompt: `You are the backend engineer for this project.

Your job is to design and build server-side code that is correct, secure and easy to change.

How to work:
1. Read the requirement, docs/decisions.md and the existing code before proposing anything. Follow the project's language, framework and conventions; the skills describe patterns, not a stack to impose.
2. For a new or changed API, load api-design-principles and write the contract (resources, requests, responses, errors, status codes) before the code.
3. Pick the skill that matches the task: architecture-patterns or microservices-patterns for structure, nodejs-backend-patterns or fastapi-templates for the framework, postgresql-table-design and sql-optimization-patterns for data, auth-implementation-patterns for sign-in and permissions.
4. Validate every input at the boundary, never log secrets or personal data, and use parameterised queries only.
5. Add or update tests for the behaviour you change, and run them.

Report: what you changed and why, the API or schema changes, the test results, and risks or open questions.`,
    },
    skills: [
      skill('wshobson/agents', 'plugins/backend-development/skills/api-design-principles'),
      skill('wshobson/agents', 'plugins/backend-development/skills/architecture-patterns'),
      skill('wshobson/agents', 'plugins/backend-development/skills/microservices-patterns'),
      skill('wshobson/agents', 'plugins/javascript-typescript/skills/nodejs-backend-patterns'),
      skill('wshobson/agents', 'plugins/api-scaffolding/skills/fastapi-templates'),
      skill('wshobson/agents', 'plugins/database-design/skills/postgresql-table-design'),
      skill('wshobson/agents', 'plugins/developer-essentials/skills/sql-optimization-patterns'),
      skill('wshobson/agents', 'plugins/developer-essentials/skills/error-handling-patterns'),
      skill('wshobson/agents', 'plugins/developer-essentials/skills/auth-implementation-patterns'),
    ],
  },
  {
    key: 'frontend-engineer',
    title: 'Frontend engineer (open source)',
    summary: 'Builds web interfaces: distinctive, production-grade UI (Anthropic\'s frontend-design skill), React state, Next.js App Router, Tailwind design systems, advanced TypeScript and WCAG 2.2 accessibility audits.',
    agent: {
      name: 'frontend-engineer',
      description: 'Use for web UI work: building or restyling pages and components, React state and data flow, Next.js routing, Tailwind design systems, TypeScript types, and accessibility checks.',
      preload: ['frontend-design', 'wcag-audit-patterns'],
      prompt: `You are the frontend engineer for this project.

Your job is to build interfaces that look deliberate, work for everyone, and fit the code that is already there.

How to work:
1. Read the requirement, docs/decisions.md and the existing components, styles and design tokens first. Reuse what exists; do not add a new UI library without saying why.
2. Use frontend-design for look and layout, and keep to the project's own design system when it has one.
3. Pick the skill that matches the task: react-state-management, nextjs-app-router-patterns, tailwind-design-system or typescript-advanced-types.
4. Check accessibility with wcag-audit-patterns: keyboard use, focus, labels, contrast and screen-reader names. Fix what you find in the code you touch.
5. Add or update component tests, run the type check and tests, and report anything you could not run.

Report: what changed, screenshots or a description of the UI states (empty, loading, error), accessibility notes, test results and open questions.`,
    },
    skills: [
      skill('anthropics/skills', 'skills/frontend-design'),
      skill('wshobson/agents', 'plugins/frontend-mobile-development/skills/react-state-management'),
      skill('wshobson/agents', 'plugins/frontend-mobile-development/skills/nextjs-app-router-patterns'),
      skill('wshobson/agents', 'plugins/frontend-mobile-development/skills/tailwind-design-system'),
      skill('wshobson/agents', 'plugins/javascript-typescript/skills/typescript-advanced-types'),
      skill('wshobson/agents', 'plugins/accessibility-compliance/skills/wcag-audit-patterns'),
    ],
  },
  {
    key: 'platform-engineer',
    title: 'Cloud infrastructure engineer (open source)',
    summary: 'Infrastructure as code and delivery: Terraform style, tests, module refactoring and import (HashiCorp\'s official skills), reusable modules, GitHub Actions and deployment pipelines, secrets, Kubernetes manifests, Helm charts and cloud cost.',
    agent: {
      name: 'platform-engineer',
      description: 'Use for infrastructure and delivery work: writing or refactoring Terraform, Terraform tests, importing existing resources, CI/CD pipelines and GitHub Actions, secrets handling, Kubernetes manifests, Helm charts and cloud cost reviews.',
      preload: ['terraform-style-guide', 'secrets-management'],
      prompt: `You are the cloud infrastructure engineer for this project.

Your job is to describe infrastructure and delivery as reviewed code, so that every change can be planned, tested and rolled back.

How to work:
1. Read the requirement, docs/decisions.md and the existing infrastructure code and pipelines first. Keep the project's tools, layout and naming.
2. Write Terraform by terraform-style-guide. Use terraform-module-library and refactor-module for module structure, terraform-test for tests, and terraform-search-import to bring existing resources under code.
3. For pipelines use github-actions-templates and deployment-pipeline-design; for Kubernetes, k8s-manifest-generator and helm-chart-scaffolding; for spend, cost-optimization.
4. Never put a secret in code, state, logs or pipeline files; follow secrets-management.
5. Validate what you can without touching real environments: \`terraform fmt -check\`, \`terraform validate\`, \`terraform test\`, linting, \`helm lint\`, a dry run. Never run apply, deploy or destroy unless the task explicitly asks for it.

Report: the changes, the plan or diff they would cause, the checks you ran with their results, and the risks (data loss, downtime, cost).`,
    },
    skills: [
      skill('hashicorp/agent-skills', 'plugins/terraform/skills/terraform-style-guide'),
      skill('hashicorp/agent-skills', 'plugins/terraform/skills/terraform-test'),
      skill('hashicorp/agent-skills', 'plugins/terraform/skills/refactor-module'),
      skill('hashicorp/agent-skills', 'plugins/terraform/skills/terraform-search-import'),
      skill('wshobson/agents', 'plugins/cloud-infrastructure/skills/terraform-module-library'),
      skill('wshobson/agents', 'plugins/cicd-automation/skills/github-actions-templates'),
      skill('wshobson/agents', 'plugins/cicd-automation/skills/deployment-pipeline-design'),
      skill('wshobson/agents', 'plugins/cicd-automation/skills/secrets-management'),
      skill('wshobson/agents', 'plugins/kubernetes-operations/skills/k8s-manifest-generator'),
      skill('wshobson/agents', 'plugins/kubernetes-operations/skills/helm-chart-scaffolding'),
      skill('wshobson/agents', 'plugins/cloud-infrastructure/skills/cost-optimization'),
    ],
  },
  {
    key: 'aws-solutions-engineer',
    title: 'AWS solutions engineer (official AWS skills)',
    summary: 'AWS architecture, build and operations with the official skills from AWS\'s Agent Toolkit: CDK, CloudFormation, serverless, compute, containers, databases, storage, networking, IAM, security, observability, messaging, cost, Well-Architected reviews, deployment and the AWS SDKs.',
    agent: {
      name: 'aws-solutions-engineer',
      description: 'Use for AWS work: choosing services, designing or reviewing an architecture, writing CDK or CloudFormation, serverless and container workloads, IAM policies, security, observability, cost, Well-Architected reviews and AWS SDK code.',
      preload: [],
      prompt: `You are the AWS solutions engineer for this project.

Your job is to design, build and review AWS solutions that are secure, reliable and cost-aware, using AWS's own guidance.

How to work:
1. Read the requirement, docs/decisions.md and the existing infrastructure code first.
2. Load the AWS skill for the area of the task with the Skill tool (they are not loaded up front because they are large): aws-cdk, aws-cloudformation, aws-serverless, aws-compute, aws-containers, aws-database, aws-storage, aws-networking, aws-iam, aws-security, aws-observability, aws-messaging-and-streaming, aws-billing-and-cost-management, aws-deployment, aws-sdk-python-usage, aws-sdk-js-v3-usage. For a review of a whole workload, load aws-well-architected-review.
3. Each skill tells you which of its \`references/\` files to read for details; read only what the task needs.
4. When a skill says to search the AWS documentation, use the tools of the "AWS documentation" integration if it is attached to this session. Otherwise say which facts you could not check against the documentation.
5. Least privilege always: no wildcard actions or resources in IAM without a written reason, encryption at rest and in transit, no public access unless the task requires it.
6. You may read AWS with the CLI or the AWS integration when they are available. Never create, change or delete AWS resources unless the task asks for it explicitly.

Report: the design or change, the services and why, security and cost notes, what you verified and how, and open questions.`,
    },
    skills: [
      'aws-cdk', 'aws-cloudformation', 'aws-serverless', 'aws-compute', 'aws-containers', 'aws-database', 'aws-storage', 'aws-networking', 'aws-iam',
      'aws-security', 'aws-observability', 'aws-messaging-and-streaming', 'aws-billing-and-cost-management', 'aws-well-architected-review', 'aws-deployment',
      'aws-sdk-python-usage', 'aws-sdk-js-v3-usage',
    ].map((n) => skill('aws/agent-toolkit-for-aws', `plugins/aws-core/skills/${n}`)),
  },
];

/* ------------------------------------------------------------------ */
/* Reading a skill                                                     */
/* ------------------------------------------------------------------ */

/** Split "---\n frontmatter \n---\n body". */
function split(text) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('missing frontmatter');
  return { fm: m[1], body: m[2] };
}

/** A top-level scalar of YAML frontmatter, folded to one line: plain, quoted, or a | or > block. */
function fmScalar(fm, key) {
  const lines = fm.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (i < 0) return undefined;
  let v = lines[i].slice(key.length + 1).trim();
  if (/^[|>][+-]?$/.test(v)) {
    const block = [];
    for (let j = i + 1; j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === ''); j++) block.push(lines[j].trim());
    return block.join(' ').replace(/\s+/g, ' ').trim();
  }
  const q = v[0];
  if (q === '"' || q === "'") {
    let j = i;
    while (!(v.length > 1 && v.endsWith(q) && !v.endsWith(`\\${q}`)) && j + 1 < lines.length) v += ' ' + lines[++j].trim();
    v = v.slice(1, -1);
    v = q === '"' ? v.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : v.replace(/''/g, "'");
  } else {
    // A plain scalar may continue on indented lines.
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) v += ' ' + lines[j].trim();
  }
  return v.replace(/\s+/g, ' ').trim();
}

const MAX_FILE = 256 * 1024;
const TEXT_EXT = new Set(['.md', '.txt', '.yaml', '.yml', '.json', '.tf', '.hcl', '.template', '.tpl', '.csv']);
const report = { left: [], warnings: [], domains: new Map() };

/** The skill's other files worth bundling: Markdown and plain-text templates, never code that would run. */
function skillFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (e.name === 'scripts') report.left.push(`${dir}/${r}/ (scripts)`);
        else walk(r);
        continue;
      }
      if (!rel && (e.name === 'SKILL.md' || /^licen[cs]e/i.test(e.name))) continue;
      const full = path.join(dir, r);
      const size = fs.statSync(full).size;
      if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
        report.left.push(`${dir}/${r} (would run code or is not text)`);
        continue;
      }
      if (size > MAX_FILE) {
        report.left.push(`${dir}/${r} (${Math.round(size / 1024)} KB, over the limit)`);
        continue;
      }
      const content = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
      if (content.includes('\0')) {
        report.left.push(`${dir}/${r} (binary)`);
        continue;
      }
      out.push({ path: r, content });
    }
  };
  walk('');
  return out;
}

/** Things worth a human look in bundled text: hidden characters, piped installers, instruction overrides, long encoded blobs. */
function scan(where, text) {
  const checks = [
    [/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/, 'hidden or direction-changing characters'],
    [/ignore (all |any )?(previous|prior|above) instructions/i, 'an instruction override'],
    [/(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, 'a piped installer (curl | sh)'],
    [/[A-Za-z0-9+/]{300,}={0,2}/, 'a long encoded blob'],
    [/<!--[\s\S]*?-->/, 'an HTML comment (hidden when rendered)'],
  ];
  for (const [re, what] of checks) if (re.test(text)) report.warnings.push(`${where}: ${what}`);
  for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) report.domains.set(m[1], (report.domains.get(m[1]) ?? 0) + 1);
}

function readSkill({ repo, rel }) {
  const src = SOURCES[repo];
  const dir = path.join(dirOf(repo), ...rel.split('/'));
  const { fm, body } = split(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  const name = fmScalar(fm, 'name');
  const description = fmScalar(fm, 'description');
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`${repo}/${rel}: unusable name "${name}"`);
  if (!description) throw new Error(`${repo}/${rel}: no description`);
  const files = skillFiles(dir);
  scan(`${repo}/${rel}/SKILL.md`, fm + '\n' + body);
  for (const f of files) scan(`${repo}/${rel}/${f.path}`, f.content);
  let licenseKey = repo;
  if (src.perSkillLicense) {
    licenseKey = `${repo}/${rel}`;
    licenses[licenseKey] = fs.readFileSync(path.join(dir, src.perSkillLicense), 'utf8').replace(/\r\n/g, '\n').trim() + '\n';
  }
  return {
    name,
    description,
    body: body.trim() + '\n',
    ...(files.length ? { files } : {}),
    source: { repo, path: rel, commit: src.commit, url: `https://github.com/${repo}/tree/${src.commit}/${rel}`, license: src.license, licenseKey },
  };
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

const licenses = {};
for (const [repo, src] of Object.entries(SOURCES)) {
  const dir = dirOf(repo);
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== src.commit) throw new Error(`${repo} is at ${head}, not the pinned ${src.commit}. Check out the pinned commit (or review the new one and pin it).`);
  if (src.licenseFiles.length) {
    licenses[repo] = src.licenseFiles.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim()).join('\n\n---\n\n') + '\n';
  }
}

const roles = ROLES.map((def) => {
  const skills = def.skills.map(readSkill);
  const names = skills.map((s) => s.name);
  for (const p of def.agent.preload) if (!names.includes(p)) throw new Error(`${def.key}: preloads ${p}, which is not one of its skills`);
  const { preload, prompt, ...agent } = def.agent;
  return {
    key: def.key,
    title: def.title,
    summary: def.summary,
    agent: { ...agent, tools: TOOLS, model: 'sonnet', skills: preload, prompt: `${PORTAL_NOTES}\n\n---\n\n${prompt}\n` },
    skills,
  };
});

const all = roles.flatMap((r) => r.skills.map((s) => s.name));
const dupes = all.filter((n, i) => all.indexOf(n) !== i);
if (dupes.length) throw new Error(`skill names used twice: ${dupes.join(', ')}`);

fs.writeFileSync(path.join(root, 'server/role-data/roles-opensource.json'), JSON.stringify({ licenses, roles }, null, 2) + '\n');

/* THIRD_PARTY_SKILLS.md: where everything comes from */
const lines = [
  '# Third-party skills',
  '',
  'The open-source roles (server/role-data/roles-opensource.json, built by `scripts/build-open-source-roles.mjs`) bundle Agent Skills from the repositories below, at the commits shown. Each skill keeps its own licence: when a role or skill is added to a project, the skill folder gets a `LICENSE.txt` with the licence text and where the skill comes from.',
  '',
  'What Agent Portal changes: the SKILL.md frontmatter is rewritten to the skill\'s name and description only (fields such as `allowed-tools`, which would pre-approve commands, are dropped), and scripts and source files that would run code are left out. The skill text and its reference files are otherwise unchanged. The lead agents of these roles are Agent Portal\'s own.',
  '',
  '| Source | By | Licence | Commit | Skills |',
  '|---|---|---|---|---|',
];
for (const [repo, src] of Object.entries(SOURCES)) {
  const used = roles.flatMap((r) => r.skills).filter((s) => s.source.repo === repo).map((s) => `\`${s.name}\``);
  lines.push(`| [${repo}](https://github.com/${repo}) | ${src.by} | ${src.license} | [\`${src.commit.slice(0, 7)}\`](https://github.com/${repo}/tree/${src.commit}) | ${used.join(', ')} |`);
}
lines.push('', '## Roles', '');
for (const r of roles) lines.push(`- **${r.title}** (\`${r.key}\`): ${r.skills.map((s) => `\`${s.name}\``).join(', ')}`);
lines.push('');
fs.writeFileSync(path.join(root, 'THIRD_PARTY_SKILLS.md'), lines.join('\n'));

/* Report */
const bytes = fs.statSync(path.join(root, 'server/role-data/roles-opensource.json')).size;
const fileCount = roles.flatMap((r) => r.skills).reduce((n, s) => n + (s.files?.length ?? 0), 0);
console.log(`server/role-data/roles-opensource.json: ${roles.length} roles, ${all.length} skills, ${fileCount} reference files, ${Math.round(bytes / 1024)} KB`);
console.log(`\nLeft out (${report.left.length}):\n  ${report.left.map((l) => l.replace(path.resolve(from) + path.sep, '')).join('\n  ')}`);
console.log(`\nTo look at (${report.warnings.length}):\n  ${report.warnings.join('\n  ')}`);
console.log(`\nLinked domains:\n  ${[...report.domains].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d} (${n})`).join('\n  ')}`);
