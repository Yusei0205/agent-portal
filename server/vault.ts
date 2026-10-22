/**
 * Vault: files uploaded once and given to every run. There are three:
 *
 *   project  one per project, for its members only: the project's documents, test data, evidence and the like.
 *            Viewers can read it; editors and owners can change it.
 *   mine     each person's own, for every run they start in any project.
 *   team     one for everyone signed in, for every run in every project.
 *
 * A run gets a copy of its project's vault, the team vault and its owner's vault in its own folder
 * (work/<run>/vault/project, .../vault/team and .../vault/mine), so agents can read them, and even change their
 * copies, without ever touching the originals. Agents can read everything in the vaults they get.
 * Vaults live under data/vault, outside the project's git repository, so nothing in them is committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { dataPath } from './config.ts';
import { del, get, post, put, sendFile, type Ctx } from './http.ts';
import { HttpError, badRequest, notFound, safeJoin, str } from './util.ts';
import { requireProject } from './projects.ts';

export const MAX_FILE = 100 * 1024 * 1024;
export const MAX_VAULT = 1024 * 1024 * 1024;
/** What a run copies at most; a bigger vault is left out of the run (and the run is told so). */
export const MAX_RUN_COPY = 200 * 1024 * 1024;

export type VaultScope = 'mine' | 'team' | 'project';

export function vaultDir(scope: VaultScope, userId: string, projectId?: string): string {
  if (scope === 'project') {
    if (!projectId || !/^[A-Za-z0-9_-]+$/.test(projectId)) throw badRequest('Choose a project');
    return dataPath('vault', 'projects', projectId);
  }
  return scope === 'team' ? dataPath('vault', 'team') : dataPath('vault', 'users', userId);
}

/** The vault a request is about. A project vault needs project access: viewer to read, editor to change. */
function vaultOf(ctx: Ctx, write = false): { scope: VaultScope; dir: string; label: string } {
  const s = ctx.query.get('scope') || 'mine';
  if (s !== 'mine' && s !== 'team' && s !== 'project') throw badRequest('Choose your vault, the team vault or a project vault');
  if (s === 'project') {
    const { project } = requireProject(ctx, String(ctx.query.get('projectId') || ''), write ? 'editor' : 'viewer');
    return { scope: s, dir: vaultDir(s, ctx.user!.id, project.id), label: project.slug };
  }
  return { scope: s, dir: vaultDir(s, ctx.user!.id), label: s === 'team' ? 'team' : 'my' };
}

/** A path inside the vault: forward slashes, no empty, hidden-escaping or parent parts. */
function checkRel(raw: unknown): string {
  const rel = str(raw, 'Path', { max: 400 }).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!rel || rel.split('/').some((p) => !p || p === '.' || p === '..') || /[\0<>:"|?*]/.test(rel)) throw badRequest('That is not a valid path in the vault');
  return rel;
}

interface Entry {
  path: string;
  dir: boolean;
  size: number;
  modified: string;
}

export function listVault(dir: string): Entry[] {
  const out: Entry[] = [];
  const walk = (rel: string, depth: number) => {
    const abs = rel ? path.join(dir, rel) : dir;
    if (depth > 10 || !fs.existsSync(abs) || out.length > 5000) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const st = fs.statSync(path.join(abs, e.name));
      if (e.isDirectory()) {
        out.push({ path: r, dir: true, size: 0, modified: st.mtime.toISOString() });
        walk(r, depth + 1);
      } else if (e.isFile()) out.push({ path: r, dir: false, size: st.size, modified: st.mtime.toISOString() });
    }
  };
  walk('', 0);
  return out;
}

const used = (dir: string) => listVault(dir).reduce((n, e) => n + e.size, 0);

/**
 * Copy the run's project vault, the team vault and the owner's vault into a run folder. Returns what the prompt
 * should say, or '' when all are empty. The project vault comes first: it is the most relevant to the run.
 */
export function copyVaultsInto(workDirAbs: string, workDirRel: string, userId: string, projectId?: string): string {
  const parts: string[] = [];
  let budget = MAX_RUN_COPY;
  const scopes: [VaultScope, string][] = [
    ...(projectId ? ([['project', 'project vault']] as [VaultScope, string][]) : []),
    ['team', 'team vault'],
    ['mine', 'your vault'],
  ];
  for (const [scope, label] of scopes) {
    const src = vaultDir(scope, userId, projectId);
    const files = listVault(src).filter((e) => !e.dir);
    if (!files.length) continue;
    const size = files.reduce((n, e) => n + e.size, 0);
    if (size > budget) {
      parts.push(`The ${label} (${Math.round(size / 1048576)} MB) is too big to copy into a run, so it is not here.`);
      continue;
    }
    budget -= size;
    const dest = path.join(workDirAbs, 'vault', scope);
    for (const f of files) {
      const to = path.join(dest, f.path);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(src, f.path), to);
    }
    parts.push(`${workDirRel}/vault/${scope}/ holds a copy of the ${label} (${files.length} file${files.length === 1 ? '' : 's'}).`);
  }
  return parts.length ? `Vault files, given as reference for every run: ${parts.join(' ')}` : '';
}

export function registerVaultRoutes(): void {
  get('/api/vault', (ctx) => {
    const { scope, dir } = vaultOf(ctx);
    const files = listVault(dir);
    return { scope, files, used: files.reduce((n, e) => n + e.size, 0), limit: MAX_VAULT, maxFile: MAX_FILE };
  });

  put('/api/vault/file', async (ctx) => {
    const { dir } = vaultOf(ctx, true);
    const rel = checkRel(ctx.query.get('path'));
    const buf = await ctx.raw(MAX_FILE);
    const target = safeJoin(dir, rel);
    const before = fs.existsSync(target) && fs.statSync(target).isFile() ? fs.statSync(target).size : 0;
    if (fs.existsSync(dir) && used(dir) - before + buf.length > MAX_VAULT) throw badRequest('That would make the vault larger than 1 GB');
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) throw badRequest('A folder has that name');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
    return { ok: true, path: rel, size: buf.length };
  });

  post('/api/vault/folder', async (ctx) => {
    const { dir } = vaultOf(ctx, true);
    const rel = checkRel((await ctx.json()).path);
    fs.mkdirSync(safeJoin(dir, rel), { recursive: true });
    return { ok: true, path: rel };
  });

  del('/api/vault/file', (ctx) => {
    const { dir } = vaultOf(ctx, true);
    const target = safeJoin(dir, checkRel(ctx.query.get('path')));
    if (!fs.existsSync(target)) throw notFound('Not in the vault');
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  });

  get('/api/vault/download', (ctx) => {
    const { dir } = vaultOf(ctx);
    const rel = checkRel(ctx.query.get('path'));
    const target = safeJoin(dir, rel);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw notFound('Not in the vault');
    return sendFile(ctx.res, fs.readFileSync(target), 'application/octet-stream', path.basename(rel));
  });

  get('/api/vault/zip', async (ctx) => {
    const { dir, label } = vaultOf(ctx);
    const files = listVault(dir).filter((e) => !e.dir);
    if (!files.length) throw new HttpError(404, 'The vault is empty');
    const zip = new JSZip();
    for (const f of files) zip.file(f.path, fs.readFileSync(path.join(dir, f.path)));
    return sendFile(ctx.res, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), 'application/zip', `${label}-vault.zip`);
  });
}
