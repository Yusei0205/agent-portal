import fs from 'node:fs';
import path from 'node:path';
import { all, one, run } from './db.ts';
import { del, get, post, put } from './http.ts';
import { dataPath } from './config.ts';
import { commitProject, notifyProject, projectDir, requireProject, type Project } from './projects.ts';
import {
  assertName,
  badRequest,
  listValue,
  notFound,
  now,
  parseFrontmatter,
  safeJoin,
  str,
  stringifyFrontmatter,
} from './util.ts';
import { ROLE_TEMPLATES, roleAgents, roleTemplate } from './roles.ts';

export const KNOWN_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookEdit', 'Skill'];
const MODELS = ['inherit', 'haiku', 'sonnet', 'opus'];

export interface AgentFile {
  name: string;
  description: string;
  tools: string[];
  model: string;
  skills: string[];
  prompt: string;
  enabled: boolean;
  role: string | null;
}

export interface SkillFile {
  name: string;
  description: string;
  body: string;
  allowedTools: string[];
  files: string[];
  enabled: boolean;
  role: string | null;
}

function claudeDir(p: Project, enabled = true): string {
  return path.join(projectDir(p), '.claude', enabled ? '' : '_disabled');
}

function agentPath(base: string, name: string): string {
  return path.join(base, 'agents', `${name}.md`);
}

function readAgent(file: string, enabled: boolean): AgentFile | null {
  try {
    const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const name = (data.name as string) || path.basename(file, '.md');
    return {
      name,
      description: (data.description as string) || '',
      tools: listValue(data.tools),
      model: (data.model as string) || 'inherit',
      skills: listValue(data.skills),
      prompt: body.trim(),
      enabled,
      role: (data['portal-role'] as string) || null,
    };
  } catch {
    return null;
  }
}

export function listAgentFiles(p: Project): AgentFile[] {
  const out: AgentFile[] = [];
  for (const enabled of [true, false]) {
    const dir = path.join(claudeDir(p, enabled), 'agents');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
      const a = readAgent(path.join(dir, f), enabled);
      if (a) out.push(a);
    }
  }
  return out;
}

function readSkill(dir: string, enabled: boolean): SkillFile | null {
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  const files: string[] = [];
  const walk = (d: string, rel: string, depth: number) => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r, depth + 1);
      else if (r !== 'SKILL.md') files.push(r);
    }
  };
  walk(dir, '', 0);
  return {
    name: (data.name as string) || path.basename(dir),
    description: (data.description as string) || '',
    body: body.trim(),
    allowedTools: listValue(data['allowed-tools']),
    files: files.sort(),
    enabled,
    role: (data['portal-role'] as string) || null,
  };
}

export function listSkills(p: Project): SkillFile[] {
  const out: SkillFile[] = [];
  for (const enabled of [true, false]) {
    const dir = path.join(claudeDir(p, enabled), 'skills');
    if (!fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      const s = readSkill(path.join(dir, d), enabled);
      if (s) out.push(s);
    }
  }
  return out;
}

export function listSkillNames(p: Project): string[] {
  return listSkills(p).filter((s) => s.enabled).map((s) => s.name);
}

function findAgent(p: Project, name: string): { file: string; enabled: boolean } | null {
  for (const enabled of [true, false]) {
    const f = agentPath(claudeDir(p, enabled), name);
    if (fs.existsSync(f)) return { file: f, enabled };
  }
  return null;
}

function findSkill(p: Project, name: string): { dir: string; enabled: boolean } | null {
  for (const enabled of [true, false]) {
    const d = path.join(claudeDir(p, enabled), 'skills', name);
    if (fs.existsSync(path.join(d, 'SKILL.md'))) return { dir: d, enabled };
  }
  return null;
}

function checkTools(v: unknown): string[] {
  const tools = Array.isArray(v) ? v.map(String) : listValue(typeof v === 'string' ? v : '');
  for (const t of tools) {
    if (!/^[A-Za-z][A-Za-z0-9_]*(\(.{0,200}\))?$|^mcp__[A-Za-z0-9_-]+$/.test(t)) throw badRequest(`Tool name "${t}" is not valid`);
  }
  return [...new Set(tools)];
}

