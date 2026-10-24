/**
 * Project Kiro agents (Agents and skills › Kiro): list, edit, enable or disable, delete and import them.
 *
 * They are kept apart from the .claude agents: Kiro runs use them when the project has any (see writeNativeProfile in
 * agent/kiro.ts), and Claude runs never do. Every change is committed to the project's git history.
 *
 * Importing copies agents from the server user's ~/.kiro (admins only), an uploaded folder or a zip: the agent JSON,
 * its prompt and the skills and steering it loads. References to ~/.kiro are rewritten to the project's .kiro folder,
 * and nothing is read from outside the source's .kiro folder. Settings, sessions, logs, mcp.json and MCP credentials
 * are never copied.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import type { Ctx } from './http.ts';
import { del, get, post, put } from './http.ts';
import { commitProject, notifyProject, projectDir, requireProject, type Project } from './projects.ts';
import { HttpError, assertName, badRequest, notFound, safeJoin, slugify, str } from './util.ts';
import { listAgentFiles } from './builder.ts';
import { GENERATED_RE, isInside, kiroAgentsDir, listKiroAgentsAt, promptFileOf, readKiroAgentFile, type KiroAgentFile } from './agent/kiro-project.ts';

const MAX_IMPORT = 20 * 1024 * 1024;
const MAX_FILES = 2000;
/** The parts of a .kiro folder an import may copy. */
const IMPORT_TOPS = new Set(['agents', 'skills', 'steering', 'prompts', 'specs', 'docs']);
/** Never copied, wherever they appear. */
const SECRET_RE = /(^|\/)(\.?mcp\.json|settings|sessions|logs|\.env[^/]*|credentials[^/]*)(\/|$)/i;

/** The server user's Kiro folder (tests point it at a temporary one). */
export const kiroHome = () => process.env.PORTAL_KIRO_HOME || path.join(os.homedir(), '.kiro');

export const listKiroAgents = (p: Project, opts?: { includeDisabled?: boolean }) => listKiroAgentsAt(projectDir(p), opts);

export function findKiroAgent(p: Project, name: string): KiroAgentFile | null {
  for (const enabled of [true, false]) {
    const file = path.join(kiroAgentsDir(projectDir(p), enabled), `${name}.json`);
    if (fs.existsSync(file)) return readKiroAgentFile(file, projectDir(p), enabled);
  }
  return null;
}

/** Hooks and MCP servers run commands on the server, so only admins (signed in, not with a token) may change them. */
export function mustKeepKiroCommands(ctx: Ctx, before: Record<string, unknown> | null, after: Record<string, unknown>): void {
  const same = (k: string) => JSON.stringify(before?.[k] ?? {}) === JSON.stringify(after[k] ?? {});
  if (same('hooks') && same('mcpServers')) return;
  if (ctx.apiToken) throw new HttpError(403, 'Hooks and MCP servers can only be changed from a signed-in browser, never with an API token');
  if (!ctx.user!.is_admin) throw new HttpError(403, 'Only admins can change hooks or MCP servers: they run commands on the portal server.');
}

/* ------------------------------------------------------------------ */
/* Leads                                                               */
/* ------------------------------------------------------------------ */

export interface LeadChoice {
  name: string;
  description: string;
  kind: 'kiro' | 'claude';
}

/**
 * The agents that may lead a session on an engine: on Kiro only the project's enabled Kiro agents, on Claude only its
 * enabled .claude agents. The two systems stay separate (D-9): a Kiro session never borrows .claude agents. When Kiro
 * has no usable agent the session asks the user to switch to Claude Code (D-12); it never switches by itself.
 */
export function leadChoices(p: Project, kiro: boolean): LeadChoice[] {
  if (kiro) return listKiroAgents(p, { includeDisabled: false }).map((a) => ({ name: a.name, description: a.description, kind: 'kiro' }));
  return listAgentFiles(p)
    .filter((a) => a.enabled)
    .map((a) => ({ name: a.name, description: a.description, kind: 'claude' }));
}

export interface RunLead {
  name: string;
  description: string;
  prompt: string;
  team: { name: string; description: string }[];
  /** A project Kiro agent: it leads with its own profile, so the system text only adds the portal's rules. */
  isKiroNative?: boolean;
}

