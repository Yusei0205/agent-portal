/**
 * Keeping a session's workspace (its repositories, with whatever the agent installed or changed in them) across
 * machines, by saving it to S3 and restoring it on a fresh machine.
 *
 * The runner works in a folder on its own disk (see runner-repos.ts, PERSIST_ROOT). An AgentCore machine is released
 * after a few idle minutes, and the disk goes with it. So:
 *  - after a run, if anything in `repos/` changed, the folder is packed (tar + gzip) and uploaded to a presigned URL
 *    the portal handed over; this happens after the reply has ended, while the machine reports itself busy, so the
 *    chat is not held up and the machine is not released half-way;
 *  - at the start of a run on a machine that has no `repos/` yet, the saved copy is downloaded and unpacked, and the
 *    normal "bring the repository up to date" step then only has to fetch what changed.
 *
 * The runner holds no AWS credentials for this: it only ever talks to the two presigned URLs in the payload (https,
 * amazonaws.com host). Nothing here is ever echoed to the chat except plain progress text.
 *
 * Shared by agent-runner and kiro-runner (copied in at image build time).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface WorkspaceSnapshot {
  /** Where the earlier copy can be downloaded (absent when none was saved yet). */
  getUrl?: string;
  /** Where the new copy is uploaded. */
  putUrl: string;
}

/** Largest packed workspace that is worth saving. */
export const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024 * 1024;
const STAMP = '.snapshot-stamp';

function okUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length > 4000) return false;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && /(^|\.)amazonaws\.com$/.test(x.hostname);
  } catch {
    return false;
  }
}

/** Reads the payload's `snapshot` field; anything that is not two S3 URLs is ignored (the feature is just off). */
export function parseSnapshot(raw: unknown): WorkspaceSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!okUrl(o.putUrl)) return null;
  if (o.getUrl !== undefined && !okUrl(o.getUrl)) return null;
  return { putUrl: o.putUrl, ...(o.getUrl ? { getUrl: o.getUrl as string } : {}) };
}

function log(event: string, extra: Record<string, unknown> = {}): void {
  process.stderr.write(JSON.stringify({ event, ...extra }) + '\n');
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => { if (out.length < 4000) out += d.toString('utf8'); });
    proc.stderr.on('data', (d: Buffer) => { if (err.length < 4000) err += d.toString('utf8'); });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); err += '\ntimed out'; }, timeoutMs);
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: 1, out, err: String(e.message) }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out, err }); });
  });
}

function hasRepos(root: string): boolean {
  try { return fs.readdirSync(path.join(root, 'repos')).length > 0; } catch { return false; }
}

/**
 * On a machine without `repos/`, downloads and unpacks the saved workspace. Returns true when it did.
 * A failure is reported and otherwise ignored: the repositories are then simply cloned again.
 */
