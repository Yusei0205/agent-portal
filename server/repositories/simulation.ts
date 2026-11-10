/**
 * Repository interface for API simulation (see docs/plans/2026-11-10-api-simulation.md).
 *
 * SQLite default. DynamoDB activated by USE_DYNAMODB=true.
 *
 * DynamoDB table: portal-projects
 * Key design (no scans):
 *   API      PK=SIMAPI#<projectId>   SK=API#<apiId>
 *   Version  PK=SIMVER#<apiId>       SK=V#<version, zero-padded>
 *   Rule     PK=SIMRULE#<apiId>      SK=R#<ruleId>
 * Every access has the project id or the api id, so there is no lookup-by-id item.
 */

import { SqliteSimulationRepository } from './simulation-sqlite.ts';
import { usesDynamoDb } from './backend.ts';
import type { ApiSpec, MockRule } from '../api-sim/types.ts';

export type SimMode = 'mock' | 'hybrid' | 'live';

export interface SimApiRecord {
  id: string;
  project_id: string;
  name: string;
  /** Where it came from: the sheet name for an Excel import, the title for OpenAPI. Re-importing matches on this. */
  source_key: string;
  mode: SimMode;
  /** Base URL of the client's real API (https). Used by `live`, and by `hybrid` for operations marked live. */
  live_base_url: string;
  /** Block an operation that has no rule instead of answering from its response schema. */
  require_explicit_rule: boolean;
  /** Hybrid only: operationId -> mode. Anything not listed is mocked. */
  operation_modes: Record<string, 'mock' | 'live'>;
  /** 0 = nothing approved yet; the hosted endpoint refuses to answer until a version is approved. */
  approved_version: number;
  latest_version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type SimApiUpdate = Partial<Pick<SimApiRecord, 'name' | 'mode' | 'live_base_url' | 'require_explicit_rule' | 'operation_modes' | 'approved_version' | 'latest_version'>>;

export interface SimVersionRecord {
  api_id: string;
  version: number;
  status: 'draft' | 'approved';
  spec: ApiSpec;
  created_by: string | null;
  created_at: string;
}

export interface SimulationRepository {
  listApis(projectId: string): Promise<SimApiRecord[]>;
  getApi(projectId: string, id: string): Promise<SimApiRecord | null>;
  createApi(rec: SimApiRecord): Promise<SimApiRecord>;
  updateApi(projectId: string, id: string, fields: SimApiUpdate): Promise<SimApiRecord | null>;
  /** Removes the API with its versions and rules. */
  deleteApi(projectId: string, id: string): Promise<boolean>;

  addVersion(rec: SimVersionRecord): Promise<void>;
  getVersion(apiId: string, version: number): Promise<SimVersionRecord | null>;
  listVersions(apiId: string): Promise<SimVersionRecord[]>;
  updateVersion(apiId: string, version: number, fields: { status?: 'draft' | 'approved'; spec?: ApiSpec }): Promise<void>;

  listRules(apiId: string): Promise<MockRule[]>;
  putRule(apiId: string, rule: MockRule): Promise<void>;
  deleteRule(apiId: string, ruleId: string): Promise<boolean>;
}

let _instance: SimulationRepository | null = null;

export async function initSimulationRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbSimulationRepository } = await import('./simulation-dynamodb.ts');
    _instance = new DynamoDbSimulationRepository();
  } else {
    _instance = new SqliteSimulationRepository();
  }
}

export function getSimulationRepository(): SimulationRepository {
  if (!_instance) _instance = new SqliteSimulationRepository();
  return _instance;
}

export function setSimulationRepository(repo: SimulationRepository): void { _instance = repo; }
export function clearSimulationRepository(): void { _instance = null; }
