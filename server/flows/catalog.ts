/**
 * The recipes a session can run: the "workflows" folder of its owner's Agent setup for the session's engine
 * (kiro/workflows/*.yaml, claude/workflows/*.json, ...).
 *
 *   portal  a recipe in the portal's schema (recipe.ts): the portal runs it, on any engine (engine.ts);
 *   native  anything else in a Kiro session, such as a recipe written for Kiro's own workflow feature: the Kiro agent
 *           is given the recipe and runs it itself (command.ts). A portal recipe can ask for this with `runner: kiro`.
 */

import { readOwnerConfigFiles } from '../user-config.ts';
import type { WorkflowRecord } from '../repositories/sessions.ts';
import { FLOW_NAME, looksLikeFlow, parseRecipeText, validateRecipe, type FlowRecipe } from './recipe.ts';

export interface FlowEntry {
  name: string;
  description: string;
  kind: 'portal' | 'native';
  /** Path inside the setup folder, such as workflows/feature-pipeline.yaml. */
  file: string;
  /** The recipe, for a portal flow. */
  recipe?: FlowRecipe;
  /** The file's text, for a native recipe (handed to the Kiro agent). */
  text?: string;
  /** Why a recipe cannot be run. */
  error?: string;
}

const FOLDERS: Record<string, 'claude' | 'kiro' | 'codex'> = { 'claude-code': 'claude', kiro: 'kiro', codex: 'codex' };
const RECIPE_FILE = /^workflows\/([^/]+)\.(json|ya?ml)$/i;

export function flowFolderHint(engine: string): string {
  const f = FOLDERS[engine];
  return f ? `Agent setup › ${f[0].toUpperCase()}${f.slice(1)}: workflows/<name>.yaml` : 'Agent setup';
}

/** Every recipe of the session owner for the session's engine, by name. */
export async function listFlowEntries(w: WorkflowRecord): Promise<FlowEntry[]> {
  const folder = FOLDERS[String(w.engine)];
  const owner = w.created_by ? String(w.created_by) : '';
  if (!folder || !owner) return [];
  const files = await readOwnerConfigFiles(owner, folder, ['workflows'], (rel) => RECIPE_FILE.test(rel), 100).catch(() => []);
  const out: FlowEntry[] = [];
  const taken = new Set<string>();
  for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
    const base = RECIPE_FILE.exec(f.path)![1];
    let entry: FlowEntry;
    try {
      const doc = parseRecipeText(f.content, f.path);
      const forceNative = Boolean(doc && typeof doc === 'object' && String((doc as { runner?: unknown }).runner ?? '').toLowerCase() === 'kiro');
      if (looksLikeFlow(doc) && !forceNative) {
        const recipe = validateRecipe(doc, base);
        entry = { name: recipe.name, description: recipe.description, kind: 'portal', file: f.path, recipe };
      } else if (folder === 'kiro' && doc && typeof doc === 'object') {
        const d = doc as { name?: unknown; description?: unknown };
        const name = String(d.name ?? base).trim();
        entry = {
          name: FLOW_NAME.test(name) ? name : base,
          description: typeof d.description === 'string' ? d.description.trim().slice(0, 300) : '',
          kind: 'native', file: f.path, text: f.content,
        };
      } else {
        entry = { name: base, description: '', kind: 'portal', file: f.path, error: 'It needs a "steps" list where each step has a "prompt"' };
      }
    } catch (e) {
      entry = { name: base, description: '', kind: 'portal', file: f.path, error: String((e as Error).message ?? e).slice(0, 200) };
    }
    if (taken.has(entry.name.toLowerCase())) continue;
    taken.add(entry.name.toLowerCase());
    out.push(entry);
  }
  return out;
}

export async function findFlow(w: WorkflowRecord, name: string): Promise<FlowEntry | null> {
  const q = name.toLowerCase();
  return (await listFlowEntries(w)).find((e) => e.name.toLowerCase() === q) ?? null;
}
