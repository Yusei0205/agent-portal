/**
 * Sending files an agent wrote inside an AgentCore microVM back to the portal.
 *
 * Pure Node code (no portal imports): the agent-runner and kiro-runner images COPY this file into their
 * build (as shared/runner-files.ts), and the portal imports the receiving half directly.
 *
 * Wire format (SSE events emitted by the runner, one object per event):
 *   { type: 'file', path: 'docs/report.md', size: 1234, index: 0, count: 1, data: '<base64 chunk>' }
 * A file is split into chunks of CHUNK_BYTES; chunks arrive in order. Only the types and limits below are
 * sent; the receiver re-checks every rule (it never trusts the runner).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Same list the portal accepts as session output (see output-files.ts). */
export const RUNNER_FILE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.pdf',
  '.md', '.docx', '.xlsx', '.pptx', '.csv', '.html', '.drawio',
]);

/**
 * Source and plain-text files an agent writes as its answer (a component, a script, a config), so they show in the session
 * explorer. Only in the session's own work folder: files in cloned repositories are never sent (see RUNNER_EXCLUDED_DIRS).
 */
export const RUNNER_CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.py', '.java', '.kt', '.go', '.rs', '.rb', '.php', '.cs',
  '.c', '.h', '.cpp', '.hpp', '.swift', '.sh', '.sql', '.css', '.scss', '.txt', '.json', '.yaml', '.yml', '.xml', '.toml',
]);
const CODE_NOISE_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml']);
const CODE_NOISE_DIRS = new Set(['dist', 'build', 'out', 'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.gradle', '.idea', '.vscode']);

/** True for a source or text file (path relative to the work folder) that is an answer, not a dependency or build product. */
export function isCodeOutputFile(rel: string): boolean {
  const parts = rel.split('/');
  const name = parts[parts.length - 1] ?? '';
  if (!name || name.startsWith('.') || CODE_NOISE_FILES.has(name)) return false;
  if (parts.slice(0, -1).some((d) => CODE_NOISE_DIRS.has(d))) return false;
  return RUNNER_CODE_EXTS.has(path.extname(name).toLowerCase());
}

/** The deck's slide list: a JSON file the portal turns into the PowerPoint (presentations.ts), the one JSON file sent back. */
export const RUNNER_DECK_SPEC = 'deck.json';
const allowedRunnerFile = (rel: string): boolean => {
  const name = path.posix.basename(rel);
  return RUNNER_FILE_EXTS.has(path.extname(name).toLowerCase()) || name === RUNNER_DECK_SPEC || isCodeOutputFile(rel);
};

/** Folders that hold tool state, clones, dependencies or the agents' shared notes, not the agent's deliverables. */
export const RUNNER_EXCLUDED_DIRS = new Set([
  'repos', 'home', '.browser', '.claude', '.kiro', '.git', 'node_modules', '.local', '.cache', '.npm', '.agent-notes',
]);

export const RUNNER_FILE_LIMITS = {
  files: 50,
  fileBytes: 10 * 1024 * 1024,
  totalBytes: 40 * 1024 * 1024,
  chunkBytes: 192 * 1024,
  pathChars: 300,
};

export interface RunnerFile {
  /** Path relative to the work folder, with forward slashes. */
  rel: string;
  abs: string;
  size: number;
}

export interface FileEvent {
  type: 'file';
  path: string;
  size: number;
  index: number;
  count: number;
  data: string;
}

// ── Runner side ───────────────────────────────────────────────────────────────

