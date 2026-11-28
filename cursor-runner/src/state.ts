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
const ARCHIVE_NAME = 'state.tar.gz';
/** The only thing packed: the CLI's chat store, ~/.cursor/chats/<hash of the workspace path>/<session id>/. Never cli-config.json, auth or MCP files. */
const CHATS = '.cursor/chats';
const allowed = (name: string): boolean => !name.includes('\\') && !name.split('/').includes('..') && !name.startsWith('/')
  && (name === '.cursor' || name === '.cursor/' || name === CHATS || name.startsWith(CHATS + '/'));

export function stateExists(home: string): boolean {
  try { return fs.readdirSync(path.join(home, CHATS)).length > 0; } catch { return false; }
}

/** True once the chat store of `sessionId` is in place (the turn can be resumed). */
export function sessionExists(home: string, sessionId: string): boolean {
  try { return fs.readdirSync(path.join(home, CHATS)).some((hash) => fs.existsSync(path.join(home, CHATS, hash, sessionId))); } catch { return false; }
}

export async function saveCursorState(home: string, snapshot: WorkspaceSnapshot | null): Promise<boolean> {
  if (!snapshot) return false;
  if (!stateExists(home)) throw new Error('Cursor did not produce restorable conversation state');
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'cursor-state-save-'));
  const archive = path.join(folder, ARCHIVE_NAME);
  try {
    // The CLI has exited before this is called, so each chat's SQLite file is consistent.
    // tar runs in the archive's folder with a relative name: GNU tar reads "C:\..." as a remote host (Windows dev machines).
    await exec('tar', ['-czf', ARCHIVE_NAME, '-C', home, '--', CHATS], { cwd: folder, timeout: 120_000 });
    if ((await fsp.stat(archive)).size > MAX_STATE_BYTES) throw new Error('Cursor conversation snapshot exceeds the size limit');
    const result = await fetch(snapshot.putUrl, { method: 'PUT', body: await fsp.readFile(archive), signal: AbortSignal.timeout(120_000), redirect: 'error' });
    if (!result.ok) throw new Error('Could not persist Cursor conversation state');
    return true;
  } finally { await fsp.rm(archive, { force: true }); await fsp.rmdir(folder); }
}

export async function restoreCursorState(home: string, snapshot: WorkspaceSnapshot | null): Promise<boolean> {
  if (stateExists(home)) return true;
  if (!snapshot?.getUrl) return false;
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'cursor-state-restore-'));
  const archive = path.join(folder, ARCHIVE_NAME);
  try {
    const response = await fetch(snapshot.getUrl, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
    if (!response.ok || !response.body) throw new Error('Could not restore Cursor conversation state');
    let bytes = 0;
    await pipeline(Readable.fromWeb(response.body as never), new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > MAX_STATE_BYTES ? new Error('Cursor conversation snapshot exceeds the size limit') : null, chunk);
    } }), fs.createWriteStream(archive));
    const names = (await exec('tar', ['-tzf', ARCHIVE_NAME], { cwd: folder, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim().split('\n').filter(Boolean);
    if (!names.length || names.some((name) => !allowed(name))) throw new Error('Unexpected path in Cursor conversation snapshot');
    const kinds = (await exec('tar', ['-tvzf', ARCHIVE_NAME], { cwd: folder, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim().split('\n');
    if (kinds.some((line) => !['-', 'd'].includes(line[0]))) throw new Error('Links are not allowed in Cursor conversation snapshots');
    await fsp.mkdir(home, { recursive: true, mode: 0o700 });
    // Extract from inside the destination, naming the archive relative to it (see the note on saving).
    await exec('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', path.relative(home, archive).split(path.sep).join('/')], { cwd: home, timeout: 120_000 });
    return stateExists(home);
  } finally { await fsp.rm(archive, { force: true }); await fsp.rmdir(folder); }
}
