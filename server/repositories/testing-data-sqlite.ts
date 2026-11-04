/**
 * SQLite implementation of TestingRepository.
 * All SQL for testing-module tables lives here.
 */

import { one, all, run as dbRun, insert, update } from '../db.ts';
import type { DbParam } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  TestingRepository,
  TestProjectRecord,
  TestGroupRecord,
  TestScriptRecord,
  TestVaultItemRecord,
  TestVaultFileRecord,
  TestRunRecord,
  TestRunStepRecord,
  TestCaseSetRecord,
  TestCaseRecord,
  TestGenerationRecord,
  TraceStepRecord,
} from './testing-data.ts';

const S = (v: unknown): string => String(v ?? '');
const N = (v: unknown): number => Number(v ?? 0);

// ── Row converters ─────────────────────────────────────────────────────────────

function toTestProject(row: Row): TestProjectRecord {
  return {
    id:               S(row.id),
    project_id:       S(row.project_id),
    name:             S(row.name ?? ''),
    app_url:          S(row.app_url ?? ''),
    api_base_url:     row.api_base_url != null ? S(row.api_base_url) : null,
    repo_ids:         S(row.repo_ids ?? '[]'),
    vault_doc_paths:  S(row.vault_doc_paths ?? '[]'),
    viewport_width:   N(row.viewport_width ?? 1440),
    viewport_height:  N(row.viewport_height ?? 900),
    timeout_secs:     N(row.timeout_secs ?? 300),
    rules_for_ai:     S(row.rules_for_ai ?? ''),
    created_by:       row.created_by != null ? S(row.created_by) : null,
    created_at:       S(row.created_at ?? ''),
    updated_at:       S(row.updated_at ?? ''),
  };
}

function toGroup(row: Row): TestGroupRecord {
  return {
    id:               S(row.id),
    test_project_id:  S(row.test_project_id),
    name:             S(row.name ?? ''),
    sort_order:       N(row.sort_order),
    created_at:       S(row.created_at ?? ''),
    updated_at:       S(row.updated_at ?? ''),
  };
}

function toScript(row: Row): TestScriptRecord {
  return {
    id:               S(row.id),
    test_project_id:  S(row.test_project_id),
    test_group_id:    S(row.test_group_id),
    name:             S(row.name ?? ''),
    sort_order:       N(row.sort_order),
    steps:            S(row.steps ?? '[]'),
    created_by:       row.created_by != null ? S(row.created_by) : null,
    created_at:       S(row.created_at ?? ''),
    updated_at:       S(row.updated_at ?? ''),
  };
}

function toVaultItem(row: Row): TestVaultItemRecord {
  return {
    id:               S(row.id),
    test_project_id:  S(row.test_project_id),
    name:             S(row.name ?? ''),
    kind:             S(row.kind ?? 'secret') as 'login' | 'secret',
    username:         row.username != null ? S(row.username) : null,
    password_enc:     row.password_enc != null ? S(row.password_enc) : null,
    totp_secret_enc:  row.totp_secret_enc != null ? S(row.totp_secret_enc) : null,
    value_enc:        row.value_enc != null ? S(row.value_enc) : null,
    created_by:       row.created_by != null ? S(row.created_by) : null,
    created_at:       S(row.created_at ?? ''),
    updated_at:       S(row.updated_at ?? ''),
  };
}

function toVaultFile(row: Row): TestVaultFileRecord {
  return {
    id:               S(row.id),
    test_project_id:  S(row.test_project_id),
    name:             S(row.name ?? ''),
    path:             S(row.path ?? ''),
    size_bytes:       N(row.size_bytes),
    mime_type:        row.mime_type != null ? S(row.mime_type) : null,
    uploaded_by:      row.uploaded_by != null ? S(row.uploaded_by) : null,
    created_at:       S(row.created_at ?? ''),
  };
}

