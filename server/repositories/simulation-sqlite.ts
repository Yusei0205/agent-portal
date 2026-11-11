/**
 * SQLite implementation of SimulationRepository.
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type { ApiSpec, MockRule } from '../api-sim/types.ts';
import type { RecordChange, RecordData, SimApiRecord, SimApiUpdate, SimCallRecord, SimVersionRecord, SimulationRepository } from './simulation.ts';

const KEEP_CALLS = 300;
const MAX_RECORDS = 5000;

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
    log_bodies: Number(r.log_bodies ?? 0) === 1,
    live_headers_enc: r.live_headers_enc != null ? String(r.live_headers_enc) : null,
    environments_enc: r.environments_enc != null ? String(r.environments_enc) : null,
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
      log_bodies: rec.log_bodies ? 1 : 0,
      live_headers_enc: rec.live_headers_enc,
      environments_enc: rec.environments_enc,
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
    if (fields.log_bodies !== undefined) add('log_bodies', fields.log_bodies ? 1 : 0);
    if (fields.live_headers_enc !== undefined) sets.push('live_headers_enc = ?'), vals.push(fields.live_headers_enc as string);
    if (fields.environments_enc !== undefined) sets.push('environments_enc = ?'), vals.push(fields.environments_enc as string);
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

  async appendCall(rec: SimCallRecord): Promise<void> {
    insert('sim_calls', { ...rec });
    // Keep the newest few hundred: the log is for looking at what just happened, not for keeping everything.
    dbRun('DELETE FROM sim_calls WHERE api_id = ? AND id NOT IN (SELECT id FROM sim_calls WHERE api_id = ? ORDER BY at DESC, id DESC LIMIT ?)', rec.api_id, rec.api_id, KEEP_CALLS);
  }

  async listCalls(apiId: string, limit: number): Promise<SimCallRecord[]> {
    return all<Row>('SELECT * FROM sim_calls WHERE api_id = ? ORDER BY at DESC, id DESC LIMIT ?', apiId, Math.max(1, Math.min(limit, KEEP_CALLS))).map((r) => ({
      id: String(r.id), api_id: String(r.api_id), at: String(r.at), via: String(r.via) === 'mcp' ? 'mcp' : 'rest', method: String(r.method), path: String(r.path),
      status: Number(r.status), mode: String(r.mode) === 'live' ? 'live' : 'mock', source: String(r.source), rule_id: r.rule_id != null ? String(r.rule_id) : null,
      warnings: Number(r.warnings ?? 0), ms: Number(r.ms ?? 0), request_text: r.request_text != null ? String(r.request_text) : null, response_text: r.response_text != null ? String(r.response_text) : null,
    }));
  }

  async clearCalls(apiId: string): Promise<void> { dbRun('DELETE FROM sim_calls WHERE api_id = ?', apiId); }

  async loadRecords(apiId: string): Promise<RecordData> {
    const out: RecordData = {};
    for (const r of all<Row>('SELECT collection, rec_key, record_json FROM sim_records WHERE api_id = ? LIMIT ?', apiId, MAX_RECORDS)) {
      (out[String(r.collection)] ??= {})[String(r.rec_key)] = parse<unknown>(r.record_json, null);
    }
    return out;
  }

  async applyChanges(apiId: string, changes: RecordChange[]): Promise<void> {
    const at = new Date().toISOString();
    for (const c of changes) {
      if (c.record === null) { dbRun('DELETE FROM sim_records WHERE api_id = ? AND collection = ? AND rec_key = ?', apiId, c.collection, c.key); continue; }
      dbRun(
        'INSERT INTO sim_records (api_id, collection, rec_key, record_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(api_id, collection, rec_key) DO UPDATE SET record_json = excluded.record_json, updated_at = excluded.updated_at',
        apiId, c.collection, c.key, JSON.stringify(c.record), at,
      );
    }
  }

  async replaceCollection(apiId: string, collection: string, items: Array<{ key: string; record: unknown }>): Promise<void> {
    dbRun('DELETE FROM sim_records WHERE api_id = ? AND collection = ?', apiId, collection);
    await this.applyChanges(apiId, items.map((i) => ({ collection, key: i.key, record: i.record })));
  }

  async clearCollection(apiId: string, collection: string): Promise<void> { dbRun('DELETE FROM sim_records WHERE api_id = ? AND collection = ?', apiId, collection); }

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