/** Files in `workDir` that match the allow-list and were changed at or after `sinceMs`, within the limits. */
export function collectRunnerFiles(workDir: string, sinceMs = 0): { files: RunnerFile[]; skipped: number } {
  const found: RunnerFile[] = [];
  let skipped = 0;
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (RUNNER_EXCLUDED_DIRS.has(e.name)) continue;
        // Staged inputs (attachments, project documents) are not results.
        if (r === 'attachments' || r === 'docs/md') continue;
        walk(abs, r);
        continue;
      }
      if (!e.isFile()) continue;
      if (!allowedRunnerFile(r)) continue;
      let st: fs.Stats;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.mtimeMs < sinceMs) continue;
      if (st.size === 0 || st.size > RUNNER_FILE_LIMITS.fileBytes || r.length > RUNNER_FILE_LIMITS.pathChars) { skipped++; continue; }
      found.push({ rel: r, abs, size: st.size });
    }
  };
  walk(workDir, '');
  for (const f of collectRepoDocuments(workDir, sinceMs)) found.push(f);
  // Newest first so the limits drop the oldest files.
  found.sort((a, b) => fs.statSync(b.abs).mtimeMs - fs.statSync(a.abs).mtimeMs);
  const files: RunnerFile[] = [];
  let total = 0;
  for (const f of found) {
    if (files.length >= RUNNER_FILE_LIMITS.files || total + f.size > RUNNER_FILE_LIMITS.totalBytes) { skipped++; continue; }
    files.push(f);
    total += f.size;
  }
  return { files, skipped };
}

/** Documents per repository the runner sends back (a repository can change a great deal; these are the agent's written results). */
export const REPO_DOC_LIMIT = 20;

/** Paths git reports as added or changed (not deleted) in `repoDir`: the working tree, plus commits not yet on the remote. Never throws. */
export function changedRepoPaths(repoDir: string): string[] {
  const git = (args: string[]): string => {
    try { return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); } catch { return ''; }
  };
  const out = new Set<string>();
  const entries = git(['status', '--porcelain', '-z', '--untracked-files=all']).split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    if (xy === '!!' || xy[0] === 'D' || xy[1] === 'D') continue;
    const f = e.slice(3);
    if (f && !f.endsWith('/')) out.add(f);
  }
  for (const line of git(['log', '--pretty=format:', '--name-only', 'origin/HEAD..HEAD']).split('\n')) {
    const f = line.trim();
    if (f) out.add(f);
  }
  return [...out];
}

/**
 * Documents (Markdown, Word, PDF, ...) the agent created or changed inside the cloned repositories, as `repos/<name>/<path>`,
 * so they show with the session's outputs. Only what git says changed, only document types, never source code: the repositories
 * themselves are not sent (see RUNNER_EXCLUDED_DIRS).
 */
export function collectRepoDocuments(workDir: string, sinceMs = 0): RunnerFile[] {
  const out: RunnerFile[] = [];
  const reposDir = path.join(workDir, 'repos');
  let names: fs.Dirent[];
  try { names = fs.readdirSync(reposDir, { withFileTypes: true }); } catch { return out; }
  for (const d of names) {
    if (!d.isDirectory() || d.name.startsWith('.') || !fs.existsSync(path.join(reposDir, d.name, '.git'))) continue;
    let kept = 0;
    for (const f of changedRepoPaths(path.join(reposDir, d.name))) {
      if (kept >= REPO_DOC_LIMIT) break;
      const parts = f.split('/');
      if (!RUNNER_FILE_EXTS.has(path.extname(f).toLowerCase())) continue;
      if (parts.some((s) => s.startsWith('.') || CODE_NOISE_DIRS.has(s) || RUNNER_EXCLUDED_DIRS.has(s))) continue;
      const rel = `repos/${d.name}/${f}`;
      if (rel.length > RUNNER_FILE_LIMITS.pathChars) continue;
      const abs = path.join(reposDir, d.name, ...parts);
      let st: fs.Stats;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (!st.isFile() || st.mtimeMs < sinceMs || st.size === 0 || st.size > RUNNER_FILE_LIMITS.fileBytes) continue;
      out.push({ rel, abs, size: st.size });
      kept++;
    }
  }
  return out;
}

