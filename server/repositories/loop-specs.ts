/**
 * Repository interface for p10_loop_specs + p10_loop_runs.
 *
 * DynamoDB table: portal-p10
 * Specs: PK=LOOPSPEC#<projectId>  SK=SPEC#<id>  (custom)
 *        PK=LOOPSPEC_BUILTIN       SK=SPEC#<id>  (builtin)
 * Runs:  PK=LOOPRUN#<specId>       SK=RUN#<isoStartedAt>#<id>
 * GSI-P10EntityId: PK=id, SK=entityType='loopspec'|'looprun'
 */

import { SqliteLoopSpecsRepository } from './loop-specs-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

export interface LoopSpecRecord {
  id: string;
  project_id: string | null;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_config: string;
  goal_template: string;
  rules: string | null;
  stop_config: string;
  max_iterations: number;
  enabled: number;
  is_builtin: number;
  created_at: string;
}

export interface LoopRunRecord {
  id: string;
  spec_id: string;
  status: string;
  iteration: number;
  last_workflow_id: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface CreateLoopSpecInput {
  id: string;
  project_id: string | null;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_config: string;
  goal_template: string;
  rules: string | null;
  stop_config: string;
  max_iterations: number;
  enabled: number;
  is_builtin: number;
  created_at: string;
}

export interface CreateLoopRunInput {
  id: string;
  spec_id: string;
  status: string;
  iteration: number;
  last_workflow_id: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface LoopSpecsRepository {
  createSpec(input: CreateLoopSpecInput): Promise<LoopSpecRecord>;
  getSpecById(id: string): Promise<LoopSpecRecord | null>;
  /** Returns builtin specs (project_id IS NULL) + project-specific specs. */
  listSpecsByProject(projectId: string): Promise<LoopSpecRecord[]>;
  updateSpec(id: string, projectId: string, patch: Partial<LoopSpecRecord>): Promise<LoopSpecRecord | null>;
  deleteSpec(id: string, projectId: string): Promise<boolean>;
  createRun(input: CreateLoopRunInput): Promise<LoopRunRecord>;
  getRunById(id: string): Promise<LoopRunRecord | null>;
  /** Last run for a spec (by started_at DESC). */
  getLastRunBySpec(specId: string): Promise<LoopRunRecord | null>;
  listRunsBySpec(specId: string, limit: number): Promise<LoopRunRecord[]>;
}

let _instance: LoopSpecsRepository | null = null;

export async function initLoopSpecsRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbLoopSpecsRepository } = await import('./loop-specs-dynamodb.ts');
    _instance = new DynamoDbLoopSpecsRepository();
  } else {
    _instance = new SqliteLoopSpecsRepository();
  }
}

export function getLoopSpecsRepository(): LoopSpecsRepository {
  if (!_instance) _instance = new SqliteLoopSpecsRepository();
  return _instance;
}

export function setLoopSpecsRepository(repo: LoopSpecsRepository): void { _instance = repo; }
export function clearLoopSpecsRepository(): void { _instance = null; }
