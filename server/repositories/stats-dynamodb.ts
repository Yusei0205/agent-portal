/**
 * DynamoDB implementation of StatsRepository.
 *
 * Reads from rollup counters stored in portal-runs table:
 *
 *   RUNSTATS#<projectId|GLOBAL>   DAY#<date>
 *     → doneCount, failedCount, cancelledCount, totalDurationMs, durationCount
 *
 *   AGENTSTATS#<projectId|GLOBAL> DAY#<date>#AGENT#<name>
 *     → runs, doneCount, failedCount, cancelledCount, costUsd, inputTokens,
 *       outputTokens, totalDurationMs, durationCount
 *
 *   EDGESTATS#<projectId|GLOBAL>  DAY#<date>#<safeSource>#<safeTarget>
 *     → count  (written by sessions-dynamodb.ts createWorkflow)
 *
 *   STATS#<projectId>       DAY#<date>          (written by budget-dynamodb.ts)
 *     → costUsd, inputTokens, outputTokens, runCount
 *
 *   USERSTATS#<userId>      DAY#<date>          (written by budget-dynamodb.ts)
 *     → costUsd, inputTokens, outputTokens, runCount
 *
 *   STATS#GLOBAL            DAY#<date>          (written by budget-dynamodb.ts)
 *     → costUsd, inputTokens, outputTokens, runCount
 *
 * RUNSTATS and AGENTSTATS are written by SessionsRepository.finalizeRun() in
 * the same TransactWriteItems as the run status transition — so counts never
 * drift between the run record and the rollup (see sessions-dynamodb.ts).
 *
 * Approximations (documented in stats.ts header and plan doc section 9):
 *   - G8 edges: per-day EDGESTATS rollup written at child workflow creation.
 *     Agent name encoding: '#' → '_' (same as AGENTSTATS).
 *   - G11 provider: null (not stored on run record).
 *   - G7 p50/p95: null (no raw duration list available from rollups).
 *   - H5/H6 names: BatchGet from projects/users tables.
 *   - H6 project filter: ignored (USERSTATS keyed by userId only).
 */

import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBClient,
  BatchGetItemCommand,
  GetItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { getDynamoDbClient, marshalItem, getString, getNumber } from './dynamo-client.ts';
import { getSessionsRepository } from './sessions.ts';
import { getProjectRepository } from './projects.ts';
import { getAuthRepository } from './auth.ts';
import type {
  StatsRepository,
  InsightTotals,
  RunStatusCount,
  DailyCost,
  ProjectCost,
  UserCost,
  AgentRollup,
  AgentEdge,
  RecentSession,
  ActiveSessionData,
  ActiveSessionStep,
  AgentRunItem,
} from './stats.ts';

// ── Table name ────────────────────────────────────────────────────────────────

function runsTable(): string {
  return process.env.DYNAMODB_TABLE_PORTAL_RUNS ?? 'portal-runs-test';
}

// ── Pagination helper (mirrors sessions-dynamodb.ts private helper) ────────────

async function paginateQuery(
  client: DynamoDBClient,
  params: ConstructorParameters<typeof QueryCommand>[0],
  maxItems?: number,
): Promise<Array<Record<string, AttributeValue>>> {
  const items: Array<Record<string, AttributeValue>> = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  do {
    const res = await client.send(new QueryCommand({ ...params, ExclusiveStartKey: lastKey }));
    if (res.Items) items.push(...res.Items);
    lastKey = res.LastEvaluatedKey;
    if (maxItems != null && items.length >= maxItems) break;
  } while (lastKey);
  return items;
}

// ── Scope helpers ─────────────────────────────────────────────────────────────

/** Return the list of project IDs the caller can see. null = all (admin). */
async function resolveProjectIds(
  projectId: string | null,
  userId: string,
  isAdmin: boolean,
): Promise<string[] | null> {
  if (projectId) return [projectId];
  if (isAdmin) return null; // use STATS#GLOBAL or iterate all projects
  const projs = await getProjectRepository().listMyProjects(userId);
  return projs.map((p) => p.id);
}

