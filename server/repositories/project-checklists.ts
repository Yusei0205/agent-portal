/** Versioned project documents. SQLite reuses key/value storage; DynamoDB uses
 * a separate partition in portal-config, outside the global settings snapshot. */
import { getDb } from '../db.ts';
import { usesDynamoDb } from './backend.ts';
import type { Checklist } from '../project-checklist-analysis.ts';

export class ChecklistConflict extends Error {}

export async function readChecklist(projectId: string): Promise<Checklist | null> {
  if (usesDynamoDb()) return (await import('./project-checklists-dynamodb.ts')).read(projectId);
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(`project.checklist.${projectId}`) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

/** Compare-and-swap also protects edits made from another portal instance. */
export async function writeChecklist(projectId: string, previous: Checklist | null, next: Checklist): Promise<void> {
  if (Buffer.byteLength(JSON.stringify(next)) > 280_000) throw new Error('Checklist is too large; shorten notes or remove items.');
  if (usesDynamoDb()) return (await import('./project-checklists-dynamodb.ts')).write(projectId, previous, next);
  const key = `project.checklist.${projectId}`;
  const result = previous
    ? getDb().prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?').run(JSON.stringify(next), key, JSON.stringify(previous))
    : getDb().prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(next));
  if (Number(result.changes) !== 1) throw new ChecklistConflict('Checklist changed. Reload before saving.');
}
