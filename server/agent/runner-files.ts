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
        walk(abs, r);
        continue;
      }
      if (!e.isFile()) continue;
      if (!RUNNER_FILE_EXTS.has(path.extname(e.name).toLowerCase())) continue;
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
  if (!RUNNER_FILE_EXTS.has(path.posix.extname(norm).toLowerCase())) return null;
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
