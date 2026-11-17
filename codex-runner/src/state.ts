import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { WorkspaceSnapshot } from '../../server/agent/runner-snapshot.ts';

const exec = promisify(execFile);
const MAX_STATE_BYTES = 128 * 1024 * 1024;
const allowed = (name: string) => !name.includes('\\') && !name.split('/').includes('..')
  && (/^(sessions|archived_sessions)(\/[^\0]*)?\/?$/.test(name) || /^state_\d+\.sqlite(?:-wal)?$/.test(name));
const ARCHIVE_NAME = 'state.tar.gz';

export function stateExists(home: string): boolean {
  try { return fs.readdirSync(home).some(name => /^state_\d+\.sqlite$/.test(name) || name === 'sessions'); } catch { return false; }
}

/** Only conversation files are packed. auth.json, config, MCP secrets and logs never enter snapshots. */
export async function saveCodexState(home: string, snapshot: WorkspaceSnapshot | null): Promise<boolean> {
  if (!snapshot) return false;
  const entries = (await fsp.readdir(home)).filter(allowed);
  if (!entries.length) throw new Error('Codex did not produce restorable conversation state');
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-state-save-'));
  const archive = path.join(folder, ARCHIVE_NAME);
  try {
    // Codex has exited before this is called, so SQLite and its WAL form a consistent restore set.
    // tar runs in the archive's folder with a relative name: GNU tar reads "C:\..." as a remote host (Windows dev machines).
    await exec('tar', ['-czf', ARCHIVE_NAME, '-C', home, '--', ...entries], { cwd: folder, timeout: 120_000 });
    if ((await fsp.stat(archive)).size > MAX_STATE_BYTES) throw new Error('Codex conversation snapshot exceeds the size limit');
    const result = await fetch(snapshot.putUrl, { method: 'PUT', body: await fsp.readFile(archive), signal: AbortSignal.timeout(120_000), redirect: 'error' });
    if (!result.ok) throw new Error('Could not persist Codex conversation state');
    return true;
  } finally { await fsp.rm(archive, { force: true }); await fsp.rmdir(folder); }
}

export async function restoreCodexState(home: string, snapshot: WorkspaceSnapshot | null): Promise<boolean> {
  if (stateExists(home)) return true;
  if (!snapshot?.getUrl) return false;
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-state-restore-'));
  const archive = path.join(folder, ARCHIVE_NAME);
  try {
    const response = await fetch(snapshot.getUrl, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
    if (!response.ok || !response.body) throw new Error('Could not restore Codex conversation state');
    let bytes = 0;
    await pipeline(Readable.fromWeb(response.body as never), new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > MAX_STATE_BYTES ? new Error('Codex conversation snapshot exceeds the size limit') : null, chunk);
    } }), fs.createWriteStream(archive));
    const names = (await exec('tar', ['-tzf', ARCHIVE_NAME], { cwd: folder, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim().split('\n').filter(Boolean);
    if (!names.length || names.some(name => !allowed(name))) throw new Error('Unexpected path in Codex conversation snapshot');
    const kinds = (await exec('tar', ['-tvzf', ARCHIVE_NAME], { cwd: folder, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim().split('\n');
    if (kinds.some(line => !['-', 'd'].includes(line[0]))) throw new Error('Links are not allowed in Codex conversation snapshots');
    await fsp.mkdir(home, { recursive: true, mode: 0o700 });
    // Extract from inside the destination, naming the archive relative to it (see the note on saving).
    await exec('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', path.relative(home, archive).split(path.sep).join('/')], { cwd: home, timeout: 120_000 });
    return stateExists(home);
  } finally { await fsp.rm(archive, { force: true }); await fsp.rmdir(folder); }
}
