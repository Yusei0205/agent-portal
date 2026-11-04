/**
 * Repository interface for aws_accounts.
 *
 * SQLite default.  DynamoDB activated by USE_DYNAMODB=true.
 *
 * DynamoDB table: portal-projects
 * Key design:
 *   PK=AWSACCT#<projectId>   SK=ACCT#<id>   → all access patterns
 */

import { SqliteAwsAccountsRepository } from './aws-accounts-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Record types ───────────────────────────────────────────────────────────────

export interface AwsAccountRecord {
  id: string;
  project_id: string | null;
  name: string;
  auth_method: string;
  region: string | null;
  credentials_enc: string | null;
  profile_name: string | null;
  created_by: string | null;
  created_at: string;
}

export interface CreateAwsAccountInput {
  id: string;
  project_id: string;
  name: string;
  auth_method: string;
  region: string | null;
  credentials_enc: string | null;
  profile_name: string | null;
  created_by: string | null;
  created_at: string;
}

export interface UpdateAwsAccountFields {
  name?: string;
  region?: string | null;
  profile_name?: string | null;
  credentials_enc?: string | null;
}

// ── Repository interface ───────────────────────────────────────────────────────

export interface AwsAccountsRepository {
  getById(id: string): Promise<AwsAccountRecord | null>;
  getByIdAndProject(id: string, projectId: string): Promise<AwsAccountRecord | null>;
  listByProject(projectId: string): Promise<AwsAccountRecord[]>;
  create(input: CreateAwsAccountInput): Promise<AwsAccountRecord>;
  update(id: string, projectId: string, fields: UpdateAwsAccountFields): Promise<AwsAccountRecord | null>;
  delete(id: string, projectId: string): Promise<boolean>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: AwsAccountsRepository | null = null;

export async function initAwsAccountsRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbAwsAccountsRepository } = await import('./aws-accounts-dynamodb.ts');
    _instance = new DynamoDbAwsAccountsRepository();
  } else {
    _instance = new SqliteAwsAccountsRepository();
  }
}

export function getAwsAccountsRepository(): AwsAccountsRepository {
  if (!_instance) _instance = new SqliteAwsAccountsRepository();
  return _instance;
}

export function setAwsAccountsRepository(repo: AwsAccountsRepository): void { _instance = repo; }
export function clearAwsAccountsRepository(): void { _instance = null; }
