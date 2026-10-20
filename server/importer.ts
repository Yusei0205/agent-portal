/**
 * Import agents and skills from:
 *  - a .zip upload (raw body)
 *  - a browser folder upload (multipart-like: multiple raw file entries sent as JSON)
 *  - a server-side absolute path (admin only)
 *
 * The flow is two-step:
 *  1. POST /api/projects/:pid/builder/import/preview  → returns parsed items + conflicts
 *  2. POST /api/projects/:pid/builder/import/confirm  → writes accepted items, commits once
 */

import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { get, post } from './http.ts';
import { dataPath } from './config.ts';
import { commitProject, notifyProject, projectDir, requireProject, type Project } from './projects.ts';
import { KNOWN_TOOLS, listAgentFiles, listSkills } from './builder.ts';
import {
  badRequest,
  forbidden,
  listValue,
  notFound,
  parseFrontmatter,
  safeJoin,
  str,
  stringifyFrontmatter,
} from './util.ts';

/* ------------------------------------------------------------------ */
/* Constants / limits                                                  */
/* ------------------------------------------------------------------ */

const MODELS_VALID = new Set(['inherit', 'haiku', 'sonnet', 'opus']);
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Max zip / folder-payload size: 20 MB */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Max extra files inside one skill folder */
const MAX_SKILL_FILES = 20;

/** Max single extra file size */
const MAX_SKILL_FILE_BYTES = 200_000;

/** Max depth inside a skill folder */
const MAX_SKILL_DEPTH = 3;

/* ------------------------------------------------------------------ */
/* Raw item types (from parsing)                                       */
/* ------------------------------------------------------------------ */

export interface ParsedAgent {
  kind: 'agent';
  name: string;
  description: string;
  tools: string[];
  model: string;
  skills: string[];
  prompt: string;
  /** Extra frontmatter fields we do not own (color, etc.) */
  extra: Record<string, unknown>;
}

export interface ParsedSkill {
  kind: 'skill';
  name: string;
  description: string;
  argumentHint: string;
  body: string;
  allowedTools: string[];
  /** Map of relative path → Buffer for extra files (bounded) */
  extraFiles: Map<string, Buffer>;
  /** Extra frontmatter fields */
  extra: Record<string, unknown>;
}

export type ParsedItem = ParsedAgent | ParsedSkill;

/* ------------------------------------------------------------------ */
/* Preview item types (sent to the browser)                           */
/* ------------------------------------------------------------------ */

export type ConflictChoice = 'skip' | 'overwrite' | 'rename';

export interface PreviewAgent {
  kind: 'agent';
  name: string;
  description: string;
  tools: string[];
  model: string;
  skills: string[];
  /** Skills referenced by this agent that don't exist in the project and aren't in the import set */
  missingSkills: string[];
  conflict: boolean;
  conflictChoice: ConflictChoice;
  invalid: boolean;
  invalidReasons: string[];
  /** Preserve for round-trip */
  extra: Record<string, unknown>;
  prompt: string;
}

export interface PreviewSkill {
  kind: 'skill';
  name: string;
  description: string;
  argumentHint: string;
  body: string;
  allowedTools: string[];
  extraFileCount: number;
  conflict: boolean;
  conflictChoice: ConflictChoice;
  invalid: boolean;
  invalidReasons: string[];
  extra: Record<string, unknown>;
}

export type PreviewItem = PreviewAgent | PreviewSkill;

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

function parseAgentMd(content: string, nameHint: string): ParsedAgent {
  const { data, body } = parseFrontmatter(content);
  const name = ((data.name as string) || nameHint).toLowerCase().trim();
  const { name: _n, description: _d, tools: _t, model: _m, skills: _s, ...extra } = data as Record<string, unknown>;
  return {
    kind: 'agent',
    name,
    description: (data.description as string) || '',
    tools: listValue(data.tools),
    model: (data.model as string) || 'inherit',
    skills: listValue(data.skills),
    prompt: body.trim(),
    extra,
  };
}

