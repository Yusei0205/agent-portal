/**
 * SQLite implementation of SimulationRepository.
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type { ApiSpec, MockRule } from '../api-sim/types.ts';
import type { SimApiRecord, SimApiUpdate, SimVersionRecord, SimulationRepository } from './simulation.ts';

function parse<T>(raw: unknown, fallback: T): T {
  try { return JSON.parse(String(raw ?? '')) as T; } catch { return fallback; }
}

function toApi(r: Row): SimApiRecord {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    name: String(r.name ?? ''),
    group_name: String(r.group_name ?? ''),
    source_key: String(r.source_key ?? ''),
    mode: (String(r.mode ?? 'mock') as SimApiRecord['mode']),
    live_base_url: String(r.live_base_url ?? ''),
    require_explicit_rule: Number(r.require_explicit_rule ?? 0) === 1,
    operation_modes: parse(r.operation_modes, {}),
    approved_version: Number(r.approved_version ?? 0),
    latest_version: Number(r.latest_version ?? 0),
    created_by: r.created_by != null ? String(r.created_by) : null,
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
  };
}

function toVersion(r: Row): SimVersionRecord {
  return {
    api_id: String(r.api_id),
    version: Number(r.version),
    status: String(r.status) === 'approved' ? 'approved' : 'draft',
    label: String(r.label ?? ''),
    spec: parse<ApiSpec>(r.spec_json, { openapi: '3.0.3', info: { title: '', version: '1' }, paths: {} }),
    created_by: r.created_by != null ? String(r.created_by) : null,
    created_at: String(r.created_at ?? ''),
  };
}

export class SqliteSimulationRepository implements SimulationRepository {
  async listApis(projectId: string): Promise<SimApiRecord[]> {
    return all<Row>('SELECT * FROM sim_apis WHERE project_id = ? ORDER BY created_at, name', projectId).map(toApi);
  }

  async getApi(projectId: string, id: string): Promise<SimApiRecord | null> {
    const r = one<Row>('SELECT * FROM sim_apis WHERE id = ? AND project_id = ?', id, projectId);
    return r ? toApi(r) : null;
  }

  async createApi(rec: SimApiRecord): Promise<SimApiRecord> {
    insert('sim_apis', {
      id: rec.id,
      project_id: rec.project_id,
      name: rec.name,
      group_name: rec.group_name,
      source_key: rec.source_key,
      mode: rec.mode,
      live_base_url: rec.live_base_url,
      require_explicit_rule: rec.require_explicit_rule ? 1 : 0,
      operation_modes: JSON.stringify(rec.operation_modes),
      approved_version: rec.approved_version,
      latest_version: rec.latest_version,
      created_by: rec.created_by,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
    });
    return rec;
  }

  async updateApi(projectId: string, id: string, fields: SimApiUpdate): Promise<SimApiRecord | null> {
    const sets: string[] = [];
    const vals: Array<string | number> = [];
    const add = (col: string, v: string | number): void => { sets.push(`${col} = ?`); vals.push(v); };
    if (fields.name !== undefined) add('name', fields.name);
    if (fields.group_name !== undefined) add('group_name', fields.group_name);
    if (fields.mode !== undefined) add('mode', fields.mode);
    if (fields.live_base_url !== undefined) add('live_base_url', fields.live_base_url);
    if (fields.require_explicit_rule !== undefined) add('require_explicit_rule', fields.require_explicit_rule ? 1 : 0);
    if (fields.operation_modes !== undefined) add('operation_modes', JSON.stringify(fields.operation_modes));
    if (fields.approved_version !== undefined) add('approved_version', fields.approved_version);
    if (fields.latest_version !== undefined) add('latest_version', fields.latest_version);
    if (sets.length > 0) {
      add('updated_at', new Date().toISOString());
      dbRun(`UPDATE sim_apis SET ${sets.join(', ')} WHERE id = ? AND project_id = ?`, ...vals, id, projectId);
    }
    return this.getApi(projectId, id);
  }

  async deleteApi(projectId: string, id: string): Promise<boolean> {
    // Versions and rules go with it (ON DELETE CASCADE); deleting them first keeps this correct if foreign keys are off.
    if (!one<Row>('SELECT id FROM sim_apis WHERE id = ? AND project_id = ?', id, projectId)) return false;
    dbRun('DELETE FROM sim_rules WHERE api_id = ?', id);
    dbRun('DELETE FROM sim_spec_versions WHERE api_id = ?', id);
    dbRun('DELETE FROM sim_apis WHERE id = ? AND project_id = ?', id, projectId);
    return true;
  }

  async addVersion(rec: SimVersionRecord): Promise<void> {
    insert('sim_spec_versions', {
      api_id: rec.api_id,
      version: rec.version,
      status: rec.status,
      label: rec.label,
      spec_json: JSON.stringify(rec.spec),
      created_by: rec.created_by,
      created_at: rec.created_at,
    });
  }

  async getVersion(apiId: string, version: number): Promise<SimVersionRecord | null> {
    const r = one<Row>('SELECT * FROM sim_spec_versions WHERE api_id = ? AND version = ?', apiId, version);
    return r ? toVersion(r) : null;
  }

  async listVersions(apiId: string): Promise<SimVersionRecord[]> {
    return all<Row>('SELECT * FROM sim_spec_versions WHERE api_id = ? ORDER BY version', apiId).map(toVersion);
  }

  async updateVersion(apiId: string, version: number, fields: { status?: 'draft' | 'approved'; spec?: ApiSpec }): Promise<void> {
    if (fields.status !== undefined) dbRun('UPDATE sim_spec_versions SET status = ? WHERE api_id = ? AND version = ?', fields.status, apiId, version);
    if (fields.spec !== undefined) dbRun('UPDATE sim_spec_versions SET spec_json = ? WHERE api_id = ? AND version = ?', JSON.stringify(fields.spec), apiId, version);
  }

  async listRules(apiId: string): Promise<MockRule[]> {
    return all<Row>('SELECT * FROM sim_rules WHERE api_id = ? ORDER BY rowid', apiId).map((r) => parse<MockRule>(r.rule_json, null as unknown as MockRule)).filter(Boolean);
  }

  async putRule(apiId: string, rule: MockRule): Promise<void> {
    const at = new Date().toISOString();
    const existing = one<Row>('SELECT id FROM sim_rules WHERE id = ? AND api_id = ?', rule.id, apiId);
    if (existing) dbRun('UPDATE sim_rules SET rule_json = ?, updated_at = ? WHERE id = ? AND api_id = ?', JSON.stringify(rule), at, rule.id, apiId);
    else insert('sim_rules', { id: rule.id, api_id: apiId, rule_json: JSON.stringify(rule), created_at: at, updated_at: at });
  }

  async deleteRule(apiId: string, ruleId: string): Promise<boolean> {
    const r = dbRun('DELETE FROM sim_rules WHERE id = ? AND api_id = ?', ruleId, apiId) as { changes: number };
    return r.changes > 0;
  }
}
