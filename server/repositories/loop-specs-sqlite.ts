/**
 * SQLite implementation of LoopSpecsRepository.
 * All SQL for p10_loop_specs and p10_loop_runs lives here.
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type { LoopSpecsRepository, LoopSpecRecord, LoopRunRecord, CreateLoopSpecInput, CreateLoopRunInput } from './loop-specs.ts';

function toSpec(row: Row): LoopSpecRecord {
  return {
    id: String(row.id), project_id: row.project_id != null ? String(row.project_id) : null,
    name: String(row.name ?? ''), description: row.description != null ? String(row.description) : null,
    trigger_type: String(row.trigger_type ?? 'manual'), trigger_config: String(row.trigger_config ?? '{}'),
    goal_template: String(row.goal_template ?? ''), rules: row.rules != null ? String(row.rules) : null,
    stop_config: String(row.stop_config ?? '{}'), max_iterations: Number(row.max_iterations ?? 10),
    enabled: Number(row.enabled ?? 1), is_builtin: Number(row.is_builtin ?? 0),
    created_at: String(row.created_at ?? ''),
  };
}

function toRun(row: Row): LoopRunRecord {
  return {
    id: String(row.id), spec_id: String(row.spec_id ?? ''), status: String(row.status ?? ''),
    iteration: Number(row.iteration ?? 0),
    last_workflow_id: row.last_workflow_id != null ? String(row.last_workflow_id) : null,
    started_at: String(row.started_at ?? ''), finished_at: row.finished_at != null ? String(row.finished_at) : null,
  };
}

export class SqliteLoopSpecsRepository implements LoopSpecsRepository {
  async createSpec(input: CreateLoopSpecInput): Promise<LoopSpecRecord> {
    insert('p10_loop_specs', {
      id: input.id, project_id: input.project_id, name: input.name, description: input.description,
      trigger_type: input.trigger_type, trigger_config: input.trigger_config,
      goal_template: input.goal_template, rules: input.rules, stop_config: input.stop_config,
      max_iterations: input.max_iterations, enabled: input.enabled, is_builtin: input.is_builtin,
      created_at: input.created_at,
    });
    return toSpec(one<Row>('SELECT * FROM p10_loop_specs WHERE id = ?', input.id)!);
  }

  async getSpecById(id: string): Promise<LoopSpecRecord | null> {
    const row = one<Row>('SELECT * FROM p10_loop_specs WHERE id = ?', id);
    return row ? toSpec(row) : null;
  }

  async listSpecsByProject(projectId: string): Promise<LoopSpecRecord[]> {
    const builtins = all<Row>('SELECT * FROM p10_loop_specs WHERE project_id IS NULL AND is_builtin = 1 ORDER BY name');
    const custom = all<Row>('SELECT * FROM p10_loop_specs WHERE project_id = ? AND is_builtin = 0 ORDER BY created_at', projectId);
    return [...builtins, ...custom].map(toSpec);
  }

  async updateSpec(id: string, projectId: string, patch: Partial<LoopSpecRecord>): Promise<LoopSpecRecord | null> {
    const spec = one<Row>('SELECT * FROM p10_loop_specs WHERE id = ? AND project_id = ? AND is_builtin = 0', id, projectId);
    if (!spec) return null;
    const keys = Object.keys(patch).filter((k) => !['id', 'project_id', 'created_at', 'is_builtin'].includes(k));
    if (keys.length === 0) return toSpec(spec);
    dbRun(
      `UPDATE p10_loop_specs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => (patch as Record<string, unknown>)[k] as string | number | null),
      id,
    );
    return toSpec(one<Row>('SELECT * FROM p10_loop_specs WHERE id = ?', id)!);
  }

  async deleteSpec(id: string, projectId: string): Promise<boolean> {
    const result = dbRun('DELETE FROM p10_loop_specs WHERE id = ? AND project_id = ? AND is_builtin = 0', id, projectId) as { changes: number };
    return result.changes > 0;
  }

  async createRun(input: CreateLoopRunInput): Promise<LoopRunRecord> {
    insert('p10_loop_runs', {
      id: input.id, spec_id: input.spec_id, status: input.status,
      iteration: input.iteration, last_workflow_id: input.last_workflow_id,
      started_at: input.started_at, finished_at: input.finished_at,
    });
    return toRun(one<Row>('SELECT * FROM p10_loop_runs WHERE id = ?', input.id)!);
  }

  async getRunById(id: string): Promise<LoopRunRecord | null> {
    const row = one<Row>('SELECT * FROM p10_loop_runs WHERE id = ?', id);
    return row ? toRun(row) : null;
  }

  async getLastRunBySpec(specId: string): Promise<LoopRunRecord | null> {
    const row = one<Row>('SELECT * FROM p10_loop_runs WHERE spec_id = ? ORDER BY started_at DESC LIMIT 1', specId);
    return row ? toRun(row) : null;
  }

  async listRunsBySpec(specId: string, limit: number): Promise<LoopRunRecord[]> {
    const rows = all<Row>('SELECT * FROM p10_loop_runs WHERE spec_id = ? ORDER BY started_at DESC LIMIT ?', specId, limit);
    return rows.map(toRun);
  }
}