function toRun(row: Row): TestRunRecord {
  return {
    id:               S(row.id),
    test_project_id:  S(row.test_project_id),
    script_id:        row.script_id != null ? S(row.script_id) : null,
    group_id:         row.group_id != null ? S(row.group_id) : null,
    status:           S(row.status ?? 'queued'),
    error:            row.error != null ? S(row.error) : null,
    artifact_dir:     row.artifact_dir != null ? S(row.artifact_dir) : null,
    created_by:       row.created_by != null ? S(row.created_by) : null,
    created_at:       S(row.created_at ?? ''),
    started_at:       row.started_at != null ? S(row.started_at) : null,
    finished_at:      row.finished_at != null ? S(row.finished_at) : null,
  };
}

function toRunStep(row: Row): TestRunStepRecord {
  return {
    id:              S(row.id),
    run_id:          S(row.run_id),
    script_id:       S(row.script_id),
    step_index:      N(row.step_index),
    status:          S(row.status ?? 'passed'),
    duration_ms:     row.duration_ms != null ? N(row.duration_ms) : null,
    error:           row.error != null ? S(row.error) : null,
    screenshot_path: row.screenshot_path != null ? S(row.screenshot_path) : null,
    created_at:      S(row.created_at ?? ''),
  };
}

function toCaseSet(row: Row): TestCaseSetRecord {
  return {
    id:                  S(row.id),
    test_project_id:     S(row.test_project_id),
    name:                S(row.name ?? ''),
    description:         S(row.description ?? ''),
    status:              S(row.status ?? 'queued'),
    progress:            S(row.progress ?? '{}'),
    error:               row.error != null ? S(row.error) : null,
    warnings:            S(row.warnings ?? '[]'),
    created_by:          row.created_by != null ? S(row.created_by) : null,
    created_at:          S(row.created_at ?? ''),
    started_at:          row.started_at != null ? S(row.started_at) : null,
    finished_at:         row.finished_at != null ? S(row.finished_at) : null,
    cancelled:           N(row.cancelled),
    outline_categories:  row.outline_categories != null ? S(row.outline_categories) : null,
    attachment_ids:      S(row.attachment_ids ?? '[]'),
  };
}

function toCase(row: Row): TestCaseRecord {
  return {
    id:              S(row.id),
    case_set_id:     S(row.case_set_id),
    ord:             N(row.ord),
    test_id:         S(row.test_id ?? ''),
    category:        S(row.category ?? ''),
    scenario:        S(row.scenario ?? ''),
    precondition:    S(row.precondition ?? ''),
    steps:           S(row.steps ?? ''),
    expected_result: S(row.expected_result ?? ''),
    status:          S(row.status ?? ''),
    remarks:         S(row.remarks ?? ''),
    request:         row.request != null ? S(row.request) : null,
    response:        row.response != null ? S(row.response) : null,
    created_at:      S(row.created_at ?? ''),
    updated_at:      S(row.updated_at ?? ''),
  };
}

function toGeneration(row: Row): TestGenerationRecord {
  return {
    id:                S(row.id),
    test_project_id:   S(row.test_project_id),
    script_id:         row.script_id != null ? S(row.script_id) : null,
    kind:              S(row.kind ?? 'generate'),
    description:       row.description != null ? S(row.description) : null,
    status:            S(row.status ?? 'pending'),
    error:             row.error != null ? S(row.error) : null,
    result_script_ids: S(row.result_script_ids ?? '[]'),
    warnings:          S(row.warnings ?? '[]'),
    created_by:        row.created_by != null ? S(row.created_by) : null,
    created_at:        S(row.created_at ?? ''),
    finished_at:       row.finished_at != null ? S(row.finished_at) : null,
    progress:          S(row.progress ?? '{}'),
    started_at:        row.started_at != null ? S(row.started_at) : null,
    cancelled_at:      row.cancelled_at != null ? S(row.cancelled_at) : null,
  };
}