function parseSkillMd(content: string, nameHint: string, extraFiles: Map<string, Buffer>): ParsedSkill {
  const { data, body } = parseFrontmatter(content);
  const name = ((data.name as string) || nameHint).toLowerCase().trim();
  const { name: _n, description: _d, 'argument-hint': _a, 'allowed-tools': _at, ...extra } = data as Record<string, unknown>;
  return {
    kind: 'skill',
    name,
    description: (data.description as string) || '',
    argumentHint: (data['argument-hint'] as string) || '',
    body: body.trim(),
    allowedTools: listValue(data['allowed-tools']),
    extraFiles,
    extra,
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function validateAgent(a: ParsedAgent): string[] {
  const reasons: string[] = [];
  if (!NAME_RE.test(a.name)) reasons.push(`Name "${a.name}" is not valid (lowercase letters, digits, hyphens)`);
  for (const t of a.tools) {
    if (!KNOWN_TOOLS.includes(t) && !/^mcp__[A-Za-z0-9_-]+$/.test(t)) {
      reasons.push(`Unknown tool "${t}"`);
    }
  }
  if (!MODELS_VALID.has(a.model) && !/^[A-Za-z0-9._:\/-]{3,120}$/.test(a.model)) {
    reasons.push(`Unknown model "${a.model}"`);
  }
  if (!a.description.trim()) reasons.push('Description is empty');
  if (!a.prompt.trim()) reasons.push('Instructions (prompt) are empty');
  return reasons;
}

function validateSkill(s: ParsedSkill): string[] {
  const reasons: string[] = [];
  if (!NAME_RE.test(s.name)) reasons.push(`Name "${s.name}" is not valid`);
  if (!s.description.trim()) reasons.push('Description is empty');
  return reasons;
}

/* ------------------------------------------------------------------ */
/* Build preview from parsed items                                     */
/* ------------------------------------------------------------------ */

function buildPreview(items: ParsedItem[], project: Project): PreviewItem[] {
  const existingAgents = new Set(listAgentFiles(project).map((a) => a.name));
  const existingSkills = new Set(listSkills(project).map((s) => s.name));
  const importedSkillNames = new Set(
    items.filter((i): i is ParsedSkill => i.kind === 'skill').map((s) => s.name),
  );

  return items.map((item): PreviewItem => {
    if (item.kind === 'agent') {
      const invalidReasons = validateAgent(item);
      const missingSkills = item.skills.filter(
        (sk) => !existingSkills.has(sk) && !importedSkillNames.has(sk),
      );
      return {
        kind: 'agent',
        name: item.name,
        description: item.description,
        tools: item.tools,
        model: item.model,
        skills: item.skills,
        missingSkills,
        conflict: existingAgents.has(item.name),
        conflictChoice: 'skip',
        invalid: invalidReasons.length > 0,
        invalidReasons,
        extra: item.extra,
        prompt: item.prompt,
      };
    } else {
      const invalidReasons = validateSkill(item);
      return {
        kind: 'skill',
        name: item.name,
        description: item.description,
        argumentHint: item.argumentHint,
        body: item.body,
        allowedTools: item.allowedTools,
        extraFileCount: item.extraFiles.size,
        conflict: existingSkills.has(item.name),
        conflictChoice: 'skip',
        invalid: invalidReasons.length > 0,
        invalidReasons,
        extra: item.extra,
      };
    }
  });
}

/* ------------------------------------------------------------------ */
/* ZIP parsing                                                         */
/* ------------------------------------------------------------------ */

async function parseZip(buf: Buffer): Promise<ParsedItem[]> {
  const zip = await JSZip.loadAsync(buf);

  // Find the root that contains agents/ or skills/ or .claude/
  // Detect offset prefix: if all paths share a common prefix that contains .claude/ or agents/
  const entries = Object.keys(zip.files).filter((k) => !zip.files[k]!.dir);
  const items: ParsedItem[] = [];

  // Normalise paths to have forward slashes and strip trailing slashes
  // Detect if there's a .claude/ prefix, a project-root prefix, or direct agents/skills layout
  function findClaudePrefix(): string {
    // Try to find a path containing agents/ or skills/ or .claude/
    for (const entry of entries) {
      const parts = entry.split('/');
      const claudeIdx = parts.findIndex((p) => p === '.claude');
      if (claudeIdx >= 0) return parts.slice(0, claudeIdx + 1).join('/') + '/';
      const agentsIdx = parts.findIndex((p) => p === 'agents');
      const skillsIdx = parts.findIndex((p) => p === 'skills');
      const idx = Math.min(
        agentsIdx >= 0 ? agentsIdx : Infinity,
        skillsIdx >= 0 ? skillsIdx : Infinity,
      );
      if (isFinite(idx)) return parts.slice(0, idx).join('/') + (idx > 0 ? '/' : '');
    }
    return '';
  }

  const prefix = findClaudePrefix();

  // Parse agents
  const agentEntries = entries.filter(
    (e) => e.startsWith(`${prefix}agents/`) && e.endsWith('.md'),
  );
  for (const entry of agentEntries) {
    const relName = entry.slice(`${prefix}agents/`.length).replace(/\.md$/, '');
    if (!relName || relName.includes('/')) continue; // Only top-level .md files
    const content = await zip.files[entry]!.async('string');
    if (!content) continue;
    items.push(parseAgentMd(content, relName));
  }

  // Parse skills
  const skillEntries = entries
    .filter((e) => e.startsWith(`${prefix}skills/`) && e.includes('/SKILL.md'))
    .filter((e) => {
      const rel = e.slice(`${prefix}skills/`.length);
      return rel.split('/').length === 2; // <name>/SKILL.md only
    });

  for (const skillEntry of skillEntries) {
    const rel = skillEntry.slice(`${prefix}skills/`.length);
    const skillName = rel.split('/')[0]!;
    const content = await zip.files[skillEntry]!.async('string');
    if (!content) continue;

    // Collect extra files in the skill folder (bounded)
    const skillPrefix = `${prefix}skills/${skillName}/`;
    const extraFiles = new Map<string, Buffer>();
    let skipped = 0;
    for (const entry of entries) {
      if (!entry.startsWith(skillPrefix)) continue;
      const relPath = entry.slice(skillPrefix.length);
      if (relPath === 'SKILL.md') continue;
      if (!relPath || relPath.includes('..')) continue;
      // Security: no hidden files, no executables by extension
      const parts = relPath.split('/');
      if (parts.some((p) => p.startsWith('.'))) continue;
      if (parts.length > MAX_SKILL_DEPTH) continue;
      const extLower = path.extname(relPath).toLowerCase();
      const ALLOWED_EXTS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.py', '.ts', '.js', '.sh', '.csv', '.toml', '.ini', '.conf']);
      if (extLower && !ALLOWED_EXTS.has(extLower)) continue;
      if (extraFiles.size >= MAX_SKILL_FILES) { skipped++; continue; }
      const data = await zip.files[entry]!.async('nodebuffer');
      if (data.length > MAX_SKILL_FILE_BYTES) continue;
      extraFiles.set(relPath, data);
    }
    items.push(parseSkillMd(content, skillName, extraFiles));
  }

  return items;
}

/* ------------------------------------------------------------------ */
/* Folder entries parsing (sent as JSON array from browser)           */
/* ------------------------------------------------------------------ */

interface FolderEntry {
  path: string; // relative path inside the selected folder
  content: string; // base64
}

function parseFolderEntries(entries: FolderEntry[]): ParsedItem[] {
  const items: ParsedItem[] = [];

  // Normalize entries: find the prefix
  function findPrefix(): string {
    for (const e of entries) {
      const parts = e.path.replace(/\\/g, '/').split('/');
      const claudeIdx = parts.findIndex((p) => p === '.claude');
      if (claudeIdx >= 0) return parts.slice(0, claudeIdx + 1).join('/') + '/';
      const agentsIdx = parts.findIndex((p) => p === 'agents');
      const skillsIdx = parts.findIndex((p) => p === 'skills');
      const idx = Math.min(
        agentsIdx >= 0 ? agentsIdx : Infinity,
        skillsIdx >= 0 ? skillsIdx : Infinity,
      );
      if (isFinite(idx)) return parts.slice(0, idx).join('/') + (idx > 0 ? '/' : '');
    }
    return '';
  }

  const prefix = findPrefix();

  // Filter and decode
  function decode(b64: string): string {
    return Buffer.from(b64, 'base64').toString('utf8');
  }
  function decodeBuffer(b64: string): Buffer {
    return Buffer.from(b64, 'base64');
  }

  const normalize = (p: string) => p.replace(/\\/g, '/');

  // Agents
  for (const e of entries) {
    const p = normalize(e.path);
    if (!p.startsWith(`${prefix}agents/`) || !p.endsWith('.md')) continue;
    const rel = p.slice(`${prefix}agents/`.length);
    if (!rel || rel.includes('/')) continue;
    const name = rel.replace(/\.md$/, '');
    try {
      items.push(parseAgentMd(decode(e.content), name));
    } catch { /* skip malformed */ }
  }

  // Skills
  const skillPrefixFull = `${prefix}skills/`;
  const skillNames = new Set<string>();
  for (const e of entries) {
    const p = normalize(e.path);
    if (!p.startsWith(skillPrefixFull)) continue;
    const rel = p.slice(skillPrefixFull.length);
    const parts = rel.split('/');
    if (parts.length >= 2) skillNames.add(parts[0]!);
  }

  for (const skillName of skillNames) {
    const skillEntryPath = `${skillPrefixFull}${skillName}/SKILL.md`;
    const skillEntry = entries.find((e) => normalize(e.path) === skillEntryPath);
    if (!skillEntry) continue;
    try {
      const content = decode(skillEntry.content);
      const extraFiles = new Map<string, Buffer>();
      for (const e of entries) {
        const p = normalize(e.path);
        const sp = `${skillPrefixFull}${skillName}/`;
        if (!p.startsWith(sp)) continue;
        const relPath = p.slice(sp.length);
        if (relPath === 'SKILL.md' || !relPath) continue;
        const parts = relPath.split('/');
        if (parts.some((p) => p.startsWith('.'))) continue;
        if (parts.length > MAX_SKILL_DEPTH) continue;
        const extLower = path.extname(relPath).toLowerCase();
        const ALLOWED_EXTS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.py', '.ts', '.js', '.sh', '.csv', '.toml', '.ini', '.conf']);
        if (extLower && !ALLOWED_EXTS.has(extLower)) continue;
        if (extraFiles.size >= MAX_SKILL_FILES) continue;
        const data = decodeBuffer(e.content);
        if (data.length > MAX_SKILL_FILE_BYTES) continue;
        extraFiles.set(relPath, data);
      }
      items.push(parseSkillMd(content, skillName, extraFiles));
    } catch { /* skip malformed */ }
  }

  return items;
}

/* ------------------------------------------------------------------ */
/* Server-path parsing (admin only)                                   */
/* ------------------------------------------------------------------ */

function walkDir(dir: string, rel: string, depth: number, max: number, out: Array<{ rel: string; abs: string }>): void {
  if (depth > max || !fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue; // no symlinks
    if (entry.name.startsWith('.') && entry.name !== '.claude') continue; // no hidden (except .claude)
    const absPath = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkDir(absPath, relPath, depth + 1, max, out);
    } else {
      out.push({ rel: relPath, abs: absPath });
    }
  }
}

function parseServerPath(serverPath: string): ParsedItem[] {
  if (!path.isAbsolute(serverPath)) throw badRequest('Server path must be absolute');
  if (!fs.existsSync(serverPath)) throw notFound(`Path not found: ${serverPath}`);
  const stat = fs.statSync(serverPath);
  if (!stat.isDirectory()) throw badRequest('Server path must be a directory');

  // Resolve canonical claude dir: could be the dir itself, or contain .claude/, or contain agents/skills/
  let claudeRoot = serverPath;

  // Check if it contains .claude/
  const claudeSub = path.join(serverPath, '.claude');
  if (fs.existsSync(claudeSub) && fs.statSync(claudeSub).isDirectory()) {
    claudeRoot = claudeSub;
  }
  // else: serverPath itself is expected to contain agents/ and/or skills/

  const allFiles: Array<{ rel: string; abs: string }> = [];
  walkDir(claudeRoot, '', 0, 8, allFiles);

  const items: ParsedItem[] = [];

  // Agents
  for (const f of allFiles) {
    if (!f.rel.startsWith('agents/') || !f.rel.endsWith('.md')) continue;
    const rel = f.rel.slice('agents/'.length);
    if (!rel || rel.includes('/')) continue;
    const name = rel.replace(/\.md$/, '');
    try {
      const content = fs.readFileSync(f.abs, 'utf8');
      items.push(parseAgentMd(content, name));
    } catch { /* skip */ }
  }

  // Skills
  const skillNames = new Set<string>();
  for (const f of allFiles) {
    if (!f.rel.startsWith('skills/')) continue;
    const rel = f.rel.slice('skills/'.length);
    const parts = rel.split('/');
    if (parts.length >= 1) skillNames.add(parts[0]!);
  }

  for (const skillName of skillNames) {
    const skillMdAbs = path.join(claudeRoot, 'skills', skillName, 'SKILL.md');
    if (!fs.existsSync(skillMdAbs)) continue;
    try {
      const content = fs.readFileSync(skillMdAbs, 'utf8');
      const extraFiles = new Map<string, Buffer>();
      const skillDir = path.join(claudeRoot, 'skills', skillName);
      for (const f of allFiles) {
        if (!f.rel.startsWith(`skills/${skillName}/`)) continue;
        const relPath = f.rel.slice(`skills/${skillName}/`.length);
        if (relPath === 'SKILL.md' || !relPath) continue;
        const parts = relPath.split('/');
        if (parts.some((p) => p.startsWith('.'))) continue;
        if (parts.length > MAX_SKILL_DEPTH) continue;
        const extLower = path.extname(relPath).toLowerCase();
        const ALLOWED_EXTS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.py', '.ts', '.js', '.sh', '.csv', '.toml', '.ini', '.conf']);
        if (extLower && !ALLOWED_EXTS.has(extLower)) continue;
        if (extraFiles.size >= MAX_SKILL_FILES) continue;
        try {
          const data = fs.readFileSync(f.abs);
          if (data.length > MAX_SKILL_FILE_BYTES) continue;
          extraFiles.set(relPath, data);
        } catch { /* skip */ }
      }
      items.push(parseSkillMd(content, skillName, extraFiles));
    } catch { /* skip */ }
  }

  return items;
}

/* ------------------------------------------------------------------ */
/* Apply import (write files)                                         */
/* ------------------------------------------------------------------ */

interface ConfirmItem {
  kind: 'agent' | 'skill';
  name: string;
  choice: ConflictChoice;
  /** For rename: what to call it */
  renameTo?: string;
}

interface ConfirmBody {
  items: ConfirmItem[];
  /** Items to import — re-provided so server doesn't need to cache */
  parsed: Array<{
    kind: 'agent' | 'skill';
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    skills?: string[];
    prompt?: string;
    extra?: Record<string, unknown>;
    body?: string;
    allowedTools?: string[];
    argumentHint?: string;
    /** Extra files: { [relPath]: base64 } */
    extraFilesB64?: Record<string, string>;
  }>;
  saveToLibrary?: boolean;
}

function claudeDir(p: Project, enabled = true): string {
  return path.join(projectDir(p), '.claude', enabled ? '' : '_disabled');
}

async function applyImport(project: Project, body: ConfirmBody): Promise<{ imported: number; skipped: number; names: string[] }> {
  const base = claudeDir(project, true);
  const libDir = (type: 'agents' | 'skills') => dataPath('library', type);

  let imported = 0;
  let skipped = 0;
  const names: string[] = [];

  for (const item of body.items) {
    if (item.choice === 'skip') { skipped++; continue; }

    const parsed = body.parsed.find((p) => p.kind === item.kind && p.name === item.name);
    if (!parsed) continue;

    const targetName = item.choice === 'rename' && item.renameTo
      ? item.renameTo.toLowerCase().trim()
      : item.name;

    if (!NAME_RE.test(targetName)) { skipped++; continue; }

    if (item.kind === 'agent') {
      const agentDir = path.join(base, 'agents');
      fs.mkdirSync(agentDir, { recursive: true });
      const file = path.join(agentDir, `${targetName}.md`);
      const tools = (parsed.tools ?? []).filter((t: string) => KNOWN_TOOLS.includes(t) || /^mcp__[A-Za-z0-9_-]+$/.test(t));
      const model = parsed.model && MODELS_VALID.has(parsed.model) ? parsed.model : 'inherit';
      // Build frontmatter preserving extra fields
      const fm: Record<string, unknown> = {
        name: targetName,
        description: parsed.description ?? '',
        tools,
        model: model !== 'inherit' ? model : undefined,
        skills: parsed.skills ?? [],
        ...(parsed.extra ?? {}),
      };
      fs.writeFileSync(file, stringifyFrontmatter(fm as Record<string, string | string[] | undefined>, (parsed.prompt ?? '').trim() + '\n'));

      if (body.saveToLibrary) {
        fs.mkdirSync(libDir('agents'), { recursive: true });
        fs.copyFileSync(file, path.join(libDir('agents'), `${targetName}.md`));
      }
    } else {
      const skillDir = path.join(base, 'skills', targetName);
      fs.mkdirSync(skillDir, { recursive: true });
      const fm: Record<string, unknown> = {
        name: targetName,
        description: parsed.description ?? '',
        'allowed-tools': parsed.allowedTools ?? [],
        ...(parsed.argumentHint ? { 'argument-hint': parsed.argumentHint } : {}),
        ...(parsed.extra ?? {}),
      };
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), stringifyFrontmatter(fm as Record<string, string | string[] | undefined>, (parsed.body ?? '').trim() + '\n'));

      // Write extra files
      if (parsed.extraFilesB64) {
        for (const [relPath, b64] of Object.entries(parsed.extraFilesB64)) {
          const parts = relPath.split('/');
          if (parts.some((p) => p.startsWith('.') || p === '..')) continue;
          if (parts.length > MAX_SKILL_DEPTH + 1) continue;
          const extLower = path.extname(relPath).toLowerCase();
          const ALLOWED_EXTS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.py', '.ts', '.js', '.sh', '.csv', '.toml', '.ini', '.conf']);
          if (extLower && !ALLOWED_EXTS.has(extLower)) continue;
          try {
            const file = safeJoin(skillDir, relPath);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, Buffer.from(b64, 'base64'));
          } catch { /* skip bad paths */ }
        }
      }

      if (body.saveToLibrary) {
        const dest = path.join(libDir('skills'), targetName);
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(skillDir, dest, { recursive: true });
      }
    }

    imported++;
    names.push(`${item.kind} ${targetName}`);
  }

  return { imported, skipped, names };
}