export function writeAgentFile(file: string, a: Omit<AgentFile, 'enabled'>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    stringifyFrontmatter(
      {
        name: a.name,
        description: a.description,
        tools: a.tools,
        model: a.model && a.model !== 'inherit' ? a.model : undefined,
        skills: a.skills,
        'portal-role': a.role ?? undefined,
      },
      a.prompt.trim() + '\n',
    ),
  );
}

export function writeSkillFile(dir: string, s: { name: string; description: string; body: string; allowedTools?: string[]; role?: string | null }): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    stringifyFrontmatter(
      { name: s.name, description: s.description, 'allowed-tools': s.allowedTools ?? [], 'portal-role': s.role ?? undefined },
      s.body.trim() + '\n',
    ),
  );
}

function agentInput(body: any, name: string, existingRole: string | null): Omit<AgentFile, 'enabled'> {
  const description = str(body.description, 'Description', { max: 1000 }).trim();
  const prompt = str(body.prompt, 'Instructions', { max: 50_000 });
  const model = body.model ?? 'inherit';
  if (!MODELS.includes(model) && !/^[A-Za-z0-9._:\/-]{3,120}$/.test(model)) throw badRequest('Model is not valid');
  const skills = (Array.isArray(body.skills) ? body.skills : listValue(body.skills ?? '')).map((s: unknown) => assertName(s, 'Skill name'));
  return { name, description, prompt, model, tools: checkTools(body.tools ?? []), skills, role: existingRole };
}

const TEXT_FILE_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){0,2}$/;

function checkSkillFilePath(rel: unknown): string {
  if (typeof rel !== 'string' || !TEXT_FILE_RE.test(rel) || rel.split('/').some((s) => s === '..' || s.startsWith('.')) || rel === 'SKILL.md') {
    throw badRequest('File path must be like reference.md or scripts/check.py');
  }
  return rel;
}

/* ------------------------------------------------------------------ */
/* Roles                                                               */
/* ------------------------------------------------------------------ */

export async function applyRole(p: Project, key: string, userId: string): Promise<void> {
  const t = roleTemplate(key);
  if (!t) throw notFound('Role template not found');
  const base = claudeDir(p, true);
  for (const a of roleAgents(t)) {
    writeAgentFile(agentPath(base, a.name), {
      name: a.name,
      description: a.description,
      tools: a.tools,
      model: a.model,
      // Unless the template says otherwise, the lead preloads the role's skills and team members use them through it.
      skills: a.skills ?? (a === t.agent ? t.skills.map((s) => s.name) : []),
      prompt: a.prompt,
      role: t.key,
    });
    // A previously disabled copy would shadow nothing but confuses the list; remove it.
    fs.rmSync(agentPath(claudeDir(p, false), a.name), { force: true });
  }
  for (const s of t.skills) {
    writeSkillFile(path.join(base, 'skills', s.name), { ...s, role: t.key });
    fs.rmSync(path.join(claudeDir(p, false), 'skills', s.name), { recursive: true, force: true });
  }
  run(
    `INSERT INTO project_roles (project_id, role_key, enabled, applied_by, applied_at) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(project_id, role_key) DO UPDATE SET enabled = 1, applied_by = excluded.applied_by, applied_at = excluded.applied_at`,
    p.id,
    key,
    userId,
    now(),
  );
  await commitProject(p.id, `Add role: ${t.title}`, ['.claude']);
}