function toTrace(row: Row): TraceStepRecord {
  return {
    id:               S(row.id),
    case_set_id:      row.case_set_id != null ? S(row.case_set_id) : null,
    generation_id:    row.generation_id != null ? S(row.generation_id) : null,
    seq:              N(row.seq),
    kind:             S(row.kind ?? ''),
    label:            S(row.label ?? ''),
    status:           S(row.status ?? 'running'),
    started_at:       S(row.started_at ?? ''),
    finished_at:      row.finished_at != null ? S(row.finished_at) : null,
    duration_ms:      row.duration_ms != null ? N(row.duration_ms) : null,
    detail:           S(row.detail ?? '{}'),
    prompt:           row.prompt != null ? S(row.prompt) : null,
    output:           row.output != null ? S(row.output) : null,
    output_truncated: N(row.output_truncated),
    error:            row.error != null ? S(row.error) : null,
  };
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class SqliteTestingRepository implements TestingRepository {
  // test_projects
  async createTestProject(rec: TestProjectRecord): Promise<TestProjectRecord> {
    insert('test_projects', {
      id: rec.id, project_id: rec.project_id, name: rec.name, app_url: rec.app_url,
      api_base_url: rec.api_base_url, repo_ids: rec.repo_ids, vault_doc_paths: rec.vault_doc_paths,
      viewport_width: rec.viewport_width, viewport_height: rec.viewport_height,
      timeout_secs: rec.timeout_secs, rules_for_ai: rec.rules_for_ai,
      created_by: rec.created_by, created_at: rec.created_at, updated_at: rec.updated_at,
    });
    return toTestProject(one<Row>('SELECT * FROM test_projects WHERE id = ?', rec.id)!);
  }

  async getTestProjectById(id: string): Promise<TestProjectRecord | null> {
    const row = one<Row>('SELECT * FROM test_projects WHERE id = ?', id);
    return row ? toTestProject(row) : null;
  }

  async getTestProjectByProjectAndId(projectId: string, id: string): Promise<TestProjectRecord | null> {
    const row = one<Row>('SELECT * FROM test_projects WHERE id = ? AND project_id = ?', id, projectId);
    return row ? toTestProject(row) : null;
  }

  async listTestProjectsByProject(projectId: string): Promise<TestProjectRecord[]> {
    const rows = all<Row>('SELECT * FROM test_projects WHERE project_id = ? ORDER BY name', projectId);
    return rows.map(toTestProject);
  }

  async updateTestProject(id: string, fields: Partial<TestProjectRecord>): Promise<void> {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) f[k] = v;
    update('test_projects', id, f as Record<string, DbParam>);
  }

  async deleteTestProject(id: string): Promise<void> {
    dbRun('DELETE FROM test_projects WHERE id = ?', id);
  }

  // test_groups
  async createTestGroup(rec: TestGroupRecord): Promise<TestGroupRecord> {
    insert('test_groups', {
      id: rec.id, test_project_id: rec.test_project_id, name: rec.name,
      sort_order: rec.sort_order, created_at: rec.created_at, updated_at: rec.updated_at,
    });
    return toGroup(one<Row>('SELECT * FROM test_groups WHERE id = ?', rec.id)!);
  }

  async getTestGroupById(id: string): Promise<TestGroupRecord | null> {
    const row = one<Row>('SELECT * FROM test_groups WHERE id = ?', id);
    return row ? toGroup(row) : null;
  }

  async getTestGroupByTestProjectAndId(testProjectId: string, id: string): Promise<TestGroupRecord | null> {
    const row = one<Row>('SELECT * FROM test_groups WHERE id = ? AND test_project_id = ?', id, testProjectId);
    return row ? toGroup(row) : null;
  }

  async listGroupsByTestProject(testProjectId: string): Promise<TestGroupRecord[]> {
    const rows = all<Row>('SELECT * FROM test_groups WHERE test_project_id = ? ORDER BY sort_order, name', testProjectId);
    return rows.map(toGroup);
  }

  async getMaxGroupSortOrder(testProjectId: string): Promise<number> {
    const row = one<{ n: number }>('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM test_groups WHERE test_project_id = ?', testProjectId);
    return Number(row?.n ?? 0);
  }

  async updateTestGroup(id: string, fields: Partial<TestGroupRecord>): Promise<void> {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) f[k] = v;
    update('test_groups', id, f as Record<string, DbParam>);
  }

  async deleteTestGroup(id: string): Promise<void> {
    dbRun('DELETE FROM test_groups WHERE id = ?', id);
  }

  // test_scripts
  async createTestScript(rec: TestScriptRecord): Promise<TestScriptRecord> {
    insert('test_scripts', {
      id: rec.id, test_project_id: rec.test_project_id, test_group_id: rec.test_group_id,
      name: rec.name, sort_order: rec.sort_order, steps: rec.steps,
      created_by: rec.created_by, created_at: rec.created_at, updated_at: rec.updated_at,
    });
    return toScript(one<Row>('SELECT * FROM test_scripts WHERE id = ?', rec.id)!);
  }

  async getTestScriptById(id: string): Promise<TestScriptRecord | null> {
    const row = one<Row>('SELECT * FROM test_scripts WHERE id = ?', id);
    return row ? toScript(row) : null;
  }

  async getTestScriptByTestProjectAndId(testProjectId: string, id: string): Promise<TestScriptRecord | null> {
    const row = one<Row>('SELECT * FROM test_scripts WHERE id = ? AND test_project_id = ?', id, testProjectId);
    return row ? toScript(row) : null;
  }

  async listScriptsByTestProject(testProjectId: string): Promise<TestScriptRecord[]> {
    const rows = all<Row>('SELECT * FROM test_scripts WHERE test_project_id = ? ORDER BY sort_order', testProjectId);
    return rows.map(toScript);
  }

  async listScriptsByGroup(groupId: string): Promise<TestScriptRecord[]> {
    const rows = all<Row>('SELECT * FROM test_scripts WHERE test_group_id = ? ORDER BY sort_order', groupId);
    return rows.map(toScript);
  }

  async updateTestScript(id: string, fields: Partial<TestScriptRecord>): Promise<void> {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) f[k] = v;
    update('test_scripts', id, f as Record<string, DbParam>);
  }

  async deleteTestScript(id: string): Promise<void> {
    dbRun('DELETE FROM test_scripts WHERE id = ?', id);
  }

  // test_vault_items
  async createVaultItem(rec: TestVaultItemRecord): Promise<TestVaultItemRecord> {
    insert('test_vault_items', {
      id: rec.id, test_project_id: rec.test_project_id, name: rec.name, kind: rec.kind,
      username: rec.username, password_enc: rec.password_enc, totp_secret_enc: rec.totp_secret_enc,
      value_enc: rec.value_enc, created_by: rec.created_by, created_at: rec.created_at,
      updated_at: rec.updated_at,
    });
    return toVaultItem(one<Row>('SELECT * FROM test_vault_items WHERE id = ?', rec.id)!);
  }

  async getVaultItemByTestProjectAndName(testProjectId: string, name: string): Promise<TestVaultItemRecord | null> {
    const row = one<Row>('SELECT * FROM test_vault_items WHERE test_project_id = ? AND name = ?', testProjectId, name);
    return row ? toVaultItem(row) : null;
  }

  async getVaultItemById(id: string): Promise<TestVaultItemRecord | null> {
    const row = one<Row>('SELECT * FROM test_vault_items WHERE id = ?', id);
    return row ? toVaultItem(row) : null;
  }

  async listVaultItemsByTestProject(testProjectId: string): Promise<TestVaultItemRecord[]> {
    const rows = all<Row>('SELECT * FROM test_vault_items WHERE test_project_id = ? ORDER BY kind, name', testProjectId);
    return rows.map(toVaultItem);
  }

  async updateVaultItem(id: string, fields: Partial<TestVaultItemRecord>): Promise<void> {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) f[k] = v;
    update('test_vault_items', id, f as Record<string, DbParam>);
  }

  async deleteVaultItem(id: string): Promise<void> {
    dbRun('DELETE FROM test_vault_items WHERE id = ?', id);
  }

  // test_vault_files
  async createVaultFile(rec: TestVaultFileRecord): Promise<TestVaultFileRecord> {
    insert('test_vault_files', {
      id: rec.id, test_project_id: rec.test_project_id, name: rec.name, path: rec.path,
      size_bytes: rec.size_bytes, mime_type: rec.mime_type, uploaded_by: rec.uploaded_by,
      created_at: rec.created_at,
    });
    return toVaultFile(one<Row>('SELECT * FROM test_vault_files WHERE id = ?', rec.id)!);
  }

  async getVaultFileByTestProjectAndId(testProjectId: string, id: string): Promise<TestVaultFileRecord | null> {
    const row = one<Row>('SELECT * FROM test_vault_files WHERE id = ? AND test_project_id = ?', id, testProjectId);
    return row ? toVaultFile(row) : null;
  }

  async getVaultFileById(id: string): Promise<TestVaultFileRecord | null> {
    const row = one<Row>('SELECT * FROM test_vault_files WHERE id = ?', id);
    return row ? toVaultFile(row) : null;
  }

  async getVaultFileByTestProjectAndName(testProjectId: string, name: string): Promise<TestVaultFileRecord | null> {
    const row = one<Row>('SELECT * FROM test_vault_files WHERE test_project_id = ? AND name = ?', testProjectId, name);
    return row ? toVaultFile(row) : null;
  }

  async listVaultFilesByTestProject(testProjectId: string): Promise<TestVaultFileRecord[]> {
    const rows = all<Row>('SELECT id, name, size_bytes, mime_type, created_at FROM test_vault_files WHERE test_project_id = ? ORDER BY name', testProjectId);
    return rows.map(toVaultFile);
  }

  async deleteVaultFile(id: string): Promise<void> {
    dbRun('DELETE FROM test_vault_files WHERE id = ?', id);
  }

  // test_runs
  async createTestRun(rec: TestRunRecord): Promise<TestRunRecord> {
    insert('test_runs', {
      id: rec.id, test_project_id: rec.test_project_id, script_id: rec.script_id,
      group_id: rec.group_id, status: rec.status, error: rec.error,
      artifact_dir: rec.artifact_dir, created_by: rec.created_by,
      created_at: rec.created_at, started_at: rec.started_at, finished_at: rec.finished_at,
    });
    return toRun(one<Row>('SELECT * FROM test_runs WHERE id = ?', rec.id)!);
  }

  async getTestRunById(id: string): Promise<TestRunRecord | null> {
    const row = one<Row>('SELECT * FROM test_runs WHERE id = ?', id);
    return row ? toRun(row) : null;
  }

  async getTestRunByTestProjectAndId(testProjectId: string, id: string): Promise<TestRunRecord | null> {
    const row = one<Row>('SELECT * FROM test_runs WHERE id = ? AND test_project_id = ?', id, testProjectId);
    return row ? toRun(row) : null;
  }

  async listRunsByTestProject(testProjectId: string, limit: number, offset: number): Promise<TestRunRecord[]> {
    const rows = all<Row>(
      `SELECT id, script_id, group_id, status, error, created_at, started_at, finished_at, created_by
       FROM test_runs WHERE test_project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      testProjectId, limit, offset,
    );
    return rows.map(toRun);
  }

  async updateTestRun(id: string, fields: Partial<TestRunRecord>): Promise<void> {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) f[k] = v as unknown;
    update('test_runs', id, f as Record<string, DbParam>);
  }

  // test_run_steps
  async createRunStep(rec: TestRunStepRecord): Promise<TestRunStepRecord> {
    insert('test_run_steps', {
      id: rec.id, run_id: rec.run_id, script_id: rec.script_id, step_index: rec.step_index,
      status: rec.status, duration_ms: rec.duration_ms, error: rec.error,
      screenshot_path: rec.screenshot_path, created_at: rec.created_at,
    });
    return rec;
  }

  async listStepsByRun(runId: string): Promise<TestRunStepRecord[]> {
    const rows = all<Row>(
      'SELECT id, script_id, step_index, status, duration_ms, error, screenshot_path, created_at FROM test_run_steps WHERE run_id = ? ORDER BY step_index',
      runId,
    );
    return rows.map((r) => ({ ...toRunStep(r), run_id: runId }));
  }

  // test_case_sets
  async createCaseSet(rec: TestCaseSetRecord): Promise<TestCaseSetRecord> {
    insert('test_case_sets', {
      id: rec.id, test_project_id: rec.test_project_id, name: rec.name, description: rec.description,
      status: rec.status, progress: rec.progress, error: rec.error, warnings: rec.warnings,
      created_by: rec.created_by, created_at: rec.created_at, started_at: rec.started_at,
      finished_at: rec.finished_at, cancelled: rec.cancelled,
      outline_categories: rec.outline_categories, attachment_ids: rec.attachment_ids,
    });
    return toCaseSet(one<Row>('SELECT * FROM test_case_sets WHERE id = ?', rec.id)!);
  }

  async getCaseSetById(id: string): Promise<TestCaseSetRecord | null> {
    const row = one<Row>('SELECT * FROM test_case_sets WHERE id = ?', id);
    return row ? toCaseSet(row) : null;
  }

  async getCaseSetByTestProjectAndId(testProjectId: string, id: string): Promise<TestCaseSetRecord | null> {
    const row = one<Row>('SELECT * FROM test_case_sets WHERE id = ? AND test_project_id = ?', id, testProjectId);
    return row ? toCaseSet(row) : null;
  }

  async listCaseSetsByTestProject(testProjectId: string, limit: number, offset: number): Promise<{ items: TestCaseSetRecord[]; total: number }> {
    const rows = all<Row>(
      'SELECT * FROM test_case_sets WHERE test_project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      testProjectId, limit, offset,
    );
    const countRow = one<{ n: number }>('SELECT COUNT(*) AS n FROM test_case_sets WHERE test_project_id = ?', testProjectId);
    return { items: rows.map(toCaseSet), total: Number(countRow?.n ?? 0) };
  }

  async updateCaseSet(id: string, fields: Partial<TestCaseSetRecord>): Promise<void> {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) f[k] = v as unknown;
    update('test_case_sets', id, f as Record<string, DbParam>);
  }

  async deleteCaseSet(id: string): Promise<void> {
    dbRun('DELETE FROM test_case_sets WHERE id = ?', id);
  }

  // test_cases
  async createCase(rec: TestCaseRecord): Promise<TestCaseRecord> {
    insert('test_cases', {
      id: rec.id, case_set_id: rec.case_set_id, ord: rec.ord, test_id: rec.test_id,
      category: rec.category, scenario: rec.scenario, precondition: rec.precondition,
      steps: rec.steps, expected_result: rec.expected_result, status: rec.status,
      remarks: rec.remarks, request: rec.request, response: rec.response,
      created_at: rec.created_at, updated_at: rec.updated_at,
    });
    return rec;
  }

  async getCaseById(id: string): Promise<TestCaseRecord | null> {
    const row = one<Row>('SELECT * FROM test_cases WHERE id = ?', id);
    return row ? toCase(row) : null;
  }

  async listCasesByCaseSet(caseSetId: string): Promise<TestCaseRecord[]> {
    const rows = all<Row>('SELECT * FROM test_cases WHERE case_set_id = ? ORDER BY ord', caseSetId);
    return rows.map(toCase);
  }

  async updateCase(id: string, fields: Partial<TestCaseRecord>): Promise<void> {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) f[k] = v as unknown;
    update('test_cases', id, f as Record<string, DbParam>);
  }

  async deleteCase(id: string): Promise<void> {
    dbRun('DELETE FROM test_cases WHERE id = ?', id);
  }

  async countCasesByCaseSet(caseSetId: string): Promise<number> {
    const row = one<{ c: number }>('SELECT COUNT(*) AS c FROM test_cases WHERE case_set_id = ?', caseSetId);
    return Number(row?.c ?? 0);
  }

  async getMaxOrdByCaseSet(caseSetId: string): Promise<number> {
    const row = one<{ m: number | null }>('SELECT MAX(ord) AS m FROM test_cases WHERE case_set_id = ?', caseSetId);
    return Number(row?.m ?? 0);
  }

  async getCategoryOrderByCaseSet(caseSetId: string): Promise<string[]> {
    const rows = all<{ category: string }>('SELECT category FROM test_cases WHERE case_set_id = ? GROUP BY category ORDER BY MIN(ord)', caseSetId);
    return rows.map((r) => r.category);
  }

  async countCasesByCaseSetAndCategory(caseSetId: string, category: string): Promise<number> {
    const row = one<{ c: number }>('SELECT COUNT(*) AS c FROM test_cases WHERE case_set_id = ? AND category = ?', caseSetId, category);
    return Number(row?.c ?? 0);
  }

  // test_generations
  async createGeneration(rec: TestGenerationRecord): Promise<TestGenerationRecord> {
    insert('test_generations', {
      id: rec.id, test_project_id: rec.test_project_id, script_id: rec.script_id,
      kind: rec.kind, description: rec.description, status: rec.status, error: rec.error,
      result_script_ids: rec.result_script_ids, warnings: rec.warnings,
      created_by: rec.created_by, created_at: rec.created_at, finished_at: rec.finished_at,
      progress: rec.progress, started_at: rec.started_at, cancelled_at: rec.cancelled_at,
    });
    return toGeneration(one<Row>('SELECT * FROM test_generations WHERE id = ?', rec.id)!);
  }

  async getGenerationById(id: string): Promise<TestGenerationRecord | null> {
    const row = one<Row>('SELECT * FROM test_generations WHERE id = ?', id);
    return row ? toGeneration(row) : null;
  }

  async getGenerationByTestProjectAndId(testProjectId: string, id: string): Promise<TestGenerationRecord | null> {
    const row = one<Row>('SELECT * FROM test_generations WHERE id = ? AND test_project_id = ?', id, testProjectId);
    return row ? toGeneration(row) : null;
  }

  async listGenerationsByTestProject(testProjectId: string, limit: number, offset: number): Promise<TestGenerationRecord[]> {
    const rows = all<Row>(
      'SELECT * FROM test_generations WHERE test_project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      testProjectId, limit, offset,
    );
    return rows.map(toGeneration);
  }

  async updateGeneration(id: string, fields: Partial<TestGenerationRecord>): Promise<void> {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) f[k] = v as unknown;
    update('test_generations', id, f as Record<string, DbParam>);
  }

  // trace_steps
  async createTraceStep(rec: TraceStepRecord): Promise<TraceStepRecord> {
    insert('trace_steps', {
      id: rec.id, case_set_id: rec.case_set_id, generation_id: rec.generation_id,
      seq: rec.seq, kind: rec.kind, label: rec.label, status: rec.status,
      started_at: rec.started_at, finished_at: rec.finished_at, duration_ms: rec.duration_ms,
      detail: rec.detail, prompt: rec.prompt, output: rec.output,
      output_truncated: rec.output_truncated, error: rec.error,
    });
    return rec;
  }

  async updateTraceStep(id: string, fields: Partial<TraceStepRecord>): Promise<void> {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) f[k] = v as unknown;
    update('trace_steps', id, f as Record<string, DbParam>);
  }

  async listTraceByCaseSet(caseSetId: string): Promise<TraceStepRecord[]> {
    const rows = all<Row>('SELECT * FROM trace_steps WHERE case_set_id = ? ORDER BY seq', caseSetId);
    return rows.map(toTrace);
  }

  async listTraceByGeneration(generationId: string): Promise<TraceStepRecord[]> {
    const rows = all<Row>('SELECT * FROM trace_steps WHERE generation_id = ? ORDER BY seq', generationId);
    return rows.map(toTrace);
  }

  async getMaxTraceSeqByCaseSet(caseSetId: string): Promise<number> {
    const row = one<{ m: number | null }>('SELECT MAX(seq) AS m FROM trace_steps WHERE case_set_id = ?', caseSetId);
    return Number(row?.m ?? 0);
  }
}