/** Emit every collected file as chunked 'file' events (plus a status line). Returns how many files were sent. */
export function emitRunnerFiles(
  workDir: string,
  emit: (event: Record<string, unknown>) => void,
  sinceMs = 0,
): number {
  const { files, skipped } = collectRunnerFiles(workDir, sinceMs);
  if (!files.length) return 0;
  emit({ type: 'status', text: `Sending ${files.length} file${files.length === 1 ? '' : 's'} back${skipped ? ` (${skipped} skipped: too large, too many or not allowed)` : ''}` });
  for (const f of files) {
    let buf: Buffer;
    try { buf = fs.readFileSync(f.abs); } catch { continue; }
    const count = Math.max(1, Math.ceil(buf.length / RUNNER_FILE_LIMITS.chunkBytes));
    for (let i = 0; i < count; i++) {
      const part = buf.subarray(i * RUNNER_FILE_LIMITS.chunkBytes, (i + 1) * RUNNER_FILE_LIMITS.chunkBytes);
      emit({ type: 'file', path: f.rel, size: buf.length, index: i, count, data: part.toString('base64') } satisfies FileEvent);
    }
  }
  return files.length;
}

// ── Portal side ───────────────────────────────────────────────────────────────

/** Returns a clean relative path or null when the runner sent something unsafe. */
export function safeRelPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > RUNNER_FILE_LIMITS.pathChars) return null;
  if (p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  // Any '..' segment is refused outright (never "fixed up" by normalising).
  if (p.split('/').some((seg) => seg === '..')) return null;
  const norm = path.posix.normalize(p);
  if (norm === '.' || norm.startsWith('/')) return null;
  const parts = norm.split('/');
  // A document the agent wrote inside a cloned repository: repos/<name>/<path>, documents only (never source files).
  if (parts[0] === 'repos') {
    if (parts.length < 3 || !RUNNER_FILE_EXTS.has(path.extname(norm).toLowerCase())) return null;
    if (parts[1].startsWith('.') || RUNNER_EXCLUDED_DIRS.has(parts[1])) return null;
    const inner = parts.slice(2);
    if (inner.some((s) => RUNNER_EXCLUDED_DIRS.has(s) || CODE_NOISE_DIRS.has(s)) || inner.some((s) => s.startsWith('.'))) return null;
    return norm;
  }
  if (parts.some((s) => RUNNER_EXCLUDED_DIRS.has(s) && s !== parts[parts.length - 1])) return null;
  if (!allowedRunnerFile(norm)) return null;
  return norm;
}

export interface FileReceiver {
  /** Feed one runner event; ignores anything that is not a valid 'file' event. */
  handle(ev: Record<string, unknown>): Promise<void>;
  /** Files fully written so far. */
  readonly received: string[];
  readonly rejected: number;
}

/**
 * Collects chunked files into `workDir`. `onWritten(absPath)` runs after each complete file (used to mirror
 * it to S3). Re-checks the path, extension, per-file and total limits.
 */
export function createFileReceiver(workDir: string, onWritten?: (abs: string) => Promise<void>): FileReceiver {
  const pending = new Map<string, { size: number; count: number; next: number; chunks: Buffer[]; bytes: number }>();
  const received: string[] = [];
  let totalBytes = 0;
  let rejected = 0;
  const root = path.resolve(workDir);

  return {
    received,
    get rejected() { return rejected; },
    async handle(ev) {
      if (ev.type !== 'file') return;
      const rel = safeRelPath(ev.path);
      const size = Number(ev.size);
      const index = Number(ev.index);
      const count = Number(ev.count);
      if (!rel || !Number.isInteger(size) || !Number.isInteger(index) || !Number.isInteger(count)
        || size <= 0 || count < 1 || index < 0 || index >= count || typeof ev.data !== 'string'
        || size > RUNNER_FILE_LIMITS.fileBytes || count > Math.ceil(RUNNER_FILE_LIMITS.fileBytes / 1024)) {
        rejected++;
        return;
      }
      let st = pending.get(rel);
      if (index === 0) {
        if (received.length + pending.size >= RUNNER_FILE_LIMITS.files || totalBytes + size > RUNNER_FILE_LIMITS.totalBytes) { rejected++; return; }
        st = { size, count, next: 0, chunks: [], bytes: 0 };
        pending.set(rel, st);
      }
      if (!st || st.next !== index || st.count !== count || st.size !== size) { pending.delete(rel); rejected++; return; }
      const buf = Buffer.from(ev.data, 'base64');
      st.chunks.push(buf);
      st.bytes += buf.length;
      st.next += 1;
      if (st.bytes > size) { pending.delete(rel); rejected++; return; }
      if (st.next < st.count) return;

      pending.delete(rel);
      if (st.bytes !== size) { rejected++; return; }
      const abs = path.resolve(root, ...rel.split('/'));
      if (abs !== root && !abs.startsWith(root + path.sep)) { rejected++; return; }
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, Buffer.concat(st.chunks));
      totalBytes += size;
      received.push(rel);
      if (onWritten) await onWritten(abs);
    },
  };
}

