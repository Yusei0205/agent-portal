/**
 * Repository interface for all testing-module tables:
 *   test_projects, test_groups, test_scripts, test_vault_items, test_vault_files,
 *   test_runs, test_run_steps, test_case_sets, test_cases, test_generations, trace_steps.
 *
 * DynamoDB table: portal-testing (DYNAMODB_TABLE_PORTAL_TESTING, default 'portal-testing')
 *
 * Key design:
 *   PK=TP#<id>   SK=#META     → test_projects
 *   PK=TG#<id>   SK=#META     → test_groups
 *   PK=TS#<id>   SK=#META     → test_scripts
 *   PK=TVI#<id>  SK=#META     → test_vault_items
 *   PK=TVF#<id>  SK=#META     → test_vault_files
 *   PK=TR#<id>   SK=#META     → test_runs
 *   PK=TRS#<id>  SK=#META     → test_run_steps
 *   PK=TCS#<id>  SK=#META     → test_case_sets
 *   PK=TC#<id>   SK=#META     → test_cases
 *   PK=TGN#<id>  SK=#META     → test_generations
 *   PK=TRACE#<id>  SK=#META   → trace_steps
 *
 * GSI-TestByProject:
 *   PK=testProjectId  SK=<entityType>#<createdAt>#<id>
 * GSI-TestByTestProject:
 *   PK=testTestProjectId  SK=<entityType>#<createdAt>#<id>
 */

import { SqliteTestingRepository } from './testing-data-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Record types ──────────────────────────────────────────────────────────────

