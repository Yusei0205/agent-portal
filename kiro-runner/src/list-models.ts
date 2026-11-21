/**
 * kiro-list-models mode: run `kiro-cli chat --list-models --format json` with the caller's IdC token
 * and emit the raw output (the portal parses it). Token values are never logged or emitted.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { materialiseKiroAuthDb } from './run.js';
import type { KiroListModelsPayload } from './validate.js';

export type EmitFn = (event: Record<string, unknown>) => void;

const TIMEOUT_MS = 30_000;

export async function runKiroListModels(payload: KiroListModelsPayload, emit: EmitFn): Promise<void> {
  let authTmpDir: string | undefined;
  let kiroHome: string | undefined;
  try {
    const auth = await materialiseKiroAuthDb(payload.token);
    authTmpDir = auth.tmpDir;

    // kiro-cli-chat reads $HOME/.local/share/kiro-cli/data.sqlite3, so give it an isolated HOME.
    kiroHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'kiro-models-home-'));
    const dataDir = path.join(kiroHome, '.local', 'share', 'kiro-cli');
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.copyFile(auth.dbPath, path.join(dataDir, 'data.sqlite3'));

    const env: Record<string, string> = Object.fromEntries(
      Object.entries(process.env as Record<string, string | undefined>)
        .filter(([k, v]) => v !== undefined && k !== 'KIRO_TEST_DB_PATH')
        .map(([k, v]) => [k, v as string]),
    );
    env.HOME = kiroHome;
    env.USERPROFILE = kiroHome;
    env.XDG_DATA_HOME = path.join(kiroHome, '.local', 'share');

    emit({ type: 'status', text: 'Listing Kiro models...' });
    const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn('kiro-cli', ['chat', '--list-models', '--format', 'json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => { out += c; });
      child.stderr.on('data', (c: string) => { err += c; });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ok */ } }, TIMEOUT_MS);
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String(e.message) }); });
      child.on('close', (c) => { clearTimeout(timer); resolve({ code: c, stdout: out, stderr: err }); });
    });

    if (code !== 0) {
      emit({ type: 'error', message: `kiro-cli exited with code ${code}: ${(stderr.trim() || stdout.trim()).slice(-300)}` });
      return;
    }
    emit({ type: 'models', stdout });
  } finally {
    if (authTmpDir) await fsp.rm(authTmpDir, { recursive: true, force: true }).catch(() => {});
    if (kiroHome) await fsp.rm(kiroHome, { recursive: true, force: true }).catch(() => {});
  }
}
