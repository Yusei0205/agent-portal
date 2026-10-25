/**
 * Copies of generated diagrams, documents and decks in the project Vault.
 *
 * Every stored diagram version, document version and deck is also kept as a plain file in the project vault, so people
 * can find, download and share it without opening the portal's Create page:
 *
 *   generated/diagrams/<slug>.mmd (+ <slug>.png when the renderer is available)
 *   generated/docs/<name>.md and <name>.docx
 *   generated/decks/<name>.pptx
 *
 * Only the latest version is kept, replaced in place; older versions stay in the portal's version history. The folder
 * is never copied into runs (vault.ts NO_RUN_COPY). It follows the project's "Save generated files to the Vault" setting
 * (on by default). Deleting the diagram, document or deck removes its copies. Writing is best-effort: a full vault or an
 * unwritable disk never fails the generation, it only leaves the copy out and says why.
 */
import fs from 'node:fs';
import path from 'node:path';
import { one } from './db.ts';
import { auditRaw } from './audit.ts';
import { MAX_FILE, MAX_VAULT, listVault, vaultDir } from './vault.ts';
import { safeJoin } from './util.ts';

export const GENERATED_DIR = 'generated';
export type GeneratedKind = 'diagrams' | 'docs' | 'decks';

export interface GeneratedFile {
  ext: string;
  data: Buffer | string;
}

export function generatedEnabled(projectId: string): boolean {
  const p = one<{ vault_generated: number }>('SELECT vault_generated FROM projects WHERE id = ?', projectId);
  return Boolean(p && p.vault_generated);
}

const rel = (kind: GeneratedKind, name: string, ext: string) => `${GENERATED_DIR}/${kind}/${name}.${ext}`;

/** The copies that exist now for a diagram, document or deck, as paths inside the project vault. */
export function generatedFiles(projectId: string, kind: GeneratedKind, name: string | null | undefined): string[] {
  if (!name) return [];
  const dir = vaultDir('project', '', projectId);
  const folder = path.join(dir, GENERATED_DIR, kind);
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((f) => path.parse(f).name === name && fs.statSync(path.join(folder, f)).isFile())
    .sort()
    .map((f) => `${GENERATED_DIR}/${kind}/${f}`);
}

export interface SaveResult {
  saved: string[];
  skipped: string | null;
}

/**
 * Write (or replace) the copies of one item. `keepExts` names the extensions the item has now; copies with the same
 * name and another extension (for example a .docx the new version no longer has, or a picture of the previous diagram
 * version) are removed unless `prune` is false. Never throws.
 */
export function saveGenerated(projectId: string, kind: GeneratedKind, name: string, files: GeneratedFile[], actor: string | null, prune = true): SaveResult {
  const result: SaveResult = { saved: [], skipped: null };
  try {
    if (!generatedEnabled(projectId)) return { saved: [], skipped: 'The project does not save generated files to the Vault.' };
    const dir = vaultDir('project', '', projectId);
    const used = () => listVault(dir).reduce((n, e) => n + e.size, 0);
    for (const f of files) {
      const buf = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : f.data;
      const target = safeJoin(dir, rel(kind, name, f.ext));
      const before = fs.existsSync(target) ? fs.statSync(target).size : 0;
      if (buf.length > MAX_FILE) {
        result.skipped = `${f.ext} is larger than the Vault's per-file limit.`;
        continue;
      }
      if (used() - before + buf.length > MAX_VAULT) {
        result.skipped = 'The project vault is full, so the copy was not saved.';
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
      result.saved.push(rel(kind, name, f.ext));
    }
    if (prune) {
      for (const old of generatedFiles(projectId, kind, name)) {
        if (!files.some((f) => f.ext === path.extname(old).slice(1))) fs.rmSync(safeJoin(dir, old), { force: true });
      }
    }
  } catch (e: any) {
    result.skipped = `The copy could not be written: ${String(e?.message ?? e).slice(0, 160)}`;
  }
  try {
    auditRaw(actor, 'vault.generated', `project:${projectId}`, { projectId, kind, name, saved: result.saved, skipped: result.skipped });
  } catch {
    /* the database may be closing */
  }
  return result;
}

/** Remove every copy of one item (all extensions). Runs whatever the setting says, so deleting always cleans up. */
export function removeGenerated(projectId: string, kind: GeneratedKind, name: string | null | undefined, actor: string | null = null): string[] {
  const gone: string[] = [];
  try {
    const dir = vaultDir('project', '', projectId);
    for (const f of generatedFiles(projectId, kind, name)) {
      fs.rmSync(safeJoin(dir, f), { force: true });
      gone.push(f);
    }
    if (gone.length) auditRaw(actor, 'vault.generated_remove', `project:${projectId}`, { projectId, kind, name, removed: gone });
  } catch {
    /* best effort */
  }
  return gone;
}
