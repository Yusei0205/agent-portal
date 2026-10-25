/**
 * What a session produced: the diagram, document or deck it is making, for the session page (a banner and a link to the
 * Create page) and the glue between a session and its output:
 *
 *   sessionOutput(workflowId)       what the session is producing and how that stands (ready, error and why)
 *   markFollowUp(workflowId)        a message was sent to the session: its output shows as being made again
 *   syncProjectGenerated(projectId) copy everything already stored to the project Vault (when the setting is turned on)
 *
 * The three producers (diagrams.ts, generated-docs.ts, presentations.ts) own the data; this file only reads their tables
 * and calls them, so it can be imported from the workflow code without a cycle.
 */
import { all, one, type Row } from './db.ts';
import { generatedEnabled, generatedFiles } from './vault-generated.ts';
import { diagramDensity } from './diagram-text.ts';

export type OutputKind = 'diagram' | 'doc' | 'deck';

export interface SessionOutput {
  kind: OutputKind;
  /** "Diagram", "Document" or "Deck": how the person knows it. */
  label: string;
  id: string;
  title: string;
  /** ready, generating or error. */
  status: string;
  /** Why it is in error, or why the last attempt was not stored. */
  error: string | null;
  version: number | null;
  stale: boolean;
  /** The Create tab that shows it (the router's tab name for href()). */
  tab: 'diagrams' | 'documents' | 'presentations';
  /** Copies in the project Vault, as paths inside it. */
  vault_files: string[];
  vault_enabled: boolean;
  /** Diagrams only: size facts, and whether it is too big to read comfortably. */
  density: { nodes: number; lines: number; dense: boolean } | null;
}

/** The output the session is making or has made, or null for any other session. */
export function sessionOutput(workflowId: string): SessionOutput | null {
  const d = one<Row>('SELECT * FROM diagrams WHERE workflow_id = ? OR pending_workflow_id = ?', workflowId, workflowId);
  if (d) {
    const cur = d.version > 0 ? one<Row>('SELECT mermaid FROM diagram_versions WHERE diagram_id = ? AND version = ?', d.id, d.version) : undefined;
    const density = cur ? diagramDensity(String(cur.mermaid)) : null;
    return {
      kind: 'diagram',
      label: 'Diagram',
      id: d.id,
      title: d.title,
      status: d.status,
      error: d.error ?? null,
      version: d.version > 0 ? d.version : null,
      stale: Boolean(d.stale),
      tab: 'diagrams',
      vault_files: generatedFiles(d.project_id, 'diagrams', d.slug),
      vault_enabled: generatedEnabled(d.project_id),
      density: density ? { nodes: density.nodes, lines: density.lines, dense: density.dense } : null,
    };
  }
  const g = one<Row>('SELECT * FROM generated_docs WHERE workflow_id = ? OR pending_workflow_id = ?', workflowId, workflowId);
  if (g) {
    return {
      kind: 'doc',
      label: 'Document',
      id: g.id,
      title: g.title,
      status: g.status,
      error: g.error ?? null,
      version: g.version > 0 ? g.version : null,
      stale: Boolean(g.stale),
      tab: 'documents',
      vault_files: generatedFiles(g.project_id, 'docs', g.vault_name),
      vault_enabled: generatedEnabled(g.project_id),
      density: null,
    };
  }
  const p = one<Row>('SELECT * FROM presentations WHERE workflow_id = ?', workflowId);
  if (p) {
    return {
      kind: 'deck',
      label: 'Deck',
      id: p.id,
      title: p.title,
      status: p.status,
      error: p.error ?? null,
      version: null,
      stale: false,
      tab: 'presentations',
      vault_files: generatedFiles(p.project_id, 'decks', p.vault_name),
      vault_enabled: generatedEnabled(p.project_id),
      density: null,
    };
  }
  return null;
}

/** A message was sent to a session: when it makes a diagram, document or deck, that output shows as being made again. */
export async function markFollowUp(workflowId: string): Promise<void> {
  if (!sessionOutput(workflowId)) return;
  (await import('./diagrams.ts')).followUpStarted(workflowId);
  (await import('./generated-docs.ts')).followUpStarted(workflowId);
  (await import('./presentations.ts')).followUpStarted(workflowId);
}

/**
 * Copy what is already stored (latest version of every diagram and document, every deck) to the project Vault. Used when
 * the setting is turned on, so earlier work is there too. Returns how many items were copied.
 */
export async function syncProjectGenerated(projectId: string, actor: string | null): Promise<number> {
  if (!generatedEnabled(projectId)) return 0;
  let n = 0;
  const dg = await import('./diagrams.ts');
  for (const d of all<Row>('SELECT * FROM diagrams WHERE project_id = ? AND version > 0', projectId)) {
    const v = one<Row>('SELECT mermaid FROM diagram_versions WHERE diagram_id = ? AND version = ?', d.id, d.version);
    if (v) {
      dg.vaultSaveDiagram(d, String(v.mermaid), actor);
      n++;
    }
  }
  const gd = await import('./generated-docs.ts');
  for (const d of all<Row>('SELECT * FROM generated_docs WHERE project_id = ? AND version > 0', projectId)) {
    const v = one<Row>('SELECT * FROM generated_doc_versions WHERE doc_id = ? AND version = ?', d.id, d.version);
    if (v) {
      gd.vaultSaveDoc(d, v, actor);
      n++;
    }
  }
  const pr = await import('./presentations.ts');
  for (const p of all<Row>("SELECT * FROM presentations WHERE project_id = ? AND status = 'ready' AND file IS NOT NULL", projectId)) {
    if (pr.vaultSaveDeckFromStore(p, actor)) n++;
  }
  return n;
}