export interface TestProjectRecord {
  id: string;
  project_id: string;
  name: string;
  app_url: string;
  api_base_url: string | null;
  repo_ids: string;
  vault_doc_paths: string;
  viewport_width: number;
  viewport_height: number;
  timeout_secs: number;
  rules_for_ai: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TestGroupRecord {
  id: string;
  test_project_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TestScriptRecord {
  id: string;
  test_project_id: string;
  test_group_id: string;
  name: string;
  sort_order: number;
  steps: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TestVaultItemRecord {
  id: string;
  test_project_id: string;
  name: string;
  kind: 'login' | 'secret';
  username: string | null;
  password_enc: string | null;
  totp_secret_enc: string | null;
  value_enc: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TestVaultFileRecord {
  id: string;
  test_project_id: string;
  name: string;
  path: string;
  size_bytes: number;
  mime_type: string | null;
  uploaded_by: string | null;
  created_at: string;
}

export interface TestRunRecord {
  id: string;
  test_project_id: string;
  script_id: string | null;
  group_id: string | null;
  status: string;
  error: string | null;
  artifact_dir: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface TestRunStepRecord {
  id: string;
  run_id: string;
  script_id: string;
  step_index: number;
  status: string;
  duration_ms: number | null;
  error: string | null;
  screenshot_path: string | null;
  created_at: string;
}

export interface TestCaseSetRecord {
  id: string;
  test_project_id: string;
  name: string;
  description: string;
  status: string;
  progress: string;
  error: string | null;
  warnings: string;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cancelled: number;
  outline_categories: string | null;
  attachment_ids: string;
}

export interface TestCaseRecord {
  id: string;
  case_set_id: string;
  ord: number;
  test_id: string;
  category: string;
  scenario: string;
  precondition: string;
  steps: string;
  expected_result: string;
  status: string;
  remarks: string;
  request: string | null;
  response: string | null;
  created_at: string;
  updated_at: string;
}

export interface TestGenerationRecord {
  id: string;
  test_project_id: string;
  script_id: string | null;
  kind: string;
  description: string | null;
  status: string;
  error: string | null;
  result_script_ids: string;
  warnings: string;
  created_by: string | null;
  created_at: string;
  finished_at: string | null;
  progress: string;
  started_at: string | null;
  cancelled_at: string | null;
}

export interface TraceStepRecord {
  id: string;
  case_set_id: string | null;
  generation_id: string | null;
  seq: number;
  kind: string;
  label: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  detail: string;
  prompt: string | null;
  output: string | null;
  output_truncated: number;
  error: string | null;
}

// ── Repository interface ───────────────────────────────────────────────────────

export interface TestingRepository {
  // test_projects
  createTestProject(rec: TestProjectRecord): Promise<TestProjectRecord>;
  getTestProjectById(id: string): Promise<TestProjectRecord | null>;
  getTestProjectByProjectAndId(projectId: string, id: string): Promise<TestProjectRecord | null>;
  listTestProjectsByProject(projectId: string): Promise<TestProjectRecord[]>;
  updateTestProject(id: string, fields: Partial<TestProjectRecord>): Promise<void>;
  deleteTestProject(id: string): Promise<void>;

  // test_groups
  createTestGroup(rec: TestGroupRecord): Promise<TestGroupRecord>;
  getTestGroupById(id: string): Promise<TestGroupRecord | null>;
  getTestGroupByTestProjectAndId(testProjectId: string, id: string): Promise<TestGroupRecord | null>;
  listGroupsByTestProject(testProjectId: string): Promise<TestGroupRecord[]>;
  getMaxGroupSortOrder(testProjectId: string): Promise<number>;
  updateTestGroup(id: string, fields: Partial<TestGroupRecord>): Promise<void>;
  deleteTestGroup(id: string): Promise<void>;

  // test_scripts
  createTestScript(rec: TestScriptRecord): Promise<TestScriptRecord>;
  getTestScriptById(id: string): Promise<TestScriptRecord | null>;
  getTestScriptByTestProjectAndId(testProjectId: string, id: string): Promise<TestScriptRecord | null>;
  listScriptsByTestProject(testProjectId: string): Promise<TestScriptRecord[]>;
  listScriptsByGroup(groupId: string): Promise<TestScriptRecord[]>;
  updateTestScript(id: string, fields: Partial<TestScriptRecord>): Promise<void>;
  deleteTestScript(id: string): Promise<void>;

  // test_vault_items
  createVaultItem(rec: TestVaultItemRecord): Promise<TestVaultItemRecord>;
  getVaultItemByTestProjectAndName(testProjectId: string, name: string): Promise<TestVaultItemRecord | null>;
  getVaultItemById(id: string): Promise<TestVaultItemRecord | null>;
  listVaultItemsByTestProject(testProjectId: string): Promise<TestVaultItemRecord[]>;
  updateVaultItem(id: string, fields: Partial<TestVaultItemRecord>): Promise<void>;
  deleteVaultItem(id: string): Promise<void>;

  // test_vault_files
  createVaultFile(rec: TestVaultFileRecord): Promise<TestVaultFileRecord>;
  getVaultFileByTestProjectAndId(testProjectId: string, id: string): Promise<TestVaultFileRecord | null>;
  getVaultFileById(id: string): Promise<TestVaultFileRecord | null>;
  getVaultFileByTestProjectAndName(testProjectId: string, name: string): Promise<TestVaultFileRecord | null>;
  listVaultFilesByTestProject(testProjectId: string): Promise<TestVaultFileRecord[]>;
  deleteVaultFile(id: string): Promise<void>;

  // test_runs
  createTestRun(rec: TestRunRecord): Promise<TestRunRecord>;
  getTestRunById(id: string): Promise<TestRunRecord | null>;
  getTestRunByTestProjectAndId(testProjectId: string, id: string): Promise<TestRunRecord | null>;
  listRunsByTestProject(testProjectId: string, limit: number, offset: number): Promise<TestRunRecord[]>;
  updateTestRun(id: string, fields: Partial<TestRunRecord>): Promise<void>;

  // test_run_steps
  createRunStep(rec: TestRunStepRecord): Promise<TestRunStepRecord>;
  listStepsByRun(runId: string): Promise<TestRunStepRecord[]>;

  // test_case_sets
  createCaseSet(rec: TestCaseSetRecord): Promise<TestCaseSetRecord>;
  getCaseSetById(id: string): Promise<TestCaseSetRecord | null>;
  getCaseSetByTestProjectAndId(testProjectId: string, id: string): Promise<TestCaseSetRecord | null>;
  listCaseSetsByTestProject(testProjectId: string, limit: number, offset: number): Promise<{ items: TestCaseSetRecord[]; total: number }>;
  updateCaseSet(id: string, fields: Partial<TestCaseSetRecord>): Promise<void>;
  deleteCaseSet(id: string): Promise<void>;

  // test_cases
  createCase(rec: TestCaseRecord): Promise<TestCaseRecord>;
  getCaseById(id: string): Promise<TestCaseRecord | null>;
  listCasesByCaseSet(caseSetId: string): Promise<TestCaseRecord[]>;
  updateCase(id: string, fields: Partial<TestCaseRecord>): Promise<void>;
  deleteCase(id: string): Promise<void>;
  countCasesByCaseSet(caseSetId: string): Promise<number>;
  getMaxOrdByCaseSet(caseSetId: string): Promise<number>;
  getCategoryOrderByCaseSet(caseSetId: string): Promise<string[]>;
  countCasesByCaseSetAndCategory(caseSetId: string, category: string): Promise<number>;

  // test_generations
  createGeneration(rec: TestGenerationRecord): Promise<TestGenerationRecord>;
  getGenerationById(id: string): Promise<TestGenerationRecord | null>;
  getGenerationByTestProjectAndId(testProjectId: string, id: string): Promise<TestGenerationRecord | null>;
  listGenerationsByTestProject(testProjectId: string, limit: number, offset: number): Promise<TestGenerationRecord[]>;
  updateGeneration(id: string, fields: Partial<TestGenerationRecord>): Promise<void>;

  // trace_steps
  createTraceStep(rec: TraceStepRecord): Promise<TraceStepRecord>;
  updateTraceStep(id: string, fields: Partial<TraceStepRecord>): Promise<void>;
  listTraceByCaseSet(caseSetId: string): Promise<TraceStepRecord[]>;
  listTraceByGeneration(generationId: string): Promise<TraceStepRecord[]>;
  getMaxTraceSeqByCaseSet(caseSetId: string): Promise<number>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: TestingRepository | null = null;

export async function initTestingRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbTestingRepository } = await import('./testing-data-dynamodb.ts');
    _instance = new DynamoDbTestingRepository();
  } else {
    _instance = new SqliteTestingRepository();
  }
}

export function getTestingRepository(): TestingRepository {
  if (!_instance) _instance = new SqliteTestingRepository();
  return _instance;
}

export function setTestingRepository(repo: TestingRepository): void { _instance = repo; }
export function clearTestingRepository(): void { _instance = null; }