// ── Files going the other way: staged inputs ────────────────────────────────────────────────────────────────

/** Folders of the work folder whose files are sent to the runner before the agent starts. */
export const INPUT_DIRS = ['attachments', 'docs/md'] as const;

export const INPUT_FILE_EXTS = new Set([
  '.md', '.txt', '.csv', '.json', '.yaml', '.yml', '.html', '.pdf', '.docx', '.xlsx', '.pptx', '.zip',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.drawio', '.mmd',
]);

export const INPUT_FILE_LIMITS = { files: 30, fileBytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024 };

/** What a file larger than the inline limits is sent as: the runner downloads it from `url`, which must deliver exactly `size` bytes. */
export const URL_FILE_LIMITS = { fileBytes: 50 * 1024 * 1024, totalBytes: 100 * 1024 * 1024, timeoutMs: 5 * 60_000 };

export type InputFile =
  /** Content sent inline, base64: for files within INPUT_FILE_LIMITS. */
  | { path: string; data: string }
  /** A large file the runner downloads (a presigned S3 link). */
  | { path: string; url: string; size: number };
// Both forms carry a `path` relative to the work folder, under attachments/ or docs/md/.

/**
 * Where collectInputFiles puts the files that are too large to send inline, when the caller can send them as download links
 * (see input-file-urls.ts). The caller turns each one into `{ path, url, size }`.
 */
export interface LargeInputFiles {
  /** The most one large file may be. */
  fileBytes: number;
  /** The most all large files together may be. */
  totalBytes: number;
  /** Filled in by collectInputFiles. `abs` is the file in the work folder. */
  files: Array<{ path: string; abs: string; size: number }>;
}

/**
 * Portal side: the files staged for a run (attachments, chosen project documents), within the limits. Files within the inline
 * limits are returned with their content; without `large` anything bigger is left out (or, for a file of the current message, an
 * error), and with `large` it is put there instead.
 */
