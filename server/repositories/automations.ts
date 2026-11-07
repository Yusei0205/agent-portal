/** Separate namespace from P6 sessions. One bounded JSON document per definition/version/run.
 * Version and run writes use compare-and-swap; a stale writer cannot overwrite newer state.
 * Existing portal-code table is reused without a new index or a table migration in AWS.
 */
import { all, one, run } from '../db.ts';
import { usesDynamoDb } from './backend.ts';

export interface AutomationRecord { revision: number; [key: string]: unknown }
export interface AutomationsRepository {
  get<T extends AutomationRecord>(project: string, key: string): Promise<T | null>;
  list<T extends AutomationRecord>(project: string, prefix: string): Promise<T[]>;
  put(project: string, key: string, value: AutomationRecord, expected: number | null): Promise<boolean>;
}
export class SqliteAutomationsRepository implements AutomationsRepository {
  async get<T extends AutomationRecord>(project: string, key: string): Promise<T | null> {
    const row = one('SELECT data FROM automation_records WHERE project_id = ? AND entity_key = ?', project, key);
    return row ? JSON.parse(String(row.data)) as T : null;
  }
  async list<T extends AutomationRecord>(project: string, prefix: string): Promise<T[]> {
    return all('SELECT data FROM automation_records WHERE project_id = ? AND substr(entity_key, 1, ?) = ? ORDER BY entity_key', project, prefix.length, prefix).map((r) => JSON.parse(String(r.data)) as T);
  }
  async put(project: string, key: string, value: AutomationRecord, expected: number | null): Promise<boolean> {
    if (Buffer.byteLength(JSON.stringify(value)) > 300_000) throw new Error('Workflow record exceeds 300 KB');
    if (expected === null) return Number(run('INSERT OR IGNORE INTO automation_records (project_id, entity_key, revision, data) VALUES (?, ?, ?, ?)', project, key, value.revision, JSON.stringify(value)).changes) === 1;
    return Number(run('UPDATE automation_records SET revision = ?, data = ? WHERE project_id = ? AND entity_key = ? AND revision = ?', value.revision, JSON.stringify(value), project, key, expected).changes) === 1;
  }
}
let dynamo: AutomationsRepository | null = null;
const sqlite = new SqliteAutomationsRepository();
export async function getAutomationsRepository(): Promise<AutomationsRepository> {
  if (!usesDynamoDb()) return sqlite;
  if (!dynamo) {
    const { DynamoAutomationsRepository } = await import('./automations-dynamodb.ts');
    dynamo = new DynamoAutomationsRepository();
  }
  return dynamo;
}