export async function restoreWorkspace(
  snap: WorkspaceSnapshot | null,
  root: string | null,
  emit: (e: { type: 'status'; text: string }) => void,
): Promise<boolean> {
  if (!snap?.getUrl || !root || hasRepos(root)) return false;
  const started = Date.now();
  emit({ type: 'status', text: 'Restoring the saved workspace…' });
  try {
    const res = await fetch(snap.getUrl, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) {
      emit({ type: 'status', text: `No saved workspace could be restored (HTTP ${res.status}); repositories will be cloned again.` });
      return false;
    }
    const tar = spawn('tar', ['-xzf', '-'], { cwd: root, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    tar.stderr.on('data', (d: Buffer) => { if (err.length < 2000) err += d.toString('utf8'); });
    const closed = new Promise<number>((resolve) => {
      tar.on('error', () => resolve(1));
      tar.on('close', (code) => resolve(code ?? 1));
    });
    await pipeline(Readable.fromWeb(res.body as never), tar.stdin).catch(() => { /* reported through the exit code */ });
    const code = await closed;
    if (code !== 0) {
      fs.rmSync(path.join(root, 'repos'), { recursive: true, force: true });
      emit({ type: 'status', text: 'The saved workspace could not be unpacked; repositories will be cloned again.' });
      log('workspace_restore_failed', { code, err: err.slice(0, 300) });
      return false;
    }
    fs.writeFileSync(path.join(root, STAMP), String(Date.now()), 'utf8');
    const seconds = Math.round((Date.now() - started) / 1000);
    log('workspace_restored', { seconds });
    emit({ type: 'status', text: `Workspace restored in ${seconds}s.` });
    return true;
  } catch (e: unknown) {
    fs.rmSync(path.join(root, 'repos'), { recursive: true, force: true });
    emit({ type: 'status', text: 'The saved workspace could not be restored; repositories will be cloned again.' });
    log('workspace_restore_failed', { error: String((e as Error)?.message ?? e).slice(0, 300) });
    return false;
  }
}

/** True when something in `repos/` changed since the last save (git's own bookkeeping files do not count). */
async function changedSinceSave(root: string, signal: AbortSignal): Promise<boolean> {
  if (!fs.existsSync(path.join(root, STAMP))) { log('workspace_changed', { path: '(first save)' }); return true; }
  const r = await run('find', [
    'repos', '-newer', STAMP,
    '(',
    '-type', 'f', '-not', '-path', '*/.git/FETCH_HEAD', '-not', '-path', '*/.git/index', '-not', '-path', '*/.git/shallow', '-not', '-path', '*/.git/ORIG_HEAD', '-not', '-path', '*/.git/logs/*',
    '-o',
    '-type', 'd', '-not', '-path', '*/.git', '-not', '-path', '*/.git/*',
    ')',
    '-print',
  ], root, 60_000, signal);
  const changed = r.code !== 0 || r.out.trim() !== '';
  if (changed) log('workspace_changed', { path: r.out.trim().split(/\r?\n/).slice(0, 5).join(' ; ').slice(0, 400) || `(find exited ${r.code})` });
  return changed;
}

async function saveWorkspace(snap: WorkspaceSnapshot, root: string, signal: AbortSignal): Promise<void> {
  if (!hasRepos(root)) return;
  if (!(await changedSinceSave(root, signal))) { log('workspace_save_skipped', { reason: 'unchanged' }); return; }

  // A change made while the upload runs is newer than this stamp, so the next save picks it up.
  const newStamp = path.join(root, `${STAMP}.new`);
  fs.writeFileSync(newStamp, String(Date.now()), 'utf8');
  const packed = path.join(os.tmpdir(), `workspace-${process.pid}.tar.gz`);
  const started = Date.now();
  try {
    const t = await run('tar', ['--force-local', '--use-compress-program=gzip -1', '-cf', packed, 'repos'], root, 10 * 60_000, signal);
    if (signal.aborted) { log('workspace_save_cancelled', { step: 'pack' }); return; }
    if (t.code !== 0 && t.code !== 1) { // 1 = "file changed as we read it", still a usable archive
      log('workspace_save_failed', { step: 'pack', code: t.code, err: t.err.slice(0, 300) });
      return;
    }
    const size = fs.statSync(packed).size;
    if (size > MAX_SNAPSHOT_BYTES) {
      log('workspace_save_skipped', { reason: 'too large', bytes: size });
      return;
    }
    const res = await fetch(snap.putUrl, {
      method: 'PUT',
      body: fs.createReadStream(packed) as never,
      // Node needs this for a streamed request body; S3 needs the length up front.
      duplex: 'half',
      headers: { 'content-length': String(size) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]),
    } as RequestInit);
    if (!res.ok) {
      log('workspace_save_failed', { step: 'upload', status: res.status });
      return;
    }
    fs.renameSync(newStamp, path.join(root, STAMP));
    log('workspace_saved', { bytes: size, seconds: Math.round((Date.now() - started) / 1000) });
  } catch (e: unknown) {
    if (signal.aborted) log('workspace_save_cancelled', { step: 'upload' });
    else log('workspace_save_failed', { error: String((e as Error)?.message ?? e).slice(0, 300) });
  } finally {
    try { fs.rmSync(packed, { force: true }); } catch { /* ok */ }
    try { fs.rmSync(newStamp, { force: true }); } catch { /* ok */ }
  }
}

let pending: Promise<void> | null = null;
let cancel: AbortController | null = null;

/** The machine should report itself busy (so it is not released) while this is true. */
export function snapshotBusy(): boolean {
  return pending !== null;
}

/**
 * A new request calls this first: a save that is still running is cancelled (the new run saves again when it ends), so
 * the message never waits for an upload and never changes the folder while it is being packed.
 */
export async function cancelSnapshot(): Promise<void> {
  cancel?.abort();
  while (pending) await pending.catch(() => { /* logged */ });
}

/** Waits for a running save to finish without cancelling it (used by tests). */
export async function settleSnapshot(): Promise<void> {
  while (pending) await pending.catch(() => { /* logged */ });
}

/** Saves the workspace after the reply has ended. `onChange` is told when the busy state flips. */
export function saveWorkspaceInBackground(
  snap: WorkspaceSnapshot | null,
  root: string | null,
  onChange?: () => void,
): void {
  if (!snap || !root || pending) return;
  const ac = new AbortController();
  cancel = ac;
  pending = saveWorkspace(snap, root, ac.signal)
    .catch((e: unknown) => log('workspace_save_failed', { error: String((e as Error)?.message ?? e).slice(0, 300) }))
    .finally(() => { pending = null; cancel = null; onChange?.(); });
  onChange?.();
}