/** The lead a run starts with, or null when that agent cannot lead on this engine (any more). */
export function resolveLead(p: Project, name: string, kiro: boolean): RunLead | null {
  const choice = leadChoices(p, kiro).find((c) => c.name === name);
  if (!choice) return null;
  if (choice.kind === 'kiro') {
    const a = findKiroAgent(p, name)!;
    return { name: a.name, description: a.description, prompt: a.prompt, team: [], isKiroNative: true };
  }
  const team = listAgentFiles(p).filter((a) => a.enabled);
  const found = team.find((a) => a.name === name)!;
  return { name: found.name, description: found.description, prompt: found.prompt, team: team.map((a) => ({ name: a.name, description: a.description })) };
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

interface Copy {
  /** Absolute source path (file or folder). */
  from: string;
  /** Destination relative to the project's .kiro folder. */
  to: string;
}

export interface ImportItem {
  name: string;
  /** The file name in the source, when the agent's name had to change. */
  sourceName: string;
  description: string;
  json: Record<string, unknown>;
  copies: Copy[];
  /** References that could not be found in the source. */
  missing: string[];
  /** References left out because they point outside the source's .kiro folder or at secrets. */
  skipped: string[];
  /** What was removed from the definition (hooks, MCP credentials …). */
  dropped: string[];
  conflict: boolean;
}

/** The path inside the source .kiro folder that a reference points to, and any glob after it. */
function sourceOf(ref: string, agentFile: string, root: string): { path: string; glob: string } | 'outside' | 'project' {
  let rest = ref.replace(/^(file|skill):\/\//, '').replace(/\\/g, '/');
  if (rest.startsWith('~/.kiro/')) rest = path.join(root, rest.slice('~/.kiro/'.length));
  else if (rest.startsWith('~')) return 'outside';
  else if (rest.startsWith('.kiro/')) rest = path.join(root, rest.slice('.kiro/'.length));
  else if (rest.startsWith('./') || rest.startsWith('../')) rest = path.resolve(path.dirname(agentFile), rest);
  else if (!path.isAbsolute(rest) && !/^[A-Za-z]:/.test(rest)) return 'project'; // relative to the workspace, like file://README.md
  const parts = rest.split(/[\\/]/);
  const wild = parts.findIndex((x) => /[*?[{]/.test(x));
  const base = path.resolve(wild < 0 ? rest : parts.slice(0, wild).join('/') || '/');
  if (!isInside(root, base)) return 'outside';
  return { path: base, glob: wild < 0 ? '' : '/' + parts.slice(wild).join('/') };
}

/** Plan an import from a .kiro folder; nothing is written. */
export function planImport(root: string, p: Project, admin: boolean): ImportItem[] {
  const src = path.join(root, 'agents');
  if (!fs.existsSync(src)) return [];
  const existing = new Set(listKiroAgents(p).map((a) => a.name));
  const out: ImportItem[] = [];
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.json') && !GENERATED_RE.test(x)).sort()) {
    const file = path.join(src, f);
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!json || typeof json !== 'object' || Array.isArray(json)) continue;
    } catch {
      continue;
    }
    const sourceName = path.basename(f, '.json');
    const name = /^[a-z0-9][a-z0-9-]{0,62}$/.test(sourceName) && !GENERATED_RE.test(sourceName) ? sourceName : slugify(sourceName, 60) || 'agent';
    const item: ImportItem = { name, sourceName, description: typeof json.description === 'string' ? json.description : '', json: { ...json }, copies: [], missing: [], skipped: [], dropped: [], conflict: existing.has(name) };
    const take = (ref: string, scheme: 'file' | 'skill'): string | null => {
      const s = sourceOf(ref, file, root);
      if (s === 'project') return ref;
      const rel = s === 'outside' ? '' : path.relative(root, s.path).split(path.sep).join('/');
      if (s === 'outside' || !IMPORT_TOPS.has(rel.split('/')[0]) || SECRET_RE.test(rel)) {
        item.skipped.push(ref);
        return null;
      }
      if (!fs.existsSync(s.path)) {
        item.missing.push(ref);
        return `${scheme}://.kiro/${rel}${s.glob}`;
      }
      // A skill is its whole folder: SKILL.md with its scripts and references.
      const skill = rel.match(/^skills\/[^/]+/);
      const copy = skill ? { from: path.join(root, skill[0]), to: skill[0] } : { from: s.path, to: rel };
      if (!item.copies.some((c) => c.to === copy.to)) item.copies.push(copy);
      return `${scheme}://.kiro/${rel}${s.glob}`;
    };
    // The prompt is read from its file and stored inline, so the agent does not depend on where it came from.
    if (typeof json.prompt === 'string' && json.prompt.startsWith('file://')) {
      const s = sourceOf(json.prompt, file, root);
      if (s === 'outside' || s === 'project' || s.glob) {
        item.skipped.push(json.prompt);
        item.json.prompt = '';
      } else if (!fs.existsSync(s.path) || !fs.statSync(s.path).isFile()) {
        item.missing.push(json.prompt);
        item.json.prompt = '';
      } else item.json.prompt = fs.readFileSync(s.path, 'utf8');
    }
    const resources = Array.isArray(json.resources) ? json.resources.map(String) : [];
    item.json.resources = resources
      .map((r) => (r.startsWith('file://') ? take(r, 'file') : r.startsWith('skill://') ? take(r, 'skill') : r))
      .filter((r): r is string => r !== null);
    // MCP credentials never come along; hooks and MCP servers only when an admin imports.
    if (json.mcpServers && typeof json.mcpServers === 'object') {
      if (admin) {
        item.json.mcpServers = Object.fromEntries(
          Object.entries(json.mcpServers as Record<string, any>).map(([k, v]) => {
            const { env: _env, headers: _headers, ...rest } = v && typeof v === 'object' ? v : ({} as Record<string, unknown>);
            return [k, rest];
          }),
        );
        item.dropped.push('MCP server credentials');
      } else {
        delete item.json.mcpServers;
        item.dropped.push('MCP servers (admins only)');
      }
    }
    if (json.hooks && !admin) {
      delete item.json.hooks;
      item.dropped.push('hooks (admins only)');
    }
    delete item.json.useLegacyMcpJson;
    item.json.includeMcpJson = false;
    item.json.name = name;
    out.push(item);
  }
  return out;
}

/** Copy a file or folder into the project's .kiro, leaving out links, secrets and generated profiles. */
function copyInto(from: string, to: string, kiroDir: string, budget: { bytes: number; files: number }): void {
  const st = fs.lstatSync(from);
  if (st.isSymbolicLink()) return;
  const rel = path.relative(kiroDir, to).split(path.sep).join('/');
  if (SECRET_RE.test(rel) || GENERATED_RE.test(path.basename(to))) return;
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(from)) copyInto(path.join(from, e), path.join(to, e), kiroDir, budget);
    return;
  }
  budget.bytes += st.size;
  budget.files += 1;
  if (budget.bytes > MAX_IMPORT) throw badRequest('The files to import are larger than 20 MB in total');
  if (budget.files > MAX_FILES) throw badRequest(`At most ${MAX_FILES} files can be imported at once`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** Write the chosen items into the project; returns the names written. */
function applyImport(items: ImportItem[], p: Project, choices: Record<string, unknown>): string[] {
  const base = projectDir(p);
  const kiroDir = path.join(base, '.kiro');
  const taken = new Set(listKiroAgents(p).map((a) => a.name));
  const budget = { bytes: 0, files: 0 };
  const done: string[] = [];
  for (const item of items) {
    const choice = String(choices[item.name] ?? (item.conflict ? 'skip' : 'import'));
    if (choice === 'skip') continue;
    if (item.conflict && choice === 'rename') {
      let n = 2;
      while (taken.has(`${item.name}-${n}`)) n++;
      item.name = `${item.name}-${n}`;
      item.json.name = item.name;
    }
    for (const c of item.copies) copyInto(c.from, safeJoin(kiroDir, c.to), kiroDir, budget);
    // An overwritten agent may have been disabled; it comes back enabled.
    fs.rmSync(path.join(kiroAgentsDir(base, false), `${item.name}.json`), { force: true });
    fs.mkdirSync(kiroAgentsDir(base), { recursive: true });
    fs.writeFileSync(path.join(kiroAgentsDir(base), `${item.name}.json`), JSON.stringify(item.json, null, 2) + '\n');
    taken.add(item.name);
    done.push(item.name);
  }
  return done;
}

/** Where an uploaded entry belongs inside a .kiro folder, or null to leave it out. */
function uploadedPath(raw: string): string | null {
  const name = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!name || /^[A-Za-z]:/.test(name) || name.split('/').some((x) => x === '..' || x === '.')) throw badRequest(`"${raw}" points outside the folder`);
  let parts = name.split('/').filter(Boolean);
  const k = parts.indexOf('.kiro');
  if (k >= 0) parts = parts.slice(k + 1);
  else if (!IMPORT_TOPS.has(parts[0]) && IMPORT_TOPS.has(parts[1])) parts = parts.slice(1);
  const rel = parts.join('/');
  if (!IMPORT_TOPS.has(parts[0]) || parts.length < 2 || SECRET_RE.test(rel) || parts.some((x) => x.startsWith('__MACOSX') || x === '.DS_Store')) return null;
  return rel;
}