/* ------------------------------------------------------------------ */
/* Routes                                                             */
/* ------------------------------------------------------------------ */

export function registerImporterRoutes(): void {
  /**
   * Preview from a ZIP upload.
   * PUT /api/projects/:pid/builder/import/zip
   * Raw body: the zip file bytes
   */
  post('/api/projects/:pid/builder/import/zip', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const buf = await ctx.raw(MAX_UPLOAD_BYTES);
    if (!buf.length) throw badRequest('Empty upload');
    let items: ParsedItem[];
    try {
      items = await parseZip(buf);
    } catch (e: any) {
      throw badRequest(`Could not parse zip: ${e?.message ?? e}`);
    }
    if (!items.length) throw badRequest('No agents or skills found in the zip. Make sure it contains agents/*.md or skills/*/SKILL.md files.');
    return { items: buildPreview(items, project), parsed: serializeParsed(items) };
  });

  /**
   * Preview from browser folder entries (sent as JSON).
   * POST /api/projects/:pid/builder/import/folder
   * Body: { entries: [{ path, content: base64 }] }
   */
  post('/api/projects/:pid/builder/import/folder', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (!entries.length) throw badRequest('No files provided');
    // Rough size check
    const totalSize = entries.reduce((s: number, e: any) => s + (typeof e.content === 'string' ? e.content.length * 0.75 : 0), 0);
    if (totalSize > MAX_UPLOAD_BYTES) throw badRequest('Folder is too large (max 20 MB)');

    const items = parseFolderEntries(entries);
    if (!items.length) throw badRequest('No agents or skills found. Make sure your folder contains agents/*.md or skills/*/SKILL.md files.');
    return { items: buildPreview(items, project), parsed: serializeParsed(items) };
  });

  /**
   * Preview from a server-side path (admin only).
   * POST /api/projects/:pid/builder/import/path
   * Body: { path: '/absolute/path' }
   */
  post('/api/projects/:pid/builder/import/path', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    if (!ctx.user?.is_admin) throw forbidden('Only admins can import from a server path');
    const body = await ctx.json();
    const serverPath = str(body.path, 'Path', { max: 4096 });
    const items = parseServerPath(serverPath);
    if (!items.length) throw badRequest('No agents or skills found at that path');
    return { items: buildPreview(items, project), parsed: serializeParsed(items) };
  });

  /**
   * Confirm import.
   * POST /api/projects/:pid/builder/import/confirm
   * Body: ConfirmBody
   */
  post('/api/projects/:pid/builder/import/confirm', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body: ConfirmBody = await ctx.json();
    if (!Array.isArray(body.items) || !Array.isArray(body.parsed)) throw badRequest('Invalid request body');

    const { imported, skipped, names } = await applyImport(project, body);
    if (imported === 0) return { imported, skipped, message: 'Nothing to import (all items were skipped or invalid)' };

    await commitProject(project.id, `Import ${imported} item${imported === 1 ? '' : 's'}: ${names.slice(0, 8).join(', ')}${names.length > 8 ? '…' : ''}`, ['.claude']);
    notifyProject(project.id, 'builder.updated');

    return { imported, skipped, message: `Imported ${imported} item${imported === 1 ? '' : 's'}${skipped > 0 ? `, skipped ${skipped}` : ''}` };
  });
}

/* ------------------------------------------------------------------ */
/* Serialise ParsedItem for round-trip through preview → confirm      */
/* ------------------------------------------------------------------ */

function serializeParsed(items: ParsedItem[]): unknown[] {
  return items.map((item) => {
    if (item.kind === 'agent') {
      return {
        kind: 'agent',
        name: item.name,
        description: item.description,
        tools: item.tools,
        model: item.model,
        skills: item.skills,
        prompt: item.prompt,
        extra: item.extra,
      };
    } else {
      const extraFilesB64: Record<string, string> = {};
      for (const [k, v] of item.extraFiles) {
        extraFilesB64[k] = v.toString('base64');
      }
      return {
        kind: 'skill',
        name: item.name,
        description: item.description,
        argumentHint: item.argumentHint,
        body: item.body,
        allowedTools: item.allowedTools,
        extraFilesB64,
        extra: item.extra,
      };
    }
  });
}