/** Every skill carried by a role template, once each, with the roles that include it. Sorted by name. */
function skillCatalog(): { name: string; description: string; body: string; roles: { key: string; title: string }[] }[] {
  const byName = new Map<string, { name: string; description: string; body: string; roles: { key: string; title: string }[] }>();
  for (const t of ROLE_TEMPLATES) {
    for (const s of t.skills) {
      const e = byName.get(s.name) ?? { name: s.name, description: s.description, body: s.body, roles: [] };
      e.roles.push({ key: t.key, title: t.title });
      byName.set(s.name, e);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Skill names used by the other roles applied to this project (optionally only those that are switched on). */
function skillsOfOtherRoles(p: Project, key: string, onlyEnabled: boolean): Set<string> {
  const rows = all<{ role_key: string }>(`SELECT role_key FROM project_roles WHERE project_id = ? AND role_key != ?${onlyEnabled ? ' AND enabled = 1' : ''}`, p.id, key);
  const names = new Set<string>();
  for (const r of rows) for (const s of roleTemplate(r.role_key)?.skills ?? []) names.add(s.name);
  return names;
}

function moveItem(from: string, to: string): void {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(from, to);
}

export async function setRoleEnabled(p: Project, key: string, enabled: boolean): Promise<void> {
  const t = roleTemplate(key);
  if (!t) throw notFound('Role template not found');
  const from = claudeDir(p, !enabled);
  const to = claudeDir(p, enabled);
  for (const a of roleAgents(t)) moveItem(agentPath(from, a.name), agentPath(to, a.name));
  // Turning a role off must not take away a skill another role that is still on relies on.
  const keep = enabled ? new Set<string>() : skillsOfOtherRoles(p, key, true);
  for (const s of t.skills) if (!keep.has(s.name)) moveItem(path.join(from, 'skills', s.name), path.join(to, 'skills', s.name));
  run('UPDATE project_roles SET enabled = ? WHERE project_id = ? AND role_key = ?', enabled ? 1 : 0, p.id, key);
  await commitProject(p.id, `${enabled ? 'Enable' : 'Disable'} role: ${t.title}`, ['.claude']);
}

/* ------------------------------------------------------------------ */
/* Library                                                             */
/* ------------------------------------------------------------------ */

const libDir = (type: 'agents' | 'skills') => dataPath('library', type);

function listLibrary() {
  const agents = fs.existsSync(libDir('agents'))
    ? fs.readdirSync(libDir('agents')).filter((f) => f.endsWith('.md')).map((f) => readAgent(path.join(libDir('agents'), f), true)).filter(Boolean)
    : [];
  const skills = fs.existsSync(libDir('skills'))
    ? fs.readdirSync(libDir('skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => readSkill(path.join(libDir('skills'), e.name), true)).filter(Boolean)
    : [];
  return { agents, skills };
}

function libType(t: unknown): 'agents' | 'skills' {
  if (t !== 'agents' && t !== 'skills') throw badRequest('Type must be agents or skills');
  return t;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function registerBuilderRoutes(): void {
  get('/api/tools', () => ({ tools: KNOWN_TOOLS, models: MODELS }));

  // ---- Agents ----
  get('/api/projects/:pid/agents', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return { agents: listAgentFiles(project) };
  });

  put('/api/projects/:pid/agents/:name', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const name = assertName(ctx.params.name, 'Agent name');
    const body = await ctx.json();
    const existing = findAgent(project, name);
    const prev = existing ? readAgent(existing.file, existing.enabled) : null;
    if (!existing && listSkills(project).some((s) => s.name === name)) {
      // Allowed, but warn the UI via the response.
    }
    const file = existing?.file ?? agentPath(claudeDir(project, true), name);
    writeAgentFile(file, agentInput(body, name, prev?.role ?? null));
    await commitProject(project.id, `${existing ? 'Update' : 'Create'} agent ${name}`, ['.claude']);
    notifyProject(project.id, 'builder.updated');
    return { agent: readAgent(file, existing?.enabled ?? true) };
  });

  post('/api/projects/:pid/agents/:name/enabled', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const name = assertName(ctx.params.name, 'Agent name');
    const { enabled } = await ctx.json();
    const found = findAgent(project, name);
    if (!found) throw notFound('Agent not found');
    if (found.enabled !== Boolean(enabled)) {
      moveItem(found.file, agentPath(claudeDir(project, Boolean(enabled)), name));
      await commitProject(project.id, `${enabled ? 'Enable' : 'Disable'} agent ${name}`, ['.claude']);
    }
    notifyProject(project.id, 'builder.updated');
    return { ok: true };
  });

  del('/api/projects/:pid/agents/:name', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const name = assertName(ctx.params.name, 'Agent name');
    const found = findAgent(project, name);
    if (!found) throw notFound('Agent not found');
    fs.rmSync(found.file, { force: true });
    await commitProject(project.id, `Delete agent ${name}`, ['.claude']);
    notifyProject(project.id, 'builder.updated');
    return { ok: true };
  });

  // ---- Skills ----
  get('/api/projects/:pid/skills', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return { skills: listSkills(project) };
  });

  get('/api/projects/:pid/skills/:name/file', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const name = assertName(ctx.params.name, 'Skill name');
    const found = findSkill(project, name);
    if (!found) throw notFound('Skill not found');
    const rel = checkSkillFilePath(ctx.query.get('path'));
    const file = safeJoin(found.dir, rel);
    if (!fs.existsSync(file)) throw notFound('File not found');
    if (fs.statSync(file).size > 200_000) throw badRequest('File is too large to edit here');
    return { path: rel, content: fs.readFileSync(file, 'utf8') };
  });

  put('/api/projects/:pid/skills/:name', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const name = assertName(ctx.params.name, 'Skill name');
    const body = await ctx.json();
    const found = findSkill(project, name);
    const prev = found ? readSkill(found.dir, found.enabled) : null;
    const dir = found?.dir ?? path.join(claudeDir(project, true), 'skills', name);
    writeSkillFile(dir, {
      name,
      description: str(body.description, 'Description', { max: 1024 }).trim(),
      body: str(body.body, 'Instructions', { max: 100_000 }),
      allowedTools: checkTools(body.allowedTools ?? []),
      role: prev?.role ?? null,
    });
    await commitProject(project.id, `${found ? 'Update' : 'Create'} skill ${name}`, ['.claude']);
    notifyProject(project.id, 'builder.updated');
    return { skill: readSkill(dir, found?.enabled ?? true) };
  });

  put('/api/projects/:pid/skills/:name/file', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const name = assertName(ctx.params.name, 'Skill name');
    const found = findSkill(project, name);
    if (!found) throw notFound('Create the skill before adding files');
    const body = await ctx.json();
    const rel = checkSkillFilePath(body.path);
    const content = str(body.content ?? '', 'Content', { max: 200_000, optional: true });
    const file = safeJoin(found.dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    await commitProject(project.id, `Update ${name}/${rel}`, ['.claude']);
    notifyProject(project.id, 'builder.updated');
    return { ok: true };
  });

  del('/api/projects/:pid/skills/:name/file', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const name = assertName(ctx.params.name, 'Skill name');
    const found = findSkill(project, name);
    if (!found) throw notFound('Skill not found');
    const rel = checkSkillFilePath(ctx.query.get('path'));
    fs.rmSync(safeJoin(found.dir, rel), { force: true });
    await commitProject(project.id, `Delete ${name}/${rel}`, ['.claude']);
    notifyProject(project.id, 'builder.updated');
    return { ok: true };
  });

  post('/api/projects/:pid/skills/:name/enabled', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const name = assertName(ctx.params.name, 'Skill name');
    const { enabled } = await ctx.json();
    const found = findSkill(project, name);
    if (!found) throw notFound('Skill not found');
    if (name === 'project-docs' && !enabled) throw badRequest('project-docs is built in and stays on');
    if (found.enabled !== Boolean(enabled)) {
      moveItem(found.dir, path.join(claudeDir(project, Boolean(enabled)), 'skills', name));
      await commitProject(project.id, `${enabled ? 'Enable' : 'Disable'} skill ${name}`, ['.claude']);
    }
    notifyProject(project.id, 'builder.updated');
    return { ok: true };
  });

  del('/api/projects/:pid/skills/:name', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const name = assertName(ctx.params.name, 'Skill name');
    if (name === 'project-docs') throw badRequest('project-docs is built in and cannot be deleted');
    if (name === 'make-documents' || name === 'document-code' || name === 'analyze-ticket') throw badRequest(`${name} is built in and cannot be deleted. Switch it off instead.`);
    const found = findSkill(project, name);
    if (!found) throw notFound('Skill not found');
    fs.rmSync(found.dir, { recursive: true, force: true });
    await commitProject(project.id, `Delete skill ${name}`, ['.claude']);
    notifyProject(project.id, 'builder.updated');
    return { ok: true };
  });

  // ---- Skill templates: every skill the role templates carry, installable on its own ----
  get('/api/skill-templates', () => ({ skills: skillCatalog().map(({ body, ...s }) => ({ ...s, chars: body.length })) }));

  get('/api/skill-templates/:name', (ctx) => {
    const s = skillCatalog().find((x) => x.name === ctx.params.name);
    if (!s) throw notFound('Skill template not found');
    return { skill: s };
  });

  // Adds one template skill to the project without its role. An existing skill of that name is never overwritten.
  post('/api/projects/:pid/skill-templates/:name/add', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const s = skillCatalog().find((x) => x.name === ctx.params.name);
    if (!s) throw notFound('Skill template not found');
    if (findSkill(project, s.name)) throw badRequest(`${s.name} is already in this project. Open it on the Skills tab to edit it.`);
    writeSkillFile(path.join(claudeDir(project, true), 'skills', s.name), { name: s.name, description: s.description, body: s.body });
    await commitProject(project.id, `Add skill ${s.name} from templates`, ['.claude']);
    notifyProject(project.id, 'builder.updated');
    return { ok: true };
  });

  // ---- Roles ----
  get('/api/roles', () => ({
    roles: ROLE_TEMPLATES.map((t) => ({
      key: t.key,
      title: t.title,
      summary: t.summary,
      agent: { name: t.agent.name, model: t.agent.model, tools: t.agent.tools, description: t.agent.description },
      team: (t.team ?? []).map((a) => ({ name: a.name, model: a.model, description: a.description })),
      skills: t.skills.map((s) => ({ name: s.name, description: s.description })),
    })),
  }));

  get('/api/projects/:pid/roles', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const applied = all('SELECT role_key, enabled, applied_at, applied_by FROM project_roles WHERE project_id = ?', project.id);
    const members = all('SELECT u.name, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? AND m.role != ?', project.id, '');
    return { applied, members };
  });

  post('/api/projects/:pid/roles/:key/apply', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    await applyRole(project, ctx.params.key, ctx.user!.id);
    notifyProject(project.id, 'builder.updated');
    return { ok: true };
  });

  post('/api/projects/:pid/roles/:key/enabled', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const { enabled } = await ctx.json();
    if (!one('SELECT 1 FROM project_roles WHERE project_id = ? AND role_key = ?', project.id, ctx.params.key)) throw notFound('Add the role first');
    await setRoleEnabled(project, ctx.params.key, Boolean(enabled));
    notifyProject(project.id, 'builder.updated');
    return { ok: true };
  });

  del('/api/projects/:pid/roles/:key', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const t = roleTemplate(ctx.params.key);
    if (!t) throw notFound('Role template not found');
    // Skills that another applied role also uses stay.
    const keep = skillsOfOtherRoles(project, t.key, false);
    for (const enabled of [true, false]) {
      for (const a of roleAgents(t)) fs.rmSync(agentPath(claudeDir(project, enabled), a.name), { force: true });
      for (const s of t.skills) if (!keep.has(s.name)) fs.rmSync(path.join(claudeDir(project, enabled), 'skills', s.name), { recursive: true, force: true });
    }
    run('DELETE FROM project_roles WHERE project_id = ? AND role_key = ?', project.id, t.key);
    await commitProject(project.id, `Remove role: ${t.title}`, ['.claude']);
    notifyProject(project.id, 'builder.updated');
    return { ok: true };
  });

  // ---- Shared library ----
  get('/api/library', () => listLibrary());

  post('/api/projects/:pid/library/save', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const type = libType(body.type);
    const name = assertName(body.name);
    if (type === 'agents') {
      const found = findAgent(project, name);
      if (!found) throw notFound('Agent not found');
      fs.mkdirSync(libDir('agents'), { recursive: true });
      fs.copyFileSync(found.file, path.join(libDir('agents'), `${name}.md`));
    } else {
      const found = findSkill(project, name);
      if (!found) throw notFound('Skill not found');
      const dest = path.join(libDir('skills'), name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(found.dir, dest, { recursive: true });
    }
    return { ok: true };
  });

  post('/api/projects/:pid/library/install', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const type = libType(body.type);
    const name = assertName(body.name);
    if (type === 'agents') {
      const src = path.join(libDir('agents'), `${name}.md`);
      if (!fs.existsSync(src)) throw notFound('Not in the library');
      if (findAgent(project, name) && !body.overwrite) throw badRequest(`This project already has an agent named ${name}`);
      fs.copyFileSync(src, agentPath(claudeDir(project, true), name));
    } else {
      const src = path.join(libDir('skills'), name);
      if (!fs.existsSync(src)) throw notFound('Not in the library');
      if (findSkill(project, name) && !body.overwrite) throw badRequest(`This project already has a skill named ${name}`);
      const dest = path.join(claudeDir(project, true), 'skills', name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
    }
    await commitProject(project.id, `Install ${type === 'agents' ? 'agent' : 'skill'} ${name} from library`, ['.claude']);
    notifyProject(project.id, 'builder.updated');
    return { ok: true };
  });

  del('/api/library/:type/:name', (ctx) => {
    const type = libType(ctx.params.type);
    const name = assertName(ctx.params.name);
    if (type === 'agents') fs.rmSync(path.join(libDir('agents'), `${name}.md`), { force: true });
    else fs.rmSync(path.join(libDir('skills'), name), { recursive: true, force: true });
    return { ok: true };
  }, { auth: 'admin' });

  // ---- Try an agent or skill ----
  post('/api/projects/:pid/builder/test', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const name = assertName(body.name);
    const prompt = str(body.prompt, 'Test prompt', { max: 10_000 });
    const type = body.type === 'skill' ? 'skill' : 'agent';
    if (type === 'agent' && !findAgent(project, name)?.enabled) throw badRequest('Enable the agent before testing it');
    if (type === 'skill' && !findSkill(project, name)?.enabled) throw badRequest('Enable the skill before testing it');
    const { startRun } = await import('./agent/runner.ts');
    const { run: r } = await startRun({
      projectId: project.id,
      userId: ctx.user!.id,
      kind: 'test',
      title: `Test ${type} ${name}`,
      prompt: type === 'agent' ? `Use the ${name} subagent for this task: ${prompt}` : `Use the ${name} skill for this task: ${prompt}`,
      permissionMode: 'plan',
      model: 'haiku',
      meta: { testOf: { type, name } },
    });
    return { run: r };
  });

  // ---- Draft from a plain-language prompt ----
  post('/api/projects/:pid/builder/draft', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const kind = body.kind === 'skill' ? 'skill' : 'agent';
    const description = str(body.description, 'Description', { max: 2000 });
    const useDocuments = Boolean(body.useDocuments);
    const { oneshot } = await import('./agent/runner.ts');
    const { extractJson } = await import('./util.ts');

    const knownToolsList = KNOWN_TOOLS.join(', ');
    const modelList = MODELS.join(', ');

    let contextSection = '';
    if (useDocuments) {
      try {
        const { search } = await import('./knowledge.ts');
        const hits = search(project.id, description, { limit: 4 });
        if (hits.length) {
          const { all } = await import('./db.ts');
          contextSection = '\n\nProject context from documents:\n' +
            hits.map((h, i) => `[${i + 1}] ${h.docName} › ${h.heading}\n${h.snippet}`).join('\n\n');
        }
      } catch { /* not critical */ }
    }

    const agentSystem = `You draft a Claude agent definition from a plain-language description.
Available tools: ${knownToolsList}.
Available models: ${modelList}.
Return JSON only:
{
  "name": "<kebab-case identifier, max 40 chars>",
  "description": "<one or two sentences starting with 'Use when…'>",
  "tools": ["<tool>"],
  "model": "<one of: ${modelList}>",
  "skills": [],
  "instructions": "<markdown system prompt, 3–10 paragraphs>"
}
Rules:
- name: lowercase letters, digits, hyphens only, 2–40 chars.
- tools: only from the list above; omit Edit/Write/Bash for read-only roles.
- model: default to "inherit" unless the task clearly needs a specific tier.
- instructions: start with "You are the <role> for this project." then explain how to work step by step.
- Never include keys not listed above.`;

    const skillSystem = `You draft a Claude skill definition from a plain-language description.
A skill is a focused reference document agents load when needed.
Return JSON only:
{
  "name": "<kebab-case identifier, max 40 chars>",
  "description": "<one sentence starting with 'Use when…'>",
  "body": "<markdown SKILL.md content>"
}
Rules:
- name: lowercase letters, digits, hyphens only, 2–40 chars.
- description: start with "Use when".
- body: start with "# <title>", use numbered steps or sections, 10–50 lines.
- Never include keys not listed above.`;

    const demoDraftAgent = () => JSON.stringify({
      name: 'custom-agent',
      description: 'Use when you need a custom agent for this task.',
      tools: ['Read', 'Grep', 'Glob'],
      model: 'inherit',
      skills: [],
      instructions: `You are the custom agent for this project.\n\nHow to work:\n1. Read docs/decisions.md and search docs/md/ first.\n2. Complete the assigned task.\n3. Report findings clearly.\n\nCite every requirement you rely on.`,
    });

    const demoDraftSkill = () => JSON.stringify({
      name: 'custom-skill',
      description: 'Use when you need to apply a custom skill.',
      body: `# Custom skill\n\nHow to use this skill:\n\n1. Read the relevant context.\n2. Apply the pattern below.\n3. Report the outcome.\n\n## Pattern\n\n- Step one\n- Step two\n- Step three\n`,
    });

    const { text } = await oneshot({
      projectId: project.id,
      userId: ctx.user!.id,
      kind: 'learn',
      title: `Draft ${kind}: ${description.slice(0, 80)}`,
      system: kind === 'agent' ? agentSystem : skillSystem,
      prompt: `Description: ${description}${contextSection}`,
      model: 'haiku',
      meta: { draftKind: kind },
      demoOutput: kind === 'agent' ? demoDraftAgent : demoDraftSkill,
    });

    const parsed = extractJson<any>(text);
    if (!parsed) throw badRequest('The model did not return a valid draft. Try again.');

    // Validate and sanitise
    if (kind === 'agent') {
      const name = String(parsed.name ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'custom-agent';
      const validTools = KNOWN_TOOLS;
      const tools = Array.isArray(parsed.tools) ? parsed.tools.filter((t: unknown) => typeof t === 'string' && validTools.includes(t)) : ['Read', 'Grep', 'Glob'];
      const model = MODELS.includes(parsed.model) ? parsed.model : 'inherit';
      const skills = Array.isArray(parsed.skills) ? parsed.skills.filter((s: unknown) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(s)) : [];
      return {
        draft: {
          kind: 'agent',
          name,
          description: String(parsed.description ?? '').slice(0, 1000),
          tools,
          model,
          skills,
          prompt: String(parsed.instructions ?? '').slice(0, 50_000),
        },
      };
    } else {
      const name = String(parsed.name ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'custom-skill';
      return {
        draft: {
          kind: 'skill',
          name,
          description: String(parsed.description ?? '').slice(0, 1024),
          body: String(parsed.body ?? '').slice(0, 100_000),
        },
      };
    }
  });
}
