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

/** Same list the portal accepts as session output (see output-files.ts). */
export const RUNNER_FILE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.pdf',
  '.md', '.docx', '.xlsx', '.pptx', '.csv', '.html', '.drawio',
]);

/** The deck's slide list: a JSON file the portal turns into the PowerPoint (presentations.ts), the one JSON file sent back. */
export const RUNNER_DECK_SPEC = 'deck.json';
const allowedRunnerName = (name: string): boolean => RUNNER_FILE_EXTS.has(path.extname(name).toLowerCase()) || name === RUNNER_DECK_SPEC;

/** Folders that hold tool state, clones or dependencies, not the agent's deliverables. */
export const RUNNER_EXCLUDED_DIRS = new Set([
  'repos', 'home', '.browser', '.claude', '.kiro', '.git', 'node_modules', '.local', '.cache', '.npm',
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
      if (!allowedRunnerName(e.name)) continue;
      let st: fs.Stats;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.mtimeMs < sinceMs) continue;
      if (st.size === 0 || st.size > RUNNER_FILE_LIMITS.fileBytes || r.length > RUNNER_FILE_LIMITS.pathChars) { skipped++; continue; }
      found.push({ rel: r, abs, size: st.size });
    }
  };
  walk(workDir, '');
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
  if (parts.some((s) => RUNNER_EXCLUDED_DIRS.has(s) && s !== parts[parts.length - 1])) return null;
  if (!allowedRunnerName(path.posix.basename(norm))) return null;
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
  '.md', '.txt', '.csv', '.json', '.yaml', '.yml', '.html', '.pdf', '.docx', '.xlsx', '.pptx',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.drawio',
]);

export const INPUT_FILE_LIMITS = { files: 30, fileBytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024 };

export interface InputFile {
  /** Relative path inside the work folder, under attachments/ or docs/md/. */
  path: string;
  /** File content, base64. */
  data: string;
}

/** Portal side: the files staged for a run (attachments, chosen project documents), within the limits. */
export function collectInputFiles(workDir: string): InputFile[] {
  const out: InputFile[] = [];
  let total = 0;
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const a = path.join(abs, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { walk(a, r, depth + 1); continue; }
      if (!e.isFile() || !INPUT_FILE_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      let st: fs.Stats;
      try { st = fs.statSync(a); } catch { continue; }
      if (st.size === 0 || st.size > INPUT_FILE_LIMITS.fileBytes) continue;
      if (out.length >= INPUT_FILE_LIMITS.files || total + st.size > INPUT_FILE_LIMITS.totalBytes) continue;
      try { out.push({ path: r, data: fs.readFileSync(a).toString('base64') }); total += st.size; } catch { /* skip */ }
    }
  };
  for (const d of INPUT_DIRS) walk(path.join(workDir, ...d.split('/')), d, 0);
  return out;
}

/** Runner side: write the files the portal sent into the work folder. Re-checks every path and limit. Returns how many were written. */
export function writeInputFiles(workDir: string, files: unknown): number {
  if (!Array.isArray(files)) return 0;
  const root = path.resolve(workDir);
  let written = 0;
  let total = 0;
  for (const f of files.slice(0, INPUT_FILE_LIMITS.files)) {
    const rel = (f as { path?: unknown })?.path;
    const data = (f as { data?: unknown })?.data;
    if (typeof rel !== 'string' || typeof data !== 'string' || !rel || rel.length > 300 || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/')) continue;
    const norm = path.posix.normalize(rel);
    if (norm.split('/').some((seg) => seg === '..' || seg === '') || !INPUT_DIRS.some((d) => norm.startsWith(`${d}/`))) continue;
    if (!INPUT_FILE_EXTS.has(path.posix.extname(norm).toLowerCase())) continue;
    const buf = Buffer.from(data, 'base64');
    if (buf.length === 0 || buf.length > INPUT_FILE_LIMITS.fileBytes || total + buf.length > INPUT_FILE_LIMITS.totalBytes) continue;
    const abs = path.resolve(root, ...norm.split('/'));
    if (!abs.startsWith(root + path.sep)) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    total += buf.length;
    written++;
  }
  return written;
}
