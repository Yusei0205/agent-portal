/**
 * Read-only look into a session's workspace on its AgentCore runner machine (the session IDE's Explorer and Source
 * Control tabs use it for cloud sessions, whose files live on that machine and not on the portal's disk).
 *
 * Pure Node code (no portal imports): the agent-runner and kiro-runner images COPY this file into their build
 * (as shared/runner-inspect.ts). Nothing here writes: it lists folders, reads files, and runs `git status` / `git diff`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export interface InspectRequest {
  op: 'tree' | 'file' | 'git-status' | 'git-diff';
  /** Path under the workspace folder (tree, file) or under the repository (git-diff). */
  path?: string;
  /** Repository folder name under repos/ (git-diff). */
  repo?: string;
}

export type InspectResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; error: string };

const SKIP_NAMES = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store']);
const MAX_ENTRIES = 3000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DIFF_BYTES = 512 * 1024;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

/** True when the first bytes hold a NUL (the usual sign of a binary file). */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function realOrNull(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

/** Resolve a request path under the first root that has it; never outside the allowed roots (symlinks included). */
function resolveUnder(roots: string[], rel: string): { root: string; abs: string } | null {
  const clean = rel.replace(/\\/g, '/');
  if (clean.startsWith('/') || clean.split('/').some((s) => s === '..')) return null;
  const real = roots.map(realOrNull).filter((r): r is string => Boolean(r));
  for (const root of roots) {
    const abs = path.join(root, clean);
    const realAbs = realOrNull(abs);
    if (!realAbs) continue;
    if (real.some((r) => realAbs === r || realAbs.startsWith(r + path.sep))) return { root, abs };
  }
  return null;
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // The workspace folder is a mounted file system whose files report another owner: trust exactly this folder.
    const proc = spawn('git', ['-c', `safe.directory=${cwd}`, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8').trimEnd());
      else reject(new Error(Buffer.concat(err).toString('utf8').trimEnd() || `git exited with ${code}`));
    });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** Repository folders (repos/<name> holding a .git) found under any of the roots, by name. */
function findRepos(roots: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const root of roots) {
    const reposDir = path.join(root, 'repos');
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(reposDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (found.has(e.name)) continue;
      const dir = path.join(reposDir, e.name);
      try { if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, '.git'))) found.set(e.name, dir); } catch { /* skip */ }
    }
  }
  return found;
}

export function hasWorkspaceContent(roots: string[]): boolean {
  return findRepos(roots).size > 0;
}

function listTree(roots: string[], rel: string): InspectResult {
  // The top level merges what the roots hold (the live work folder and the saved workspace folder), repos/ first.
  const entries = new Map<string, Record<string, unknown>>();
  let any = false;
  const targets = rel ? [resolveUnder(roots, rel)].filter((t): t is { root: string; abs: string } => Boolean(t)) : roots.map((root) => ({ root, abs: root }));
  if (rel && targets.length === 0) return { ok: false, status: 404, error: 'Directory not found' };
  for (const t of targets) {
    let list: fs.Dirent[];
    try {
      if (!fs.statSync(t.abs).isDirectory()) continue;
      list = fs.readdirSync(t.abs, { withFileTypes: true });
    } catch { continue; }
    any = true;
    for (const e of list) {
      if (SKIP_NAMES.has(e.name)) continue;
      const abs = path.join(t.abs, e.name);
      const relPath = rel ? `${rel.replace(/\/+$/, '')}/${e.name}` : e.name;
      if (entries.has(relPath)) continue;
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) { try { const st = fs.statSync(abs); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; } }
      if (isDir) entries.set(relPath, { name: e.name, path: relPath, type: 'directory' });
      else if (isFile) {
        let size: number | undefined;
        let mtime: number | undefined;
        try { const st = fs.statSync(abs); size = st.size; mtime = st.mtimeMs; } catch { /* best effort */ }
        entries.set(relPath, { name: e.name, path: relPath, type: 'file', size, mtime });
      }
      if (entries.size >= MAX_ENTRIES) break;
    }
  }
  if (!any && rel) return { ok: false, status: 404, error: 'Directory not found' };
  const sorted = [...entries.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });
  return { ok: true, data: { scope: 'work', path: rel, entries: sorted } };
}

function readFile(roots: string[], rel: string): InspectResult {
  const t = rel ? resolveUnder(roots, rel) : null;
  if (!t) return { ok: false, status: 404, error: 'File not found' };
  let st: fs.Stats;
  try { st = fs.statSync(t.abs); } catch { return { ok: false, status: 404, error: 'File not found' }; }
  if (!st.isFile()) return { ok: false, status: 404, error: 'File not found' };
  const ext = path.extname(t.abs).toLowerCase();
  const token = createHash('sha1').update(`${st.mtimeMs}:${st.size}`).digest('hex').slice(0, 16);
  const mime = IMAGE_MIME[ext];
  if (mime) {
    if (st.size > MAX_IMAGE_BYTES) return { ok: true, data: { type: 'binary', ext, size: st.size, token } };
    const buf = fs.readFileSync(t.abs);
    return { ok: true, data: { type: 'image', ext, size: st.size, token, url: `data:${mime};base64,${buf.toString('base64')}`, mtime: st.mtimeMs } };
  }
  if (st.size > MAX_TEXT_BYTES) {
    return { ok: true, data: { type: 'binary', ext, size: st.size, token, tooLarge: true, message: `File is too large to show in the browser (${Math.round(st.size / 1024)} KB, max ${MAX_TEXT_BYTES / 1024} KB)` } };
  }
  const buf = fs.readFileSync(t.abs);
  if (looksBinary(buf)) return { ok: true, data: { type: 'binary', ext, size: st.size, token, mtime: st.mtimeMs } };
  return { ok: true, data: { type: 'text', ext, content: buf.toString('utf8'), size: st.size, token, mtime: st.mtimeMs, readOnly: true } };
}

