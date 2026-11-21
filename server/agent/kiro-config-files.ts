/**
 * The parts of a run's ~/.kiro that a cloud (AgentCore) Kiro run needs: custom agents, skills and steering.
 *
 * A local Kiro run reads them from the run's materialised home. A cloud run happens on the runner's machine, so the
 * portal sends them along (`kiroConfig` in the kiro-run payload) and the runner writes them into kiro-cli's home there.
 * Only text files under agents/, skills/ and steering/ go; settings, hooks and MCP config stay with the portal.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface KiroConfigFile { path: string; content: string }

export const KIRO_CONFIG_LIMITS = { maxFiles: 300, maxFileBytes: 200_000, maxTotalBytes: 2_000_000 } as const;

/** A relative path the runner accepts (mirrors kiro-runner/src/kiro-config.ts). */
export const KIRO_CONFIG_PATH = /^(agents\/[A-Za-z0-9_.-]+\.json|(skills|steering)\/[A-Za-z0-9_.\/-]+\.(md|txt|json|ya?ml))$/;

/** Files from `<home>/.kiro`, in a stable order, within the limits. Empty when there is nothing. */
export function collectKiroConfig(homeDir: string | null): KiroConfigFile[] {
  if (!homeDir) return [];
  const root = path.join(homeDir, '.kiro');
  const out: KiroConfigFile[] = [];
  let total = 0;
  const walk = (rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= KIRO_CONFIG_LIMITS.maxFiles) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(childRel); continue; }
      if (!e.isFile() || !KIRO_CONFIG_PATH.test(childRel) || childRel.includes('..')) continue;
      try {
        const full = path.join(root, childRel);
        const size = fs.statSync(full).size;
        if (size > KIRO_CONFIG_LIMITS.maxFileBytes || total + size > KIRO_CONFIG_LIMITS.maxTotalBytes) continue;
        out.push({ path: childRel, content: fs.readFileSync(full, 'utf8') });
        total += size;
      } catch { /* unreadable: skipped */ }
    }
  };
  for (const top of ['agents', 'skills', 'steering']) walk(top);
  return out;
}

/** True when `name` is one of the custom agents in the files (agents/<file>.json with that `name`, or that file name). */
export function hasKiroAgent(files: KiroConfigFile[], name: string | null | undefined): boolean {
  if (!name) return false;
  return files.some((f) => {
    if (!f.path.startsWith('agents/')) return false;
    if (f.path === `agents/${name}.json`) return true;
    try { return (JSON.parse(f.content) as { name?: unknown }).name === name; } catch { return false; }
  });
}
