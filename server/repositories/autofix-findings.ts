/**
 * Repository interface for autofix_findings: one record per distinct problem (failed CI run, review finding, failed
 * session) per project, deduplicated by fingerprint. Not related to the code review tables (findings, p10_findings).
 *
 * SQLite is the default backend. DynamoDB is activated by USE_DYNAMODB=true.
 *
 * DynamoDB table used: portal-projects
 *
 * Key design:
 *   PK=PROJECT#<projectId>  SK=AFIND#<id>           the finding (all fields)
 *   PK=PROJECT#<projectId>  SK=AFFP#<fingerprint>   dedupe item holding the finding id; written with
 *                                                   attribute_not_exists in the same transaction as the finding
 *   PK=AFID#<id>            SK=#META                lookup item { project_id } written with the finding, for getById/transition
 *   PK=AFWF#<workflowId>    SK=#META                lookup item { project_id, id } written when a transition sets workflow_id
 *   getByFixBranch, list, countByStatus and sumCostSince read the project partition (AFIND# prefix) and filter there.
 */

import { SqliteAutofixFindingsRepository } from './autofix-findings-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

export type FindingSource = 'ci_failed' | 'review_finding' | 'session_failed';
export type FindingStatus = 'new' | 'triaged' | 'fixing' | 'pr_open' | 'resolved' | 'dismissed' | 'suppressed' | 'needs_human';

export const FINDING_STATUSES: readonly FindingStatus[] = ['new', 'triaged', 'fixing', 'pr_open', 'resolved', 'dismissed', 'suppressed', 'needs_human'];

export interface AutofixFinding {
  id: string;
  project_id: string;
  source: FindingSource;
  kind: string;
  fingerprint: string;
  severity: 'low' | 'medium' | 'high';
  evidence: string;
  status: FindingStatus;
  repo_id: string | null;
  branch: string | null;
  commit_sha: string | null;
  workflow_id: string | null;
  fix_branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  attempts: number;
  occurrences: number;
  cost_usd: number;
  cooldown_until: string | null;
  created_at: string;
  updated_at: string;
}

export type UpsertFindingInput = Pick<AutofixFinding, 'project_id' | 'source' | 'kind' | 'fingerprint' | 'severity' | 'evidence' | 'repo_id' | 'branch' | 'commit_sha'>;

export type FindingPatch = Partial<Omit<AutofixFinding, 'id' | 'project_id'>> & { status: FindingStatus };

export interface AutofixFindingsRepository {
  /** Create the finding, or, when the project already has one with this fingerprint, count another occurrence of it. */
  upsertByFingerprint(i: UpsertFindingInput): Promise<{ finding: AutofixFinding; created: boolean }>;
  getById(id: string): Promise<AutofixFinding | null>;
  getByFingerprint(projectId: string, fp: string): Promise<AutofixFinding | null>;
  getByFixBranch(projectId: string, branch: string): Promise<AutofixFinding | null>;
  getByWorkflowId(workflowId: string): Promise<AutofixFinding | null>;
  /** Newest first. */
  list(projectId: string, o: { status?: FindingStatus; limit: number }): Promise<AutofixFinding[]>;
  /**
   * Apply the patch only when the current status is one of `from`. Returns true when this call applied it, false when
   * the finding is missing or in another status (so of two concurrent callers exactly one wins). updated_at is set to
   * now unless the patch gives one.
   */
  transition(id: string, from: FindingStatus[], patch: FindingPatch): Promise<boolean>;
  /** Every status is present, with 0 when there are none. */
  countByStatus(projectId: string): Promise<Record<FindingStatus, number>>;
  /** Sum of cost_usd over the project's findings whose updated_at is at or after sinceIso. */
  sumCostSince(projectId: string, sinceIso: string): Promise<number>;
}

/** Fields a patch may set (everything except the key fields). */
export const PATCHABLE_FIELDS = [
  'source', 'kind', 'fingerprint', 'severity', 'evidence', 'status', 'repo_id', 'branch', 'commit_sha', 'workflow_id',
  'fix_branch', 'pr_number', 'pr_url', 'attempts', 'occurrences', 'cost_usd', 'cooldown_until', 'created_at', 'updated_at',
] as const;

let _instance: AutofixFindingsRepository | null = null;

export async function initAutofixFindingsRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbAutofixFindingsRepository } = await import('./autofix-findings-dynamodb.ts');
    _instance = new DynamoDbAutofixFindingsRepository();
  } else {
    _instance = new SqliteAutofixFindingsRepository();
  }
}

export function getAutofixFindingsRepository(): AutofixFindingsRepository {
  if (!_instance) _instance = new SqliteAutofixFindingsRepository();
  return _instance;
}

export function setAutofixFindingsRepository(repo: AutofixFindingsRepository): void { _instance = repo; }
export function clearAutofixFindingsRepository(): void { _instance = null; }