export function collectInputFiles(workDir: string, preferredPaths: string[] = [], large?: LargeInputFiles): InputFile[] {
  const out: InputFile[] = [];
  const taken = new Set<string>();
  let total = 0;
  let largeTotal = 0;
  const count = (): number => out.length + (large?.files.length ?? 0);
  const fitsLarge = (size: number): boolean => Boolean(large) && size <= large!.fileBytes && largeTotal + size <= large!.totalBytes;
  const takeLarge = (rel: string, abs: string, size: number): void => {
    large!.files.push({ path: rel, abs, size });
    largeTotal += size;
    taken.add(rel);
  };
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const a = path.join(abs, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { walk(a, r, depth + 1); continue; }
      if (!e.isFile() || taken.has(r) || !INPUT_FILE_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      let st: fs.Stats;
      try { st = fs.statSync(a); } catch { continue; }
      if (st.size === 0 || count() >= INPUT_FILE_LIMITS.files) continue;
      if (st.size <= INPUT_FILE_LIMITS.fileBytes && total + st.size <= INPUT_FILE_LIMITS.totalBytes) {
        try { out.push({ path: r, data: fs.readFileSync(a).toString('base64') }); total += st.size; taken.add(r); } catch { /* skip */ }
      } else if (fitsLarge(st.size)) {
        takeLarge(r, a, st.size);
      }
    }
  };
  // Current message files take precedence over older files in the working copy.
  for (const rel of preferredPaths) {
    if (!rel.startsWith('attachments/') || path.posix.basename(rel) !== rel.slice('attachments/'.length)) continue;
    const abs = path.join(workDir, rel);
    const stat = fs.lstatSync(abs);
    if (!stat.isFile() || !INPUT_FILE_EXTS.has(path.extname(rel).toLowerCase())) throw new Error('Chat attachments exceed runner file limits');
    const inline = stat.size <= INPUT_FILE_LIMITS.fileBytes && total + stat.size <= INPUT_FILE_LIMITS.totalBytes;
    if (!inline && !fitsLarge(stat.size)) throw new Error('Chat attachments exceed runner file limits');
    if (taken.has(rel)) continue;
    if (inline) {
      out.push({ path: rel, data: fs.readFileSync(abs).toString('base64') });
      total += stat.size;
      taken.add(rel);
    } else {
      takeLarge(rel, abs, stat.size);
    }
  }
  for (const d of INPUT_DIRS) walk(path.join(workDir, ...d.split('/')), d, 0);
  return out;
}

/** The place of an input file inside the work folder, or null when the path is not an allowed one. */
function inputTarget(root: string, rel: unknown): { norm: string; abs: string } | null {
  if (typeof rel !== 'string' || !rel || rel.length > 300 || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/')) return null;
  const norm = path.posix.normalize(rel);
  if (norm.split('/').some((seg) => seg === '..' || seg === '') || !INPUT_DIRS.some((d) => norm.startsWith(`${d}/`))) return null;
  if (!INPUT_FILE_EXTS.has(path.posix.extname(norm).toLowerCase())) return null;
  const abs = path.resolve(root, ...norm.split('/'));
  return abs.startsWith(root + path.sep) ? { norm, abs } : null;
}

/** Runner side: write the files the portal sent inline (base64) into the work folder. Re-checks every path and limit. Returns how many were written. */
export function writeInputFiles(workDir: string, files: unknown): number {
  if (!Array.isArray(files)) return 0;
  const root = path.resolve(workDir);
  let written = 0;
  let total = 0;
  for (const f of files.slice(0, INPUT_FILE_LIMITS.files)) {
    const data = (f as { data?: unknown })?.data;
    const target = inputTarget(root, (f as { path?: unknown })?.path);
    if (!target || typeof data !== 'string') continue;
    const buf = Buffer.from(data, 'base64');
    if (buf.length === 0 || buf.length > INPUT_FILE_LIMITS.fileBytes || total + buf.length > INPUT_FILE_LIMITS.totalBytes) continue;
    fs.mkdirSync(path.dirname(target.abs), { recursive: true });
    fs.writeFileSync(target.abs, buf);
    total += buf.length;
    written++;
  }
  return written;
}

/**
 * A download address the runner will fetch: https, on an amazonaws.com host (an S3 presigned link), with no credentials in it.
 * A host that ends in amazonaws.com cannot be an IP address or localhost.
 */
export function isInputFileUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length > 4000) return false;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && !x.username && !x.password && /(^|\.)amazonaws\.com$/.test(x.hostname);
  } catch {
    return false;
  }
}

export interface InputFileDownloadOptions {
  /** Tests point this at a local server. */
  fetchImpl?: typeof fetch;
  /** Tests allow a local address. Default: isInputFileUrl. */
  allowUrl?: (url: string) => boolean;
  timeoutMs?: number;
}

type StatusEmitter = (e: { type: 'status'; text: string }) => void;

// A link carries its signature, so nothing the runner says about a failure may repeat it.
const noLinks = (s: string): string => s.replace(/https?:\/\/\S+/g, '[link]').slice(0, 200);

