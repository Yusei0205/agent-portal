/**
 * Vault: files uploaded once and given to every run. Each person has their own vault, and there is one team vault
 * that everyone signed in can see and change.
 *
 * A run gets a copy of the team vault and of its owner's vault in its own folder (work/<run>/vault/team and
 * .../vault/mine), so agents can read them, and even change their copies, without ever touching the originals.
 * Agents can read everything in both vaults: keep secrets out of them.
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { dataPath } from './config.ts';
import { del, get, post, put, sendFile, type Ctx } from './http.ts';
import { HttpError, badRequest, notFound, safeJoin, str } from './util.ts';

export const MAX_FILE = 100 * 1024 * 1024;
export const MAX_VAULT = 1024 * 1024 * 1024;
/** What a run copies at most; a bigger vault is left out of the run (and the run is told so). */
export const MAX_RUN_COPY = 200 * 1024 * 1024;

export type VaultScope = 'mine' | 'team';

export function vaultDir(scope: VaultScope, userId: string): string {
  return scope === 'team' ? dataPath('vault', 'team') : dataPath('vault', 'users', userId);
}

function scopeOf(ctx: Ctx): VaultScope {
  const s = ctx.query.get('scope') || 'mine';
  if (s !== 'mine' && s !== 'team') throw badRequest('Choose your vault or the team vault');
  return s;
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
 * Copy the team vault and the owner's vault into a run folder. Returns what the prompt should say, or '' when both
 * are empty.
 */
export function copyVaultsInto(workDirAbs: string, workDirRel: string, userId: string): string {
  const parts: string[] = [];
  let budget = MAX_RUN_COPY;
  for (const [scope, label] of [['team', 'team vault'], ['mine', 'your vault']] as const) {
    const src = vaultDir(scope, userId);
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
    const scope = scopeOf(ctx);
    const dir = vaultDir(scope, ctx.user!.id);
    const files = listVault(dir);
    return { scope, files, used: files.reduce((n, e) => n + e.size, 0), limit: MAX_VAULT, maxFile: MAX_FILE };
  });

  put('/api/vault/file', async (ctx) => {
    const scope = scopeOf(ctx);
    const dir = vaultDir(scope, ctx.user!.id);
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
    const scope = scopeOf(ctx);
    const rel = checkRel((await ctx.json()).path);
    fs.mkdirSync(safeJoin(vaultDir(scope, ctx.user!.id), rel), { recursive: true });
    return { ok: true, path: rel };
  });

  del('/api/vault/file', (ctx) => {
    const scope = scopeOf(ctx);
    const target = safeJoin(vaultDir(scope, ctx.user!.id), checkRel(ctx.query.get('path')));
    if (!fs.existsSync(target)) throw notFound('Not in the vault');
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  });

  get('/api/vault/download', (ctx) => {
    const scope = scopeOf(ctx);
    const rel = checkRel(ctx.query.get('path'));
    const target = safeJoin(vaultDir(scope, ctx.user!.id), rel);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw notFound('Not in the vault');
    return sendFile(ctx.res, fs.readFileSync(target), 'application/octet-stream', path.basename(rel));
  });

  get('/api/vault/zip', async (ctx) => {
    const scope = scopeOf(ctx);
    const dir = vaultDir(scope, ctx.user!.id);
    const files = listVault(dir).filter((e) => !e.dir);
    if (!files.length) throw new HttpError(404, 'The vault is empty');
    const zip = new JSZip();
    for (const f of files) zip.file(f.path, fs.readFileSync(path.join(dir, f.path)));
    return sendFile(ctx.res, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), 'application/zip', `${scope === 'team' ? 'team' : 'my'}-vault.zip`);
  });
}