/** Sum rollup items for a query across projectIds.  Returns merged totals. */
async function queryRollupRange(
  client: DynamoDBClient,
  pkPrefix: string,
  projectIds: string[] | null,
  startDate: string,
  endDate: string, // exclusive upper bound (next day after range)
): Promise<Array<Record<string, AttributeValue>>> {
  if (projectIds !== null && projectIds.length === 0) return [];

  const targets: string[] = projectIds ?? ['GLOBAL'];
  const all: Array<Record<string, AttributeValue>> = [];
  await Promise.all(
    targets.map(async (pid) => {
      const items = await paginateQuery(client, {
        TableName: runsTable(),
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :start AND :end',
        ExpressionAttributeValues: {
          ':pk': { S: `${pkPrefix}${pid}` },
          ':start': { S: `DAY#${startDate}` },
          ':end': { S: `DAY#${endDate}` },
        },
      });
      all.push(...items);
    }),
  );
  return all;
}

// ── Agent name normalizer ─────────────────────────────────────────────────────

function agentName(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  return s || 'default';
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Return all ISO date strings (YYYY-MM-DD) in [since, until) (inclusive since, exclusive until). */
function dateBetween(since: string, until: string): string[] {
  const dates: string[] = [];
  let cur = new Date(since);
  const end = new Date(until);
  while (cur < end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 86_400_000);
  }
  // Cap at 60 days to avoid unbounded queries
  return dates.slice(0, 60);
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class DynamoDbStatsRepository implements StatsRepository {
  private readonly client: DynamoDBClient;

  constructor() {
    this.client = getDynamoDbClient();
  }

  // ── H1: total cost + tokens ─────────────────────────────────────────────────

  async getInsightTotals(
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<InsightTotals> {
    const projectIds = await resolveProjectIds(projectId, userId, isAdmin);
    const startDate = since.slice(0, 10);
    const endDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    let totalCost = 0;
    let totalTokens = 0;

    if (projectIds === null) {
      // Admin global: sum STATS#GLOBAL rollup
      const items = await paginateQuery(this.client, {
        TableName: runsTable(),
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :start AND :end',
        ExpressionAttributeValues: {
          ':pk': { S: 'STATS#GLOBAL' },
          ':start': { S: `DAY#${startDate}` },
          ':end': { S: `DAY#${endDate}` },
        },
      });
      for (const item of items) {
        totalCost += getNumber(item, 'costUsd');
        totalTokens += getNumber(item, 'inputTokens') + getNumber(item, 'outputTokens');
      }
    } else {
      // Specific projects: sum STATS#<projectId>
      const items = await queryRollupRange(this.client, 'STATS#', projectIds, startDate, endDate);
      for (const item of items) {
        totalCost += getNumber(item, 'costUsd');
        totalTokens += getNumber(item, 'inputTokens') + getNumber(item, 'outputTokens');
      }
    }

    return { totalCost, totalTokens };
  }

  // ── H2: run counts by status ────────────────────────────────────────────────

  async getRunStatusCounts(
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<RunStatusCount[]> {
    const projectIds = await resolveProjectIds(projectId, userId, isAdmin);
    const startDate = since.slice(0, 10);
    const endDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const effectiveIds = projectIds ?? ['GLOBAL'];
    const items = await queryRollupRange(
      this.client, 'RUNSTATS#', effectiveIds.length > 0 ? effectiveIds : ['GLOBAL'],
      startDate, endDate,
    );

    let doneCount = 0, failedCount = 0, cancelledCount = 0;
    for (const item of items) {
      doneCount += getNumber(item, 'doneCount');
      failedCount += getNumber(item, 'failedCount');
      cancelledCount += getNumber(item, 'cancelledCount');
    }

    const counts: RunStatusCount[] = [];
    if (doneCount > 0) counts.push({ status: 'done', count: doneCount });
    if (failedCount > 0) counts.push({ status: 'failed', count: failedCount });
    if (cancelledCount > 0) counts.push({ status: 'cancelled', count: cancelledCount });
    return counts;
  }

  // ── H3: average run duration ────────────────────────────────────────────────

  async getAvgRunDuration(
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<number> {
    const projectIds = await resolveProjectIds(projectId, userId, isAdmin);
    const startDate = since.slice(0, 10);
    const endDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const effectiveIds = projectIds ?? ['GLOBAL'];
    const items = await queryRollupRange(
      this.client, 'RUNSTATS#', effectiveIds, startDate, endDate,
    );

    let totalMs = 0, cnt = 0;
    for (const item of items) {
      totalMs += getNumber(item, 'totalDurationMs');
      cnt += getNumber(item, 'durationCount');
    }
    return cnt > 0 ? Math.round(totalMs / cnt) : 0;
  }

  // ── H4: daily budget ────────────────────────────────────────────────────────

  async getDailyBudget(
    dates: string[],
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<DailyCost[]> {
    if (dates.length === 0) return [];
    const projectIds = await resolveProjectIds(projectId, userId, isAdmin);

    // Build BatchGetItem keys for each date
    const pkPrefix = projectIds === null ? 'STATS#GLOBAL' : undefined;

    // If no specific project, use STATS#GLOBAL; otherwise sum per-project per-day
    const dailyMap = new Map<string, number>();

    if (pkPrefix) {
      // Admin: read from STATS#GLOBAL for each date
      const keys = dates.map((d) => marshalItem({ PK: pkPrefix, SK: `DAY#${d}` }));
      const items = await batchGetItems(this.client, keys);
      for (const item of items) {
        const sk = getString(item, 'SK') ?? '';
        const date = sk.replace('DAY#', '');
        if (date) dailyMap.set(date, (dailyMap.get(date) ?? 0) + getNumber(item, 'costUsd'));
      }
    } else if (projectIds && projectIds.length > 0) {
      // Batch-get per project per date
      const allKeys: Array<Record<string, AttributeValue>> = [];
      for (const pid of projectIds) {
        for (const d of dates) {
          allKeys.push(marshalItem({ PK: `STATS#${pid}`, SK: `DAY#${d}` }));
        }
      }
      const items = await batchGetItems(this.client, allKeys);
      for (const item of items) {
        const sk = getString(item, 'SK') ?? '';
        const date = sk.replace('DAY#', '');
        if (date) dailyMap.set(date, (dailyMap.get(date) ?? 0) + getNumber(item, 'costUsd'));
      }
    }

    return dates.map((date) => ({ date, cost: dailyMap.get(date) ?? 0 }));
  }

  // ── H5: cost by project ─────────────────────────────────────────────────────

  async getCostByProject(
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<ProjectCost[]> {
    const projectIds = await resolveProjectIds(projectId, userId, isAdmin);
    const startDate = since.slice(0, 10);
    const endDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    let targetIds: string[];
    if (projectIds === null) {
      // Admin: need all project IDs
      const projs = await getProjectRepository().listProjects();
      targetIds = projs.map((p) => p.id);
    } else {
      targetIds = projectIds;
    }

    if (targetIds.length === 0) return [];

    const costMap = new Map<string, number>();
    const items = await queryRollupRange(this.client, 'STATS#', targetIds, startDate, endDate);
    for (const item of items) {
      const pk = getString(item, 'PK') ?? '';
      const pid = pk.replace('STATS#', '');
      if (pid) costMap.set(pid, (costMap.get(pid) ?? 0) + getNumber(item, 'costUsd'));
    }

    // BatchGet project names
    const projsWithCost = [...costMap.entries()].filter(([, c]) => c > 0);
    const nameMap = new Map<string, string>();
    const projKeys = projsWithCost.map(([pid]) => marshalItem({ PK: `PROJECT#${pid}`, SK: '#META' }));
    try {
      const projItems = await batchGetItemsTable(
        this.client,
        projKeys,
        process.env.DYNAMODB_TABLE_PORTAL_PROJECTS ?? 'portal-projects-test',
      );
      for (const item of projItems) {
        const pk = getString(item, 'PK') ?? '';
        const pid = pk.replace('PROJECT#', '');
        nameMap.set(pid, getString(item, 'name') ?? pid);
      }
    } catch {
      // Portal-projects table may not exist in test environments
    }

    return projsWithCost
      .map(([pid, cost]) => ({ projectId: pid, name: nameMap.get(pid) ?? pid, cost }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 20);
  }

  // ── H6: cost by user ────────────────────────────────────────────────────────

  async getCostByUser(
    since: string,
    projectId: string | null,
    _userId: string,
    isAdmin: boolean,
  ): Promise<UserCost[]> {
    if (!isAdmin) return [];
    void projectId; // project-scoped cost-by-user is approximate in DynamoDB — see design doc

    const startDate = since.slice(0, 10);
    const endDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    // Get all user IDs from auth repository
    const users = await getAuthRepository().listUsersWithLastActive();
    if (users.length === 0) return [];

    const costMap = new Map<string, number>();
    const userItems = await queryRollupRange(
      this.client,
      'USERSTATS#',
      users.map((u) => u.id),
      startDate,
      endDate,
    );
    for (const item of userItems) {
      const pk = getString(item, 'PK') ?? '';
      const uid = pk.replace('USERSTATS#', '');
      if (uid) costMap.set(uid, (costMap.get(uid) ?? 0) + getNumber(item, 'costUsd'));
    }

    const usersWithCost = users
      .filter((u) => (costMap.get(u.id) ?? 0) > 0)
      .map((u) => ({ userId: u.id, name: u.name ?? u.email, cost: costMap.get(u.id) ?? 0 }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 50);

    return usersWithCost;
  }

  // ── G1: count distinct agents ───────────────────────────────────────────────

  async countDistinctAgents(
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<number> {
    const agentRollups = await this.getAgentRollups(
      since,
      new Date(Date.now() + 86_400_000).toISOString(),
      projectId,
      userId,
      isAdmin,
    );
    return agentRollups.length;
  }

  // ── G (active agents) ───────────────────────────────────────────────────────

  async countActiveAgents(
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<number> {
    const running = await getSessionsRepository().listRunningWorkflows();
    const scope = await resolveProjectIds(projectId, userId, isAdmin);
    const inScope = scope === null ? running : running.filter((w) => w.project_id && scope.includes(w.project_id));
    const agents = new Set(inScope.map((w) => agentName(w.lead_agent)));
    return agents.size;
  }

  async listRunningAgentNames(
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<Set<string>> {
    const running = await getSessionsRepository().listRunningWorkflows();
    const scope = await resolveProjectIds(projectId, userId, isAdmin);
    const inScope = scope === null ? running : running.filter((w) => w.project_id && scope.includes(w.project_id));
    return new Set(inScope.map((w) => agentName(w.lead_agent)));
  }

  // ── G2/G3: workflow counts by status ────────────────────────────────────────

  async countWorkflowsByStatus(
    status: 'running' | 'pending',
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<number> {
    const scope = await resolveProjectIds(projectId, userId, isAdmin);
    let workflows;
    if (status === 'running') {
      workflows = await getSessionsRepository().listRunningWorkflows();
    } else {
      workflows = await getSessionsRepository().listPendingWorkflows();
    }
    if (scope === null) return workflows.length;
    return workflows.filter((w) => w.project_id && scope.includes(w.project_id)).length;
  }

  // ── G4: completed today/yesterday ───────────────────────────────────────────

  async getCompletedCounts(
    today: string,
    yesterday: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<{ today: number; yesterday: number }> {
    const projectIds = await resolveProjectIds(projectId, userId, isAdmin);
    const effectiveIds = projectIds ?? ['GLOBAL'];
    // RUNSTATS# holds doneCount; STATS# is cost-only budget data — always use RUNSTATS#.
    const pkPrefix = 'RUNSTATS#';

    const dateToday = today.slice(0, 10);
    const dateYesterday = yesterday.slice(0, 10);

    const allKeys: Array<Record<string, AttributeValue>> = [];
    for (const pid of effectiveIds) {
      allKeys.push(marshalItem({ PK: `${pkPrefix}${pid}`, SK: `DAY#${dateToday}` }));
      allKeys.push(marshalItem({ PK: `${pkPrefix}${pid}`, SK: `DAY#${dateYesterday}` }));
    }

    const items = await batchGetItems(this.client, allKeys);
    let todayCount = 0, yesterdayCount = 0;
    for (const item of items) {
      const sk = getString(item, 'SK') ?? '';
      const date = sk.replace('DAY#', '');
      const done = getNumber(item, 'doneCount');
      if (date === dateToday) todayCount += done;
      if (date === dateYesterday) yesterdayCount += done;
    }

    return { today: todayCount, yesterday: yesterdayCount };
  }

  // ── G5/G6: success rate counts ──────────────────────────────────────────────

  async getSuccessRateCounts(
    since: string,
    until: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<{ done: number; finished: number }> {
    const projectIds = await resolveProjectIds(projectId, userId, isAdmin);
    const startDate = since.slice(0, 10);
    const endDate = until.slice(0, 10);
    const effectiveIds = projectIds ?? ['GLOBAL'];

    const items = await queryRollupRange(this.client, 'RUNSTATS#', effectiveIds, startDate, endDate);
    let done = 0, finished = 0;
    for (const item of items) {
      const d = getNumber(item, 'doneCount');
      const f = getNumber(item, 'failedCount') + getNumber(item, 'cancelledCount');
      done += d;
      finished += d + f;
    }
    return { done, finished };
  }

  // ── G7: per-agent rollups ────────────────────────────────────────────────────

  async getAgentRollups(
    since: string,
    until: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<AgentRollup[]> {
    const projectIds = await resolveProjectIds(projectId, userId, isAdmin);
    const startDate = since.slice(0, 10);
    const endDate = until.slice(0, 10);

    // Admin (null projectIds) → query AGENTSTATS#GLOBAL (written atomically by finalizeRun).
    // Per-project → query each project's AGENTSTATS bucket.
    const effectiveIds = projectIds ?? ['GLOBAL'];
    if (effectiveIds.length === 0) return [];

    // Fetch all AGENTSTATS items for the date range across projects.
    // SK format: DAY#<date>#AGENT#<name> — bounded by BETWEEN to avoid full-partition scans.
    const allItems: Array<Record<string, AttributeValue>> = [];
    await Promise.all(
      effectiveIds.map(async (pid) => {
        const items = await paginateQuery(this.client, {
          TableName: runsTable(),
          KeyConditionExpression: 'PK = :pk AND SK BETWEEN :start AND :end',
          ExpressionAttributeValues: {
            ':pk': { S: `AGENTSTATS#${pid}` },
            ':start': { S: `DAY#${startDate}` },
            // endDate is the exclusive upper bound; all actual SKs for that date
            // are 'DAY#${endDate}#AGENT#...' which are lexicographically GREATER
            // than 'DAY#${endDate}', so the BETWEEN stops before them.
            ':end': { S: `DAY#${endDate}` },
          },
        });
        allItems.push(...items);
      }),
    );

    // Aggregate by agent name
    const agentMap = new Map<string, {
      runs: number; doneCount: number; failedCount: number; cancelledCount: number;
      costUsd: number; inputTokens: number; outputTokens: number;
      totalDurationMs: number; durationCount: number;
      lastRunAt: string | null;
    }>();

    for (const item of allItems) {
      const sk = getString(item, 'SK') ?? '';
      // Extract agent name from new SK format: DAY#<date>#AGENT#<name>
      const parts = sk.match(/^DAY#\d{4}-\d{2}-\d{2}#AGENT#(.+)$/);
      if (!parts) continue;
      const agent = parts[1];

      if (!agentMap.has(agent)) {
        agentMap.set(agent, { runs: 0, doneCount: 0, failedCount: 0, cancelledCount: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, totalDurationMs: 0, durationCount: 0, lastRunAt: null });
      }
      const agg = agentMap.get(agent)!;
      agg.runs += getNumber(item, 'runs');
      agg.doneCount += getNumber(item, 'doneCount');
      agg.failedCount += getNumber(item, 'failedCount');
      agg.cancelledCount += getNumber(item, 'cancelledCount');
      agg.costUsd += getNumber(item, 'costUsd');
      agg.inputTokens += getNumber(item, 'inputTokens');
      agg.outputTokens += getNumber(item, 'outputTokens');
      agg.totalDurationMs += getNumber(item, 'totalDurationMs');
      agg.durationCount += getNumber(item, 'durationCount');
      const lr = getString(item, 'lastRunAt');
      if (lr && (!agg.lastRunAt || lr > agg.lastRunAt)) agg.lastRunAt = lr;
    }

    return [...agentMap.entries()].map(([agent, agg]) => {
      const finished = agg.doneCount + agg.failedCount + agg.cancelledCount;
      return {
        agent,
        runs: agg.runs,
        doneCount: agg.doneCount,
        failedCount: agg.failedCount,
        cancelledCount: agg.cancelledCount,
        successRate: finished > 0 ? agg.doneCount / finished : 0,
        totalDurationMs: agg.totalDurationMs,
        durationCount: agg.durationCount,
        // p50/p95 not available from rollups — set to null (documented approximation)
        p50DurationMs: null,
        p95DurationMs: null,
        costUsd: agg.costUsd,
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        // toolCalls/toolErrors not in rollups — 0 in DynamoDB mode (documented approximation)
        toolCalls: 0,
        toolErrors: 0,
        lastRunAt: agg.lastRunAt,
      };
    }).sort((a, b) => b.runs - a.runs);
  }

  // ── G8: agent edges ─────────────────────────────────────────────────────────

  async getAgentEdges(
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<AgentEdge[]> {
    const projectIds = await resolveProjectIds(projectId, userId, isAdmin);
    const startDate = since.slice(0, 10);
    const endDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    // For project scope, query EDGESTATS#<projectId>; for admin, query EDGESTATS#GLOBAL.
    // This gives an exact per-day rollup bounded by the period, written by createWorkflow.
    const targets = projectIds === null ? ['GLOBAL'] : projectIds;
    if (targets.length === 0) return [];

    const edgeMap = new Map<string, number>();
    await Promise.all(
      targets.map(async (pid) => {
        const items = await paginateQuery(this.client, {
          TableName: runsTable(),
          KeyConditionExpression: 'PK = :pk AND SK BETWEEN :start AND :end',
          ExpressionAttributeValues: {
            ':pk': { S: `EDGESTATS#${pid}` },
            ':start': { S: `DAY#${startDate}` },
            ':end': { S: `DAY#${endDate}` },
          },
        });
        for (const item of items) {
          const sk = getString(item, 'SK') ?? '';
          // SK format: DAY#<date>#<safeSource>#<safeTarget>
          const m = sk.match(/^DAY#\d{4}-\d{2}-\d{2}#([^#]+)#([^#]+)$/);
          if (!m) continue;
          const key = `${m[1]}→${m[2]}`;
          edgeMap.set(key, (edgeMap.get(key) ?? 0) + getNumber(item, 'count'));
        }
      }),
    );

    return [...edgeMap.entries()].map(([key, count]) => {
      const arrow = key.indexOf('→');
      const source = key.slice(0, arrow);
      const target = key.slice(arrow + 1);
      return { source, target, count };
    });
  }

  // ── G9: recent sessions ─────────────────────────────────────────────────────

  async getRecentSessions(
    limit: number,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<RecentSession[]> {
    const projectIds = await resolveProjectIds(projectId, userId, isAdmin);
    const repo = getSessionsRepository();

    const allWorkflows = [];
    if (projectIds === null) {
      // Admin with no project filter: query all accessible projects
      const projs = await getProjectRepository().listProjects();
      for (const p of projs) {
        const { workflows } = await repo.listWorkflowsByProject(p.id, { limit });
        allWorkflows.push(...workflows);
      }
    } else {
      for (const pid of projectIds) {
        const { workflows } = await repo.listWorkflowsByProject(pid, { limit });
        allWorkflows.push(...workflows);
      }
    }

    // Sort by updated_at and take top `limit`
    allWorkflows.sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
    const recent = allWorkflows.slice(0, limit);

    // Fetch project names (best-effort; fall back to project ID on error)
    const projectNameMap = new Map<string, string>();
    const uniquePids = [...new Set(recent.map((w) => w.project_id).filter(Boolean) as string[])];
    if (uniquePids.length > 0) {
      try {
        const projKeys = uniquePids.map((pid) =>
          marshalItem({ PK: `PROJECT#${pid}`, SK: '#META' }),
        );
        const projItems = await batchGetItemsTable(
          this.client,
          projKeys,
          process.env.DYNAMODB_TABLE_PORTAL_PROJECTS ?? 'portal-projects-test',
        );
        for (const item of projItems) {
          const pk = getString(item, 'PK') ?? '';
          const pid = pk.replace('PROJECT#', '');
          projectNameMap.set(pid, getString(item, 'name') ?? pid);
        }
      } catch {
        // Portal-projects table may not exist in test environments — use IDs as names
      }
    }

    // Fetch child agents for each recent session
    return await Promise.all(
      recent.map(async (w) => {
        const children = await repo.listChildWorkflows(w.id);
        const childAgents = [...new Set(children.map((c) => agentName(c.lead_agent)))];
        return {
          id: w.id,
          projectId: w.project_id ?? '',
          projectName: w.project_id ? (projectNameMap.get(w.project_id) ?? '') : '',
          title: w.title || w.goal.slice(0, 100),
          agent: agentName(w.lead_agent),
          status: w.status,
          childAgents,
          updatedAt: w.updated_at,
        };
      }),
    );
  }

  // ── G10: active session ─────────────────────────────────────────────────────

  async getActiveSession(
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<ActiveSessionData | null> {
    const scope = await resolveProjectIds(projectId, userId, isAdmin);
    const repo = getSessionsRepository();

    const running = await repo.listRunningWorkflows();
    const inScope = scope === null
      ? running
      : running.filter((w) => w.project_id && scope.includes(w.project_id));
    if (inScope.length === 0) return null;

    inScope.sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
    const wf = inScope[0];
    const parentAgent = agentName(wf.lead_agent);

    const [ownRuns, children] = await Promise.all([
      repo.listRunsByWorkflow(wf.id),
      repo.listChildWorkflows(wf.id),
    ]);

    const steps: ActiveSessionStep[] = [];
    let runIdx = 0;
    for (const r of ownRuns.slice().reverse()) {
      runIdx++;
      steps.push({
        id: r.id,
        label: `Run #${runIdx}`,
        agent: parentAgent,
        kind: 'run',
        status: r.status,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
      });
    }
    for (const c of children) {
      const terminalStatuses = ['done', 'failed', 'paused', 'blocked'];
      steps.push({
        id: c.id,
        label: c.title || c.goal.slice(0, 80),
        agent: agentName(c.lead_agent),
        kind: 'child',
        status: c.status,
        startedAt: c.created_at,
        finishedAt: terminalStatuses.includes(c.status) ? c.updated_at : null,
      });
    }
    steps.sort((a, b) => {
      if (!a.startedAt) return 1;
      if (!b.startedAt) return -1;
      return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;
    });

    return {
      id: wf.id,
      projectId: wf.project_id ?? '',
      title: wf.title || wf.goal.slice(0, 100),
      agent: parentAgent,
      status: wf.status,
      steps,
    };
  }

  // ── G11: agent run list ─────────────────────────────────────────────────────

  async getAgentRunList(
    agentParam: string,
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<AgentRunItem[]> {
    const projectIds = await resolveProjectIds(projectId, userId, isAdmin);
    const repo = getSessionsRepository();

    const allWorkflows = [];
    if (projectIds === null) {
      const projs = await getProjectRepository().listProjects();
      for (const p of projs) {
        const { workflows } = await repo.listWorkflowsByProject(p.id, { limit: 200 });
        allWorkflows.push(...workflows);
      }
    } else {
      for (const pid of projectIds) {
        const { workflows } = await repo.listWorkflowsByProject(pid, { limit: 200 });
        allWorkflows.push(...workflows);
      }
    }

    // Filter to the target agent
    const agentWorkflows = allWorkflows.filter((w) =>
      agentName(w.lead_agent) === agentParam,
    );

    // Fetch runs for each workflow
    const runItems: AgentRunItem[] = [];
    for (const wf of agentWorkflows) {
      const runs = await repo.listRunsByWorkflow(wf.id, 20);
      for (const r of runs) {
        if (r.created_at < since) continue;
        const startedAt = r.started_at ? Date.parse(r.started_at) : null;
        const finishedAt = r.finished_at ? Date.parse(r.finished_at) : null;
        const durationMs =
          startedAt != null && finishedAt != null ? finishedAt - startedAt : null;
        runItems.push({
          id: r.id,
          workflowId: wf.id,
          projectId: wf.project_id ?? '',
          title: wf.title || wf.goal.slice(0, 100),
          status: r.status,
          model: r.model,
          provider: null, // documented approximation — not stored on run record
          durationMs,
          costUsd: r.cost_usd,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          toolCalls: 0, // not stored on run record in DynamoDB mode
          error: r.error,
          createdAt: r.created_at,
        });
      }
    }

    runItems.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
    return runItems.slice(0, 50);
  }
}

// ── BatchGet helpers ──────────────────────────────────────────────────────────

/** BatchGetItem in chunks of 100. Returns all retrieved items. */
async function batchGetItems(
  client: DynamoDBClient,
  keys: Array<Record<string, AttributeValue>>,
): Promise<Array<Record<string, AttributeValue>>> {
  return batchGetItemsTable(client, keys, runsTable());
}

async function batchGetItemsTable(
  client: DynamoDBClient,
  keys: Array<Record<string, AttributeValue>>,
  tableName: string,
): Promise<Array<Record<string, AttributeValue>>> {
  if (keys.length === 0) return [];
  const results: Array<Record<string, AttributeValue>> = [];
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    let req: Record<string, AttributeValue>[] = batch;
    while (req.length > 0) {
      const res = await client.send(new BatchGetItemCommand({
        RequestItems: { [tableName]: { Keys: req } },
      }));
      const items = res.Responses?.[tableName] ?? [];
      results.push(...items);
      const unprocessed = res.UnprocessedKeys?.[tableName]?.Keys ?? [];
      req = unprocessed;
    }
  }
  return results;
}