/** Download `url` to `abs` through a `.part` file, refusing redirects and anything but exactly `size` bytes. */
async function downloadInputFile(url: string, abs: string, size: number, fetchImpl: typeof fetch, timeoutMs: number): Promise<void> {
  const part = `${abs}.part`;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.body) throw new Error(`the server answered ${res.status}`);
    const announced = Number(res.headers.get('content-length'));
    if (Number.isFinite(announced) && announced > size) throw new Error('the file is larger than the portal said');
    let bytes = 0;
    const count = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > size) cb(new Error('the file is larger than the portal said')); else cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]), count, fs.createWriteStream(part));
    if (bytes !== size) throw new Error('the file is not the size the portal said');
    fs.renameSync(part, abs);
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch { /* nothing to remove */ }
    throw e;
  }
}

/**
 * Runner side: write the files the portal sent into the work folder, both the inline ones ({path, data}) and the large ones
 * ({path, url, size}), which are downloaded. Every path and limit is re-checked. An entry that is skipped or fails is said in a
 * status line, never silently. Returns how many files were written.
 */
export async function writeInputFilesAsync(workDir: string, files: unknown, emit: StatusEmitter = () => {}, opts: InputFileDownloadOptions = {}): Promise<number> {
  if (!Array.isArray(files)) return 0;
  const root = path.resolve(workDir);
  try { return await writeInputFilesCore(root, files, emit, opts); } finally { unpackInputZips(root, emit); }
}

async function writeInputFilesCore(root: string, files: unknown[], emit: StatusEmitter, opts: InputFileDownloadOptions): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const allow = opts.allowUrl ?? isInputFileUrl;
  const timeoutMs = opts.timeoutMs ?? URL_FILE_LIMITS.timeoutMs;
  let written = 0;
  let inlineTotal = 0;
  let urlTotal = 0;
  const skipped = (label: string, why: string): void => emit({ type: 'status', text: `Input file ${label} was skipped: ${why}` });
  for (const [i, f] of files.slice(0, INPUT_FILE_LIMITS.files).entries()) {
    const entry = (f && typeof f === 'object' ? f : {}) as { path?: unknown; data?: unknown; url?: unknown; size?: unknown };
    const label = typeof entry.path === 'string' && entry.path ? path.posix.basename(entry.path).slice(0, 80) : `#${i + 1}`;
    const target = inputTarget(root, entry.path);
    if (!target) { skipped(label, 'it is not in an allowed folder or of an allowed type'); continue; }

    if (typeof entry.data === 'string') {
      const buf = Buffer.from(entry.data, 'base64');
      if (buf.length === 0 || buf.length > INPUT_FILE_LIMITS.fileBytes || inlineTotal + buf.length > INPUT_FILE_LIMITS.totalBytes) { skipped(label, 'it is empty or over the size limit'); continue; }
      fs.mkdirSync(path.dirname(target.abs), { recursive: true });
      fs.writeFileSync(target.abs, buf);
      inlineTotal += buf.length;
      written++;
      continue;
    }

    if (entry.url === undefined) { skipped(label, 'it came with no content'); continue; }
    const size = entry.size;
    if (typeof entry.url !== 'string' || !allow(entry.url)) { skipped(label, 'its download address is not allowed'); continue; }
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > URL_FILE_LIMITS.fileBytes || urlTotal + size > URL_FILE_LIMITS.totalBytes) { skipped(label, 'it is over the size limit'); continue; }
    try {
      await downloadInputFile(entry.url, target.abs, size, fetchImpl, timeoutMs);
      urlTotal += size;
      written++;
    } catch (e) {
      emit({ type: 'status', text: `Input file ${label} could not be downloaded: ${noLinks(e instanceof Error ? e.message : String(e))}` });
    }
  }
  return written;
}

// ── Zip attachments ─────────────────────────────────────────────────────────────────────────────────────────

