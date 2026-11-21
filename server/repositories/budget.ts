/**
 * Repository interface for budget_usage.
 *
 * Covers: recording per-run budget usage.
 * Designed so that H1–H6 insights queries can be served without table scans.
 *
 * SQLite is the default backend.  DynamoDB is activated by USE_DYNAMODB=true.
 *
 * DynamoDB table used: portal-runs
 *
 * Key design:
 *
 *   Main item (one per insert):
 *     PK=BU#<projectId>#<dateUTC>   SK=<isoCreatedAt>#<id>   — budget_usage row
 *     GSI-BudgetProject: PK=budgetProjectId, SK=<isoCreatedAt>#<id>
 *     budgetProjectId = project_id when set
 *
 *   Rollup counters (written atomically alongside each insert):
 *     PK=STATS#<projectId>   SK=DAY#<date>    → ADD costUsd, inputTokens, outputTokens, runCount
 *     PK=USERSTATS#<userId>  SK=DAY#<date>    → ADD costUsd, inputTokens, outputTokens, runCount
 *     PK=STATS#GLOBAL        SK=DAY#<date>    → ADD costUsd, inputTokens, outputTokens, runCount
 *
 *   These rollup items allow H1–H6 to be served:
 *     H1 total cost/tokens in period: Query STATS#<projectId> SK between DAY#<start> and DAY#<end>
 *     H4 daily cost for 30 days:     same Query with up to 30 SK items
 *     H5 cost by project:             GetItems for each STATS#<projectId> for the date range
 *     H6 cost by user:                GetItems for each USERSTATS#<userId> for the date range
 *     H1 global:                      Query STATS#GLOBAL SK between dates
 *
 * The actual H1–H6 insights queries are in server/insights.ts and are the next step.
 * This repository owns the write path only; H1–H6 reads are added when insights.ts
 * is converted.
 */

import { SqliteBudgetRepository } from './budget-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Record types ───────────────────────────────────────────────────────────────

export interface BudgetRecord {
  id: string;
  user_id: string | null;
  project_id: string | null;
  workflow_id: string | null;
  run_id: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  provider: string;
  model: string;
  created_at: string;
}

// ── Input types ────────────────────────────────────────────────────────────────

export interface CreateBudgetInput {
  user_id: string | null;
  project_id: string | null;
  workflow_id: string | null;
  run_id: string | null;
  cost_usd: number;
  /** Kiro credits (Kiro bills in credits, not dollars). Optional; 0 when left out. */
  credits?: number;
  input_tokens: number;
  output_tokens: number;
  provider: string;
  model: string;
  created_at: string;
}

// ── Repository interface ───────────────────────────────────────────────────────

export interface BudgetRepository {
  /**
   * Record a budget usage entry.
   *
   * DynamoDB:
   *   1. PutItem the main budget_usage row.
   *   2. Fire-and-forget ADD operations on rollup items:
   *      - STATS#<projectId>    DAY#<date>   — project daily rollup
   *      - USERSTATS#<userId>   DAY#<date>   — user daily rollup (when userId set)
   *      - STATS#GLOBAL         DAY#<date>   — global daily rollup
   *   Background writes are registered via registerBackgroundWrite so Lambda
   *   waits for them before the response ends.
   *
   * Budget limits must never fail open: if this method throws, the caller
   * must block the run with a clear error.  For DynamoDB, a PutItem failure
   * (throttle / service unavailable) is retried once before throwing.
   */
  record(input: CreateBudgetInput): Promise<void>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: BudgetRepository | null = null;

export async function initBudgetRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbBudgetRepository } = await import('./budget-dynamodb.ts');
    _instance = new DynamoDbBudgetRepository();
  } else {
    _instance = new SqliteBudgetRepository();
  }
}

export function getBudgetRepository(): BudgetRepository {
  if (!_instance) _instance = new SqliteBudgetRepository();
  return _instance;
}

export function setBudgetRepository(repo: BudgetRepository): void { _instance = repo; }
export function clearBudgetRepository(): void { _instance = null; }
