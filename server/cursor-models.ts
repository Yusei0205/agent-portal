/**
 * Lists the models the Cursor CLI offers (`agent --list-models`).
 *
 * Output is a header line ("Available models") and then one `id - Label` line per model, the default marked
 * "(default)" in its label. Colour codes and zero-width characters (the real output has some) are stripped.
 */

import { spawnCursor } from './cursor-cmd.ts';

export interface CursorModel { id: string; label: string; default?: true }

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const INVISIBLE = /[​-‏⁠﻿]/g;
const ROW = /^([A-Za-z0-9][A-Za-z0-9._:-]{0,99})\s+-\s+(.+)$/;

export function parseCursorModels(output: string): CursorModel[] {
  const models: CursorModel[] = [];
  for (const raw of output.replace(ANSI, '').replace(INVISIBLE, '').split(/\r?\n/)) {
    const m = ROW.exec(raw.trim());
    if (!m) continue;
    // The marker is "(default)", or "(current, default)" when the person has also chosen it.
    const isDefault = /\((?:[^)]*,\s*)?default\)\s*$/i.test(m[2]);
    const label = m[2].replace(/\s*\((?:current|default)(?:,\s*(?:current|default))?\)\s*$/i, '').trim();
    models.push({ id: m[1], label: label || m[1], ...(isDefault ? { default: true as const } : {}) });
  }
  return models;
}

/** Runs the CLI with the given key (or its own login when none). Never throws: returns an error string instead. */
export async function listCursorModels(apiKey: string | null, timeoutMs = 30_000, childEnv?: NodeJS.ProcessEnv): Promise<{ models: CursorModel[]; error?: string }> {
  const env: NodeJS.ProcessEnv = childEnv ?? { ...process.env, ...(apiKey ? { CURSOR_API_KEY: apiKey } : {}) };
  return await new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (r: { models: CursorModel[]; error?: string }): void => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child: ReturnType<typeof spawnCursor>;
    try { child = spawnCursor(['--list-models'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ models: [], error: `Could not start the Cursor CLI: ${(e as Error).message}` }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ models: [], error: 'The Cursor CLI took too long to list models.' }); }, timeoutMs);
    child.stdout?.setEncoding('utf8'); child.stdout?.on('data', (c: string) => { out += c; });
    child.stderr?.setEncoding('utf8'); child.stderr?.on('data', (c: string) => { err = (err + c).slice(-1_000); });
    child.on('error', (e: NodeJS.ErrnoException) => finish({ models: [], error: e.code === 'ENOENT' ? 'The Cursor CLI was not found. Install it or set PORTAL_CURSOR_BIN.' : `Could not start the Cursor CLI: ${e.message}` }));
    child.on('close', (code) => {
      const models = parseCursorModels(out);
      if (models.length) finish({ models });
      else finish({ models: [], error: code === 0 ? 'The Cursor CLI returned no models.' : `The Cursor CLI could not list models (exit ${code}). ${err.replace(ANSI, '').trim().split(/\r?\n/).slice(-2).join(' ')}`.trim() });
    });
  });
}