/** What an attached zip may unpack to. A zip inside a zip is unpacked too (down to `depth` levels); deeper ones stay as files. */
export const ZIP_LIMITS = { files: 400, fileBytes: 100 * 1024 * 1024, totalBytes: 300 * 1024 * 1024, depth: 3, nameChars: 120, listed: 2000 };

export interface ZipEntryInfo { name: string; method: number; flags: number; csize: number; usize: number; offset: number; attrs: number }

/** The entries of a zip held in memory (its central directory). Throws, with a reason a person can read, when it cannot be read. */
export function listZipEntries(buf: Buffer): ZipEntryInfo[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('it is not a readable zip file');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported');
  if (cdOffset + cdSize > buf.length) throw new Error('the zip directory is damaged');
  const out: ZipEntryInfo[] = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('the zip directory is damaged');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    if (p + 46 + nameLen > buf.length) throw new Error('the zip directory is damaged');
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const offset = buf.readUInt32LE(p + 42);
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw new Error('zip64 archives are not supported');
    out.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLen), flags: buf.readUInt16LE(p + 8), method: buf.readUInt16LE(p + 10),
      csize, usize, offset, attrs: buf.readUInt32LE(p + 38),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The content of one entry, never more than `maxBytes` (a zip that claims less than it holds is stopped, not trusted). */
export function readZipEntry(buf: Buffer, e: ZipEntryInfo, maxBytes: number): Buffer {
  if (e.flags & 1) throw new Error('it is password protected');
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error('it is damaged');
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const end = start + e.csize;
  if (end > buf.length) throw new Error('it is damaged');
  const packed = buf.subarray(start, end);
  let data: Buffer;
  if (e.method === 0) {
    if (packed.length > maxBytes) throw new Error('it is too large');
    data = Buffer.from(packed);
  } else if (e.method === 8) {
    try { data = zlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, maxBytes) }); } catch (err) {
      throw new Error(err instanceof RangeError ? 'it is too large' : 'it is damaged');
    }
  } else {
    throw new Error('it uses a compression method that is not supported');
  }
  if (data.length !== e.usize) throw new Error('it is damaged');
  return data;
}