type FileChange = { path: string; status: 'A' | 'M' | 'D' | 'R' | '?'; oldPath?: string };

async function repoStatus(name: string, dir: string): Promise<{ name: string; branch: string; base: string | null; head?: string; files: FileChange[] } | null> {
  try {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).catch(() => 'HEAD');
    const head = await git(['log', '-1', '--format=%h %s'], dir).catch(() => '');
    let base: string | null = null;
    try {
      base = await git(['rev-parse', '--abbrev-ref', '@{u}'], dir);
    } catch {
      for (const c of ['origin/main', 'origin/master', 'main', 'master']) {
        try { await git(['rev-parse', '--verify', c], dir); base = c; break; } catch { /* next */ }
      }
    }
    const files: FileChange[] = [];
    if (base) {
      try {
        const out = await git(['diff', '--name-status', `${base}..HEAD`], dir);
        for (const line of out.split('\n')) {
          const parts = line.replace(/\r$/, '').trim().split('\t');
          if (parts.length < 2) continue;
          const code = parts[0];
          if (code.startsWith('R') || code.startsWith('C')) {
            if (parts[2]) files.push({ path: parts[2], status: 'R', oldPath: parts[1] });
          } else if (parts[1]) {
            const s = code[0];
            files.push({ path: parts[1], status: s === 'A' || s === 'D' ? s : 'M' });
          }
        }
      } catch { /* the committed diff is optional */ }
    }
    const seen = new Set(files.map((f) => f.path));
    const status = await git(['status', '--porcelain=v1'], dir).catch(() => '');
    for (const raw of status.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (line.length < 4) continue;
      const x = line[0];
      const y = line[1];
      const part = line.slice(3);
      if (x === '?' && y === '?') {
        if (!seen.has(part)) { files.push({ path: part, status: '?' }); seen.add(part); }
      } else if (x === 'R' || y === 'R' || x === 'C') {
        const i = part.indexOf(' -> ');
        const np = i >= 0 ? part.slice(0, i) : part;
        if (!seen.has(np)) { files.push({ path: np, status: 'R', oldPath: i >= 0 ? part.slice(i + 4) : undefined }); seen.add(np); }
      } else {
        const eff = x !== ' ' && x !== '?' ? x : y;
        if (!seen.has(part)) { files.push({ path: part, status: eff === 'A' ? 'A' : eff === 'D' ? 'D' : 'M' }); seen.add(part); }
      }
    }
    return { name, branch, base, head, files };
  } catch {
    return null;
  }
}

async function repoDiff(roots: string[], repoName: string, file: string): Promise<InspectResult> {
  const repos = findRepos(roots);
  const dir = repos.get(repoName);
  if (!dir) return { ok: false, status: 404, error: 'Not a git repository' };
  if (file.split('/').some((s) => s === '..') || file.startsWith('/')) return { ok: false, status: 400, error: 'Invalid path' };
  try {
    let binary = false;
    try {
      const num = await git(['diff', 'HEAD', '--numstat', '--', file || '.'], dir);
      if (num.startsWith('-\t-')) binary = true;
    } catch { /* ignore */ }
    if (binary) return { ok: true, data: { diff: '', binary: true, truncated: false } };
    let diff = '';
    try { diff = await git(['diff', 'HEAD', '--', file || '.'], dir); } catch {
      try { diff = await git(['diff', '--', file || '.'], dir); } catch { diff = ''; }
    }
    const truncated = Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES;
    return { ok: true, data: { diff: truncated ? diff.slice(0, MAX_DIFF_BYTES) : diff, binary: false, truncated } };
  } catch {
    return { ok: true, data: { diff: '', binary: false, truncated: false } };
  }
}

/** Answers one read-only request about the workspace held under `roots` (the live work folder and the saved workspace folder). */
export async function inspectWorkspace(roots: string[], req: InspectRequest): Promise<InspectResult> {
  const live = roots.filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
  switch (req.op) {
    case 'tree': return listTree(live, String(req.path ?? '').replace(/^\/+|\/+$/g, ''));
    case 'file': return readFile(live, String(req.path ?? ''));
    case 'git-status': {
      const out: Array<NonNullable<Awaited<ReturnType<typeof repoStatus>>>> = [];
      for (const [name, dir] of findRepos(live)) {
        const s = await repoStatus(name, dir);
        if (s) out.push(s);
      }
      return { ok: true, data: { repos: out } };
    }
    case 'git-diff': return repoDiff(live, String(req.repo ?? ''), String(req.path ?? ''));
    default: return { ok: false, status: 400, error: 'Unknown request' };
  }
}