/** The .kiro folder an import reads: the server's ~/.kiro, or the uploaded files in a temporary folder. */
async function importSource(ctx: Ctx, body: any): Promise<{ root: string; label: string; done: () => void }> {
  if (body.source === 'home') {
    if (ctx.apiToken || !ctx.user!.is_admin) throw new HttpError(403, 'Only admins can import from the portal server’s ~/.kiro folder');
    return { root: kiroHome(), label: '~/.kiro on the portal server', done: () => {} };
  }
  const entries: { rel: string; data: Buffer }[] = [];
  if (typeof body.zip === 'string') {
    const zip = await JSZip.loadAsync(Buffer.from(body.zip, 'base64')).catch(() => {
      throw badRequest('That is not a zip file');
    });
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      // JSZip quietly strips "../" from names; a zip that tries to climb out is refused rather than renamed.
      const rel = uploadedPath(String((entry as any).unsafeOriginalName ?? entry.name));
      if (rel) entries.push({ rel, data: await entry.async('nodebuffer') });
    }
  } else if (Array.isArray(body.files)) {
    for (const f of body.files) {
      const rel = uploadedPath(String(f?.path ?? ''));
      if (rel) entries.push({ rel, data: Buffer.from(String(f?.content ?? ''), 'base64') });
    }
  } else throw badRequest('Choose a folder or a zip to import');
  if (entries.length > MAX_FILES) throw badRequest(`At most ${MAX_FILES} files can be imported at once`);
  if (entries.reduce((n, e) => n + e.data.length, 0) > MAX_IMPORT) throw badRequest('The files to import are larger than 20 MB in total');
  if (!entries.some((e) => /^agents\/[^/]+\.json$/.test(e.rel))) throw badRequest('No Kiro agents found: the folder or zip needs an agents folder with .json files');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-import-'));
  for (const e of entries) {
    const dest = safeJoin(root, e.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.data);
  }
  return { root, label: 'the uploaded files', done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

const view = (a: KiroAgentFile) => ({
  name: a.name,
  description: a.description,
  enabled: a.enabled,
  prompt: a.prompt,
  promptFile: a.promptFile,
  tools: a.tools,
  allowedTools: a.allowedTools,
  resources: a.resources,
  model: a.model,
  team: a.team,
  hasHooks: Object.keys(a.hooks).length > 0,
  json: a.json,
});

export function registerKiroAgentRoutes(): void {
  get('/api/projects/:pid/kiro-agents', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const base = projectDir(project);
    const files = (top: string) => {
      const dir = path.join(base, '.kiro', top);
      if (!fs.existsSync(dir)) return [];
      return (fs.readdirSync(dir, { recursive: true }) as string[])
        .map((f) => `.kiro/${top}/${f.split(path.sep).join('/')}`)
        .filter((f) => fs.statSync(path.join(base, f)).isFile())
        .sort();
    };
    return { agents: listKiroAgents(project).map(view), skills: files('skills'), steering: files('steering') };
  });

  get('/api/projects/:pid/leads', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return { leads: leadChoices(project, ctx.query.get('engine') === 'kiro') };
  });

  get('/api/projects/:pid/kiro-agents/:name', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const a = findKiroAgent(project, assertName(ctx.params.name, 'Agent name'));
    if (!a) throw notFound('Kiro agent not found');
    return { agent: view(a) };
  });

  // Create or replace an agent: { json, prompt }. A prompt kept in its own file is written back to that file.
  put('/api/projects/:pid/kiro-agents/:name', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const name = assertName(ctx.params.name, 'Agent name');
    if (GENERATED_RE.test(name)) throw badRequest('Names starting with agent-portal- are used by the portal for runs');
    const body = await ctx.json();
    const json = body.json && typeof body.json === 'object' && !Array.isArray(body.json) ? { ...body.json } : null;
    if (!json) throw badRequest('The agent definition must be a JSON object');
    if (JSON.stringify(json).length > 256 * 1024) throw badRequest('That agent definition is larger than 256 KB');
    const prompt = body.prompt === undefined ? undefined : str(body.prompt, 'Instructions', { max: 200_000, optional: true });
    const before = findKiroAgent(project, name);
    mustKeepKiroCommands(ctx, before?.json ?? null, json);
    const base = projectDir(project);
    const dir = kiroAgentsDir(base, before?.enabled ?? true);
    const file = path.join(dir, `${name}.json`);
    json.name = name;
    const promptFile = typeof json.prompt === 'string' ? promptFileOf(json.prompt, file, base) : null;
    if (prompt !== undefined) {
      if (promptFile) {
        fs.mkdirSync(path.dirname(promptFile), { recursive: true });
        fs.writeFileSync(promptFile, prompt);
      } else json.prompt = prompt;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    await commitProject(project.id, `${before ? 'Update' : 'Create'} Kiro agent ${name} (${ctx.user!.name})`, ['.kiro']);
    notifyProject(project.id, 'builder.updated');
    return { agent: view(findKiroAgent(project, name)!) };
  });

  // Disabled agents move to .kiro/agents-disabled (with a prompt file kept next to them), so Kiro skips them too.
  put('/api/projects/:pid/kiro-agents/:name/enabled', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const name = assertName(ctx.params.name, 'Agent name');
    const enabled = Boolean((await ctx.json()).enabled);
    const a = findKiroAgent(project, name);
    if (!a) throw notFound('Kiro agent not found');
    if (a.enabled !== enabled) {
      const base = projectDir(project);
      const from = kiroAgentsDir(base, a.enabled);
      const to = kiroAgentsDir(base, enabled);
      fs.mkdirSync(to, { recursive: true });
      fs.renameSync(path.join(from, `${name}.json`), path.join(to, `${name}.json`));
      const pf = a.promptFile ? path.join(base, a.promptFile) : null;
      if (pf && path.dirname(pf) === from && !listKiroAgents(project).some((o) => o.name !== name && o.promptFile === a.promptFile)) {
        fs.renameSync(pf, path.join(to, path.basename(pf)));
      }
      await commitProject(project.id, `${enabled ? 'Enable' : 'Disable'} Kiro agent ${name} (${ctx.user!.name})`, ['.kiro']);
      notifyProject(project.id, 'builder.updated');
    }
    return { agent: view(findKiroAgent(project, name)!) };
  });

  del('/api/projects/:pid/kiro-agents/:name', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const name = assertName(ctx.params.name, 'Agent name');
    const a = findKiroAgent(project, name);
    if (!a) throw notFound('Kiro agent not found');
    const base = projectDir(project);
    fs.rmSync(path.join(kiroAgentsDir(base, a.enabled), `${name}.json`), { force: true });
    // Its prompt file goes too, unless another agent uses it.
    if (a.promptFile && !listKiroAgents(project).some((o) => o.promptFile === a.promptFile)) fs.rmSync(path.join(base, a.promptFile), { force: true });
    await commitProject(project.id, `Delete Kiro agent ${name} (${ctx.user!.name})`, ['.kiro']);
    notifyProject(project.id, 'builder.updated');
    return { ok: true };
  });

  // Import: { source: 'home' } (admins), { files: [{ path, content (base64) }] } or { zip (base64) }.
  // Without `choices` it only previews; with them it writes. choices: { [name]: 'import' | 'skip' | 'rename' }.
  post('/api/projects/:pid/kiro-agents/import', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const src = await importSource(ctx, body);
    try {
      const items = planImport(src.root, project, Boolean(ctx.user!.is_admin) && !ctx.apiToken);
      if (!body.choices) {
        return {
          source: src.label,
          agents: items.map((i) => ({
            name: i.name,
            sourceName: i.sourceName,
            description: i.description,
            conflict: i.conflict,
            files: i.copies.map((c) => `.kiro/${c.to}`),
            missing: i.missing,
            skipped: i.skipped,
            dropped: i.dropped,
            team: [(i.json.toolsSettings as any)?.subagent?.availableAgents].flat().filter((x) => typeof x === 'string'),
          })),
        };
      }
      const done = applyImport(items, project, body.choices && typeof body.choices === 'object' ? body.choices : {});
      if (done.length) {
        await commitProject(project.id, `Import Kiro agent${done.length === 1 ? '' : 's'} ${done.join(', ')} from ${src.label} (${ctx.user!.name})`, ['.kiro']);
        notifyProject(project.id, 'builder.updated');
      }
      return { imported: done };
    } finally {
      src.done();
    }
  });
}