/** A zip entry name as folder names under the target, or null when it would leave the target ('..', absolute) or has no name. */
export function zipEntryPath(name: string): string[] | null {
  const segs = name.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
  if (!segs.length || segs.some((s) => s === '..' || s.length > ZIP_LIMITS.nameChars)) return null;
  return segs.map((s) => s.replace(/[\u0000-\u001f<>:"|?*]/g, '_'));
}

interface UnpackState { top: string; files: number; bytes: number; written: Array<{ rel: string; size: number }>; skipped: Array<{ name: string; why: string }> }

function unpackZipBuffer(buf: Buffer, dest: string, rel: string, state: UnpackState, depth: number): void {
  const entries = listZipEntries(buf);
  const root = path.resolve(dest);
  for (const e of entries) {
    if (e.name.endsWith('/') || e.name.endsWith('\\')) continue;
    const segs = zipEntryPath(e.name);
    const label = `${rel}${e.name}`.slice(0, 200);
    // macOS adds these next to the real files; they are not content.
    if (segs && (segs[0] === '__MACOSX' || segs[segs.length - 1] === '.DS_Store')) continue;
    const skip = (why: string): void => { state.skipped.push({ name: label, why }); };
    if (!segs) { skip('its path is not allowed'); continue; }
    if (((e.attrs >>> 16) & 0xf000) === 0xa000) { skip('it is a link'); continue; }
    if (state.files >= ZIP_LIMITS.files) { skip(`more than ${ZIP_LIMITS.files} files`); continue; }
    const room = Math.min(ZIP_LIMITS.fileBytes, ZIP_LIMITS.totalBytes - state.bytes);
    if (e.usize > room) { skip('it is too large'); continue; }
    let data: Buffer;
    try { data = readZipEntry(buf, e, room); } catch (err) { skip(err instanceof Error ? err.message : 'it could not be read'); continue; }
    const last = segs[segs.length - 1];
    if (last.toLowerCase().endsWith('.zip') && depth + 1 < ZIP_LIMITS.depth) {
      const inner = [...segs.slice(0, -1), last.slice(0, -4) || 'zip'];
      try { unpackZipBuffer(data, path.join(root, ...inner), `${rel}${segs.join('/')}!/`, state, depth + 1); continue; } catch { /* kept as a file below */ }
    }
    const abs = path.resolve(root, ...segs);
    if (!abs.startsWith(root + path.sep)) { skip('its path is not allowed'); continue; }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data, { flag: 'wx' });
    } catch { skip('it could not be written (a file of that name exists)'); continue; }
    state.files++;
    state.bytes += data.length;
    state.written.push({ rel: path.relative(state.top, abs).split(path.sep).join('/'), size: data.length });
  }
}

/**
 * Unpack every `attachments/<name>.zip` into `attachments/<name>/` (zips inside it into folders of their own), so the agent can read
 * what a zip holds. Every file is kept (a PDF next to the CSV it was made from too), except links, paths that leave the folder,
 * password-protected or damaged entries and what goes over ZIP_LIMITS: those are listed, with the reason, in `_unpacked.txt` in the
 * folder, next to the list of files. The zip is removed once unpacked; one that cannot be read stays and is said in a status line.
 * Run again for a folder already unpacked, it only removes the zip. Returns how many zips were unpacked. Never throws.
 */
export function unpackInputZips(workDir: string, emit: StatusEmitter = () => {}): number {
  const dir = path.join(path.resolve(workDir), 'attachments');
  let names: fs.Dirent[];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  let unpacked = 0;
  for (const n of names) {
    if (!n.isFile() || path.extname(n.name).toLowerCase() !== '.zip') continue;
    const zipPath = path.join(dir, n.name);
    const stem = n.name.slice(0, -4).replace(/[^\w.-]/g, '_').slice(0, 80) || 'zip';
    const target = path.join(dir, stem);
    const index = path.join(target, '_unpacked.txt');
    try {
      if (fs.existsSync(index)) { fs.rmSync(zipPath, { force: true }); continue; }
      if (fs.statSync(zipPath).size > ZIP_LIMITS.fileBytes) { emit({ type: 'status', text: `The zip ${n.name} was not unpacked: it is over ${ZIP_LIMITS.fileBytes / 1048576} MB` }); continue; }
      fs.rmSync(target, { recursive: true, force: true });
      const state: UnpackState = { top: target, files: 0, bytes: 0, written: [], skipped: [] };
      fs.mkdirSync(target, { recursive: true });
      unpackZipBuffer(fs.readFileSync(zipPath), target, '', state, 0);
      const lines = [
        `Unpacked from attachments/${n.name}: ${state.files} file${state.files === 1 ? '' : 's'}, ${(state.bytes / 1048576).toFixed(1)} MB.`,
        'Zips inside it were unpacked into folders of the same name. Files below are relative to this folder.',
        '', '# size in bytes, path',
        ...state.written.slice(0, ZIP_LIMITS.listed).map((f) => `${f.size}\t${f.rel}`),
        ...(state.written.length > ZIP_LIMITS.listed ? [`... and ${state.written.length - ZIP_LIMITS.listed} more`] : []),
      ];
      if (state.skipped.length) lines.push('', `# NOT unpacked (${state.skipped.length})`, ...state.skipped.slice(0, 200).map((s) => `${s.name}: ${s.why}`));
      fs.writeFileSync(index, lines.join('\n') + '\n', 'utf8');
      fs.rmSync(zipPath, { force: true });
      unpacked++;
      emit({ type: 'status', text: `Unpacked attachments/${stem}/: ${state.files} files${state.skipped.length ? `, ${state.skipped.length} could not be unpacked (see _unpacked.txt)` : ''}` });
    } catch (e) {
      emit({ type: 'status', text: `The zip ${n.name} could not be unpacked: ${e instanceof Error ? e.message.slice(0, 160) : 'unknown error'}` });
    }
  }
  return unpacked;
}
