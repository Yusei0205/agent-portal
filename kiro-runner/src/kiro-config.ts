/**
 * The owner's Kiro agents, skills and steering, sent by the portal with a kiro-run (`kiroConfig`), written into
 * kiro-cli's home (~/.kiro) on this machine so custom agents and their skills work as they do locally.
 * Mirrors server/agent/kiro-config-files.ts (the portal side): only text files under agents/, skills/ and steering/.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface KiroConfigFile { path: string; content: string }

const MAX_FILES = 300;
const MAX_FILE_CHARS = 200_000;
const MAX_TOTAL_CHARS = 2_000_000;
const OK_PATH = /^(agents\/[A-Za-z0-9_.-]+\.json|(skills|steering)\/[A-Za-z0-9_.\/-]+\.(md|txt|json|ya?ml))$/;
/** A kiro-cli agent name for --agent. */
export const KIRO_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** The valid files of a payload's `kiroConfig`; anything malformed is dropped (the run still goes ahead). */
export function parseKiroConfig(raw: unknown): KiroConfigFile[] {
  if (!Array.isArray(raw)) return [];
  const out: KiroConfigFile[] = [];
  let total = 0;
  for (const f of raw.slice(0, MAX_FILES)) {
    if (!f || typeof f !== 'object') continue;
    const p = (f as Record<string, unknown>).path;
    const c = (f as Record<string, unknown>).content;
    if (typeof p !== 'string' || typeof c !== 'string') continue;
    if (!OK_PATH.test(p) || p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) continue;
    if (c.length > MAX_FILE_CHARS || total + c.length > MAX_TOTAL_CHARS) continue;
    out.push({ path: p, content: c });
    total += c.length;
  }
  return out;
}

/** Writes the files under `<home>/.kiro`. Returns how many were written. */
export function writeKiroConfig(home: string, files: KiroConfigFile[]): number {
  const root = path.resolve(home, '.kiro');
  let n = 0;
  for (const f of files) {
    const dest = path.resolve(root, f.path);
    if (!dest.startsWith(root + path.sep)) continue;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.content, 'utf8');
      n++;
    } catch { /* skipped */ }
  }
  return n;
}
