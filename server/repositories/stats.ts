/**
 * Stats repository — reads aggregated rollup counters for dashboard (G1–G11)
 * and insights (H1–H6) queries.
 *
 * WHY a separate repository:
 *   Budget owns cost/token rollup writes (STATS#* items).
 *   Sessions owns workflow/run state transition writes.
 *   Dashboard and insights span BOTH cost data and run status/duration data
 *   across multiple projects.  A stats repository aggregates these reads into a
 *   clean interface so dashboard.ts and insights.ts contain no SQL.
 *   The run-terminal stats rollups (RUNSTATS#*, AGENTSTATS#*) are written via
 *   SessionsRepository.finalizeRun(), which bundles them atomically with the
 *   conditional run status transition (single TransactWriteItems in DynamoDB).
 *
 * H2/H3 source decision:
 *   Current insights.ts reads `agent_runs` (legacy M3 table) for H2 run-counts
 *   and H3 duration.  SQLite mode keeps this behaviour (backward-compatible).
 *   DynamoDB mode reads the new RUNSTATS rollup items, which are written from
 *   p6_runs terminal transitions only.  On a fully-P6 portal (no legacy runs)
 *   the two modes agree; on a mixed portal SQLite numbers will differ.  This
 *   difference is documented and expected to disappear as legacy runs age out.
 *
 * Approximations in DynamoDB mode (documented per task requirement):
 *   - G8 agent edges: in-memory from workflow items fetched from the sessions
 *     repository.  Bounded by GSI-ProjectWorkflows pagination (≤200 per query).
 *   - G11 provider field: null in DynamoDB mode (budget lookup per run is too
 *     expensive; provider is not stored on the run record).
 *   - H5/H6 project/user names: require BatchGet from projects/users tables
 *     (O(projects) + O(users) reads per insights call).
 *   - For admin "all projects" rollup reads (H1-H6, G1-G7) the implementation
 *     queries each project's rollup items, bounded by the number of projects.
 */

import { SqliteStatsRepository } from './stats-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InsightTotals {
  totalCredits: number;
  totalCost: number;
  totalTokens: number;
}

export interface RunStatusCount {
  status: string;
  count: number;
}

export interface DailyCost {
  date: string;
  cost: number;
}

export interface ProjectCost {
  projectId: string;
  name: string;
  cost: number;
}

export interface UserCost {
  userId: string;
  name: string;
  cost: number;
}

export interface AgentRollup {
  agent: string;
  runs: number;
  doneCount: number;
  failedCount: number;
  cancelledCount: number;
  successRate: number;
  totalDurationMs: number;
  durationCount: number;
  /** Median duration in ms; null in DynamoDB mode (raw list not available). */
  p50DurationMs: number | null;
  /** 95th percentile duration in ms; null in DynamoDB mode. */
  p95DurationMs: number | null;
  costUsd: number;
  /** Kiro credits (Kiro bills in credits, not dollars). */
  credits: number;
  inputTokens: number;
  outputTokens: number;
  /** Count of tool-start events; 0 in DynamoDB mode (not in rollups). */
  toolCalls: number;
  /** Count of tool-blocked events; 0 in DynamoDB mode (not in rollups). */
  toolErrors: number;
  lastRunAt: string | null;
}

export interface AgentEdge {
  source: string;
  target: string;
  count: number;
}

export interface RecentSession {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  agent: string;
  status: string;
  childAgents: string[];
  updatedAt: string;
}

export interface ActiveSessionStep {
  id: string;
  label: string;
  agent: string;
  kind: 'run' | 'child';
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ActiveSessionData {
  id: string;
  projectId: string;
  title: string;
  agent: string;
  status: string;
  steps: ActiveSessionStep[];
}

export interface AgentRunItem {
  id: string;
  workflowId: string;
  projectId: string;
  title: string;
  status: string;
  model: string | null;
  provider: string | null;
  durationMs: number | null;
  costUsd: number;
  /** Kiro credits (Kiro bills in credits, not dollars). */
  credits: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  error: string | null;
  createdAt: string;
}

// ── Repository interface ───────────────────────────────────────────────────────

export interface StatsRepository {
  // ── Insights H1–H6 ────────────────────────────────────────────────────────

  /** H1: Total cost + total tokens in period. */
  getInsightTotals(
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<InsightTotals>;

  /**
   * H2: Run counts by status.
   * SQLite: from agent_runs; DynamoDB: from RUNSTATS rollups (p6_runs).
   */
  getRunStatusCounts(
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<RunStatusCount[]>;

  /**
   * H3: Average run duration in ms.
   * SQLite: from agent_runs; DynamoDB: from RUNSTATS rollups.
   */
  getAvgRunDuration(
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<number>;

  /** H4: Daily cost for each given date (ISO date strings, last 30 days). */
  getDailyBudget(
    dates: string[],
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<DailyCost[]>;

  /** H5: Cost per project, sorted desc, limit 20. */
  getCostByProject(
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<ProjectCost[]>;

  /** H6: Cost per user (admin only), sorted desc, limit 50. */
  getCostByUser(
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<UserCost[]>;

  // ── Dashboard G1–G11 ──────────────────────────────────────────────────────

  /** G1: Count distinct agents with ≥1 terminal run in period. */
  countDistinctAgents(
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<number>;

  /** G (active agents): count distinct agents with a currently running run. */
  countActiveAgents(
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<number>;

  /** G (active agent names): set of agent names with a currently running run. Used for network node running flag. */
  listRunningAgentNames(
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<Set<string>>;

  /** G2/G3: Count workflows with the given status in scope (running or pending). */
  countWorkflowsByStatus(
    status: 'running' | 'pending',
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<number>;

  /** G4: Count terminal runs completed today and yesterday. */
  getCompletedCounts(
    today: string,
    yesterday: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<{ today: number; yesterday: number }>;

  /** G5/G6: Done + finished counts for success-rate computation over a period. */
  getSuccessRateCounts(
    since: string,
    until: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<{ done: number; finished: number }>;

  /** G7: Per-agent aggregate stats in period. */
  getAgentRollups(
    since: string,
    until: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<AgentRollup[]>;

  /** G8: Agent-to-agent edge counts (parent→child) in period. */
  getAgentEdges(
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<AgentEdge[]>;

  /** G9: Recent sessions (newest updated_at first), limit 10. */
  getRecentSessions(
    limit: number,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<RecentSession[]>;

  /** G10: Most recently updated running session in scope. */
  getActiveSession(
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<ActiveSessionData | null>;

  /** G11: Per-agent run list with cost/tokens/error, limit 50. */
  getAgentRunList(
    agent: string,
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<AgentRunItem[]>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: StatsRepository | null = null;

export async function initStatsRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbStatsRepository } = await import('./stats-dynamodb.ts');
    _instance = new DynamoDbStatsRepository();
  } else {
    _instance = new SqliteStatsRepository();
  }
}

export function getStatsRepository(): StatsRepository {
  if (!_instance) _instance = new SqliteStatsRepository();
  return _instance;
}

export function setStatsRepository(repo: StatsRepository): void { _instance = repo; }
export function clearStatsRepository(): void { _instance = null; }
