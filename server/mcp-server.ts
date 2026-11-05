/**
 * Portal MCP server factory (F11).
 *
 * Creates a stateless McpServer whose tool set is filtered to the caller's
 * token scopes.  A new instance is created per request so no state leaks
 * between callers (avoids CVE-2026-25536).
 *
 * Tools:
 *   read     — list_sessions, get_transcript, list_reviews, get_review, get_review_usage,
 *              list_test_projects, list_test_scripts, get_test_run
 *   write    — start_session, prompt_session, stop_session, delegate_session
 *   review   — start_review, wait_for_review, post_review_comments,
 *              start_scan, confirm_scan, resume_scan
 *   merge    — merge_pull_request
 *   tests    — start_test_run, cancel_test_run, generate_test_script
 *   delegate — (internal) delegate_session only; bound to a parent workflow;
 *              REST routes blocked; not user-creatable
 */

import { getSessionsRepository } from './repositories/sessions.ts';
import { getReviewsRepository } from './repositories/reviews.ts';
import { getScansRepository } from './repositories/scans.ts';
import { getGitConnectionsRepository } from './repositories/git-connections.ts';
import { testingRepo } from './testing/data.ts';
import { runInBackground } from './background-jobs.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from './db.ts';
import type { Row } from './db.ts';
import type { PortalUser } from './http.ts';
import { generateId, now, newId, sleep } from './util.ts';
import { appendAudit } from './audit.ts';
import { startRun } from './workflows/driver.ts';
import { cancelRun } from './workflows/controls.ts';
import { getRateCard, computeCost, computeMergeVerdict, _providers } from './review.ts';
import type { Review, Finding } from './review.ts';
import { emit } from './events.ts';
import { decrypt } from './secrets.ts';
import { config } from './config.ts';
import { createChildSession } from './delegation.ts';
import { getDelegationSettingsRepository } from './repositories/delegation-settings.ts';
import { getSetting } from './settings.ts';
import { _runningCount, _cancelledRuns } from './testing/runner.ts';
import type { TestProject, TestScript } from './testing/helpers.ts';

import { getMemberRow, getProjectRow, getRepoInfo } from './project-access.ts';
// ── Access helpers ─────────────────────────────────────────────────────────────

/** Returns the project row if the user is admin or a member, else throws. */
async function assertProjectAccess(userId: string, isAdmin: boolean, projectId: string): Promise<Row> {
  // S1-TODO(projects): assertProjectAccess is a sync helper used by many MCP tool handlers.
  // The MCP server dispatches tools synchronously inside its request handler.
  // Converting this to async would require restructuring the entire MCP dispatch loop.
  // Leave on direct SQLite until the mcp-server module gets its own async conversion pass.
  const project = await getProjectRow(projectId);
  if (!project) throw new Error('Project not found');
  if (isAdmin) return project;
  const m = await getMemberRow(projectId, userId);
  if (!m) throw new Error('Project not found');
  return project;
}

/** Returns the workflow row if it belongs to the project, else throws. */
async function assertWorkflow(projectId: string, workflowId: string): Promise<Row> {
  const w = await getSessionsRepository().getWorkflowByProjectId(projectId, workflowId);
  if (!w) throw new Error('Session not found');
  return w as unknown as Row;
}

/** Returns the review row if it belongs to the project, else throws. */
async function assertReview(projectId: string, reviewId: string): Promise<Row> {
  const r = await getReviewsRepository().getById(reviewId);
  if (!r || r.project_id !== projectId) throw new Error('Review not found');
  return r as unknown as Row;
}

/** Returns the scan row if it belongs to the project, else throws. */
async function assertScan(projectId: string, scanId: string): Promise<Row> {
  const s = await getScansRepository().getByIdForProject(scanId, projectId);
  if (!s) throw new Error('Scan not found');
  return s as unknown as Row;
}

// ── Credential helpers (duplicated from review.ts which does not export them) ─

async function findGitHubTokenForUser(userId: string): Promise<string | null> {
  const conns = await getGitConnectionsRepository().listByProviderForUser('github', userId);
  for (const c of conns) {
    if (!c.credentials_enc) continue;
    try {
      const plain = decrypt(c.credentials_enc, config.secretKey);
      const creds = JSON.parse(plain) as Record<string, unknown>;
      if (typeof creds.token === 'string' && creds.token) return creds.token;
    } catch { /* skip */ }
  }
  return null;
}

function parseGHOwnerRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:[/?#]|$)/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// ── Audit helper ───────────────────────────────────────────────────────────────

function audit(userId: string, tool: string, target: string, detail: Record<string, unknown>): void {
  try {
    appendAudit(getDb(), userId, `mcp.tool.${tool}`, target, detail, null);
  } catch { /* best-effort */ }
}

// ── Tool result helper ─────────────────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true as const };
}

// ── McpServer factory ──────────────────────────────────────────────────────────

export function createMcpServer(user: PortalUser, scopes: Set<string>, tokenWorkflowId?: string | null): McpServer {
  const server = new McpServer({
    name: 'agent-portal',
    version: '1.0.0',
  });

  const uid = user.id;
  const isAdmin = Boolean(user.is_admin);

  // delegate scope: only register delegate_session (bound to tokenWorkflowId).
  // No other tools are available to delegate-scoped tokens.
  const isDelegateToken = scopes.has('delegate') && !scopes.has('write');

  // ── READ scope tools ─────────────────────────────────────────────────────────
  // Not available to delegate-scoped tokens (they only get delegate_session).

  if (scopes.has('read') && !isDelegateToken) {
    server.registerTool(
      'list_sessions',
      {
        title: 'List sessions',
        description: 'List sessions (workflows) in a project.',
        inputSchema: {
          projectId: z.string().describe('Project ID'),
          status: z.string().optional().describe('Filter by status (pending|running|done|blocked|failed|paused)'),
          limit: z.number().int().min(1).max(100).optional().default(50),
          offset: z.number().int().min(0).optional().default(0),
        },
      },
      async ({ projectId, status, limit = 50, offset = 0 }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          audit(uid, 'list_sessions', `project:${projectId}`, { status });

          const listed = await getSessionsRepository().listWorkflowsByProject(projectId, { limit, offset, status: status || undefined });
          const rows = listed.workflows.map((w) => ({
            id: w.id, title: w.title, goal: w.goal, status: w.status, engine: w.engine, trust_tools: w.trust_tools,
            lead_agent: w.lead_agent, created_by: w.created_by, created_at: w.created_at, updated_at: w.updated_at,
          }));
          const total = listed.total ?? rows.length;
          return jsonResult({ sessions: rows, total });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );

    server.registerTool(
      'get_transcript',
      {
        title: 'Get transcript',
        description: 'Get events (transcript) for a session.',
        inputSchema: {
          projectId: z.string().describe('Project ID'),
          workflowId: z.string().describe('Session (workflow) ID'),
          limit: z.number().int().min(1).max(200).optional().default(100),
          cursor: z.number().int().optional().describe('Event ID to page from (exclusive, newest-first)'),
        },
      },
      async ({ projectId, workflowId, limit = 100, cursor }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          await assertWorkflow(projectId, workflowId);
          audit(uid, 'get_transcript', `workflow:${workflowId}`, { projectId });

          // Newest first across every run of the session. (On DynamoDB event ids count per run, so the cursor
          // filters each run's events and the merged list is ordered by time.)
          const sessions = getSessionsRepository();
          const runs = await sessions.listRunsByWorkflow(workflowId, 1000);
          const collected: Row[] = [];
          for (const run of runs) {
            const evs = cursor !== undefined
              ? await sessions.listRunEventsBefore(run.id, cursor, limit)
              : (await sessions.listRunEvents(run.id, 5000)).slice(-limit);
            for (const e of evs) collected.push({ id: e.id, run_id: e.run_id, type: e.type, payload: e.payload, created_at: e.created_at } as Row);
          }
          const rows = collected
            .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)) || Number(y.id) - Number(x.id))
            .slice(0, limit);
          const events = rows.map((e) => ({
            id: e.id,
            run_id: e.run_id,
            type: e.type,
            payload: (() => { try { return JSON.parse(String(e.payload ?? '{}')); } catch { return {}; } })(),
            created_at: e.created_at,
          }));
          return jsonResult({ events, nextCursor: rows.length === limit ? Number(rows[rows.length - 1].id) : null });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );

    server.registerTool(
      'list_reviews',
      {
        title: 'List reviews',
        description: 'List code reviews for a project.',
        inputSchema: {
          projectId: z.string().describe('Project ID'),
          status: z.string().optional().describe('Filter by status (pending|running|done|failed)'),
          limit: z.number().int().min(1).max(100).optional().default(50),
          offset: z.number().int().min(0).optional().default(0),
        },
      },
      async ({ projectId, status, limit = 50, offset = 0 }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          audit(uid, 'list_reviews', `project:${projectId}`, { status });

          const all = (await getReviewsRepository().listByProject(projectId, { limit: 100000, offset: 0 })).items
            .filter((r) => !status || r.status === status)
            .sort((x, y) => y.created_at.localeCompare(x.created_at));
          const total = all.length;
          const rows = all.slice(offset, offset + limit).map((r) => ({
            id: r.id, base_ref: r.base_ref, head_ref: r.head_ref, pr_number: r.pr_number, repo_id: r.repo_id,
            status: r.status, post_mode: r.post_mode, summary: r.summary, input_tokens: r.input_tokens,
            output_tokens: r.output_tokens, created_by: r.created_by, created_at: r.created_at,
          }));
          return jsonResult({ reviews: rows, total });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );

    server.registerTool(
      'get_review',
      {
        title: 'Get review',
        description: 'Get a code review with its findings.',
        inputSchema: {
          projectId: z.string().describe('Project ID'),
          reviewId: z.string().describe('Review ID'),
        },
      },
      async ({ projectId, reviewId }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          const r = await assertReview(projectId, reviewId);
          audit(uid, 'get_review', `review:${reviewId}`, { projectId });

          const findings = (await getReviewsRepository().listFindings(reviewId))
            .sort((x, y) => x.created_at.localeCompare(y.created_at));
          return jsonResult({ review: r, findings });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );

    server.registerTool(
      'get_review_usage',
      {
        title: 'Get review usage',
        description: 'Get cost and token usage for a review.',
        inputSchema: {
          projectId: z.string().describe('Project ID'),
          reviewId: z.string().describe('Review ID'),
        },
      },
      async ({ projectId, reviewId }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          const r = await assertReview(projectId, reviewId) as unknown as Review;
          audit(uid, 'get_review_usage', `review:${reviewId}`, { projectId });

          const rateCard = getRateCard();
          const cost = computeCost(r, rateCard);
          return jsonResult({
            reviewId,
            input_tokens: r.input_tokens,
            cache_write_tokens: r.cache_write_tokens,
            cache_read_tokens: r.cache_read_tokens,
            output_tokens: r.output_tokens,
            llm_requests: r.llm_requests,
            duration_ms: r.duration_ms,
            cost,
            rateCard,
          });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );
  }

  // ── WRITE scope tools ────────────────────────────────────────────────────────
  // Not available to delegate-scoped tokens (they only get delegate_session).

  if (scopes.has('write') && !isDelegateToken) {
    server.registerTool(
      'start_session',
      {
        title: 'Start session',
        description: 'Create and start a new session (workflow) in a project.',
        inputSchema: {
          projectId: z.string().describe('Project ID'),
          goal: z.string().max(8000).describe('Goal or task for the session'),
          engine: z.enum(['claude-code', 'kiro', 'codex', 'demo']).optional().default('demo').describe('Agent engine to use'),
          trustTools: z.boolean().optional().default(false).describe('Auto-approve all tool calls'),
        },
      },
      async ({ projectId, goal, engine = 'demo', trustTools = false }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          audit(uid, 'start_session', `project:${projectId}`, { goal: goal.slice(0, 200) });

          const id = generateId();
          const ts = now();
          await getSessionsRepository().createWorkflow({
            id,
            project_id: projectId,
            goal,
            status: 'pending',
            engine,
            trust_tools: trustTools ? 1 : 0,
            lead_agent: null,
            workspace_id: null,
            output_files_enabled: 0,
            repo_ids: '[]',
            iteration_count: 0,
            max_iterations: 10,
            credential_id: null,
            model: '',
            created_by: uid,
            created_at: ts,
            updated_at: ts,
          });

          const runId = await startRun(id);
          await getSessionsRepository().updateWorkflow(id, { last_turn_at: now(), stop_reason: '', updated_at: now() });
          emit(projectId, { type: 'workflow.created', workflowId: id });
          return jsonResult({ workflowId: id, runId });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );

    server.registerTool(
      'prompt_session',
      {
        title: 'Prompt session',
        description: 'Send a follow-up message to a running session.',
        inputSchema: {
          projectId: z.string().describe('Project ID'),
          workflowId: z.string().describe('Session (workflow) ID'),
          message: z.string().max(10000).describe('Message to send'),
        },
      },
      async ({ projectId, workflowId, message }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          const w = await assertWorkflow(projectId, workflowId);
          audit(uid, 'prompt_session', `workflow:${workflowId}`, { message: message.slice(0, 200) });

          const isCommand = message.startsWith('/');
          await getSessionsRepository().appendWorkflowEvent({
            workflow_id: workflowId,
            kind: isCommand ? 'command' : 'human',
            body: message,
            data: JSON.stringify({ by: uid }),
            created_at: now(),
          });

          const ts = now();
          await getSessionsRepository().updateWorkflow(workflowId, { last_turn_at: ts, stop_reason: '', updated_at: ts });

          if (w.project_id) {
            emit(String(w.project_id), {
              type: isCommand ? 'workflow.command' : 'workflow.message',
              workflowId,
              body: message,
              by: uid,
            });
          }

          let resumed = false;
          if (String(w.status) === 'paused') {
            try { await startRun(workflowId); resumed = true; } catch { /* ignore */ }
          }

          return jsonResult({ ok: true, kind: isCommand ? 'command' : 'human', resumed });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );

    server.registerTool(
      'stop_session',
      {
        title: 'Stop session',
        description: 'Stop (pause) a running session.',
        inputSchema: {
          projectId: z.string().describe('Project ID'),
          workflowId: z.string().describe('Session (workflow) ID'),
        },
      },
      async ({ projectId, workflowId }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          await assertWorkflow(projectId, workflowId);
          audit(uid, 'stop_session', `workflow:${workflowId}`, { projectId });

          const activeRun = await getSessionsRepository().getActiveRun(workflowId);
          if (activeRun) cancelRun(String(activeRun.id));

          await getSessionsRepository().updateWorkflow(workflowId, { status: 'paused', updated_at: now() });
          return jsonResult({ ok: true });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );

    // delegate_session is registered separately below (also available to delegate tokens)
  }

  // ── DELEGATE SESSION tool — available to write and delegate scopes ──────────────────

  if (scopes.has('write') || isDelegateToken) {
    server.registerTool(
      'delegate_session',
      {
        title: 'Delegate session',
        description:
          'Delegate a task to a new child session. The child inherits the parent session\'s ' +
          'project, engine, credential, repos, and integrations. Returns immediately after ' +
          'starting the child; the result is delivered back to the parent session\'s next turn.',
        inputSchema: {
          projectId: z.string().describe('Project ID'),
          workflowId: z.string().describe(
            'Parent session (workflow) ID. For delegate-scoped tokens this is ignored; ' +
            'the bound workflow is used instead.',
          ),
          task: z.string().max(8000).describe('Goal or task for the child session'),
          title: z.string().max(200).optional().describe('Optional short title for the child session'),
          leadAgent: z.string().max(200).optional().describe('Optional agent override for the child'),
        },
      },
      async ({ projectId, workflowId, task, title, leadAgent }) => {
        try {
          // For delegate-scoped tokens, ignore the caller's workflowId and use the
          // bound workflow from the token. This prevents a compromised token from
          // delegating on behalf of other workflows.
          const effectiveWorkflowId = isDelegateToken && tokenWorkflowId
            ? tokenWorkflowId
            : workflowId;

          await assertProjectAccess(uid, isAdmin, projectId);
          await assertWorkflow(projectId, effectiveWorkflowId);
          audit(uid, 'delegate_session', `workflow:${effectiveWorkflowId}`, { task: task.slice(0, 200) });

          const settings = await getDelegationSettingsRepository().get();
          if (!settings.enabled) {
            return errorResult('Delegation is disabled by the portal administrator.');
          }

          const child = await createChildSession(effectiveWorkflowId, uid, task, { title, leadAgent });
          const childId = String(child.id);
          const childTitle = String(child.title || (child.goal as string).slice(0, 60));

          return jsonResult({ childWorkflowId: childId, title: childTitle, status: 'started' });
        } catch (e: unknown) {
          const err = e as { status?: number; message?: string };
          if (err.status === 429) {
            return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true as const };
          }
          return errorResult((e as Error).message);
        }
      },
    );
  }

  // ── REVIEW scope tools ───────────────────────────────────────────────────────

  if (scopes.has('review')) {
    server.registerTool(
      'start_review',
      {
        title: 'Start review',
        description: 'Start a code review for a pull request or branch diff.',
        inputSchema: {
          projectId: z.string().describe('Project ID'),
          repoId: z.string().describe('Repository ID'),
          baseRef: z.string().describe('Base branch or SHA'),
          headRef: z.string().describe('Head branch or SHA'),
          prNumber: z.number().int().optional().describe('PR number if applicable'),
        },
      },
      async ({ projectId, repoId, baseRef, headRef, prNumber }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          audit(uid, 'start_review', `project:${projectId}`, { repoId, baseRef, headRef, prNumber });

          const id = generateId();
          const ts = now();
          await getReviewsRepository().create({
            id,
            project_id: projectId,
            base_ref: baseRef,
            head_ref: headRef,
            pr_number: prNumber ?? null,
            repo_id: repoId,
            status: 'pending',
            post_mode: 'draft',
            from_loop: null,
            workflow_id: null,
            min_severity: 'medium',
            summary: null,
            raw_output: null,
            created_by: uid,
            created_at: ts,
            parent_review_id: null,
            source_sha: null,
            dest_sha: null,
            head_commit_sha: null,
            provider_id: null,
            model_id: null,
            jira_context: '{}',
            run_log: '[]',
            input_tokens: 0,
            cache_write_tokens: 0,
            cache_read_tokens: 0,
            output_tokens: 0,
            llm_requests: 0,
            retry_count: 0,
            tool_calls: 0,
            files_reviewed: 0,
            duration_ms: null,
            started_at: null,
            merged_at: null,
            merged_by: null,
            scan_id: null,
          });

          return jsonResult({ reviewId: id });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );

    server.registerTool(
      'wait_for_review',
      {
        title: 'Wait for review',
        description: 'Poll a review until it completes or the timeout is reached (max 25 s). Returns current status and progress.',
        inputSchema: {
          projectId: z.string().describe('Project ID'),
          reviewId: z.string().describe('Review ID'),
          timeoutMs: z.number().int().min(1000).max(25000).optional().default(25000),
        },
      },
      async ({ projectId, reviewId, timeoutMs = 25000 }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          audit(uid, 'wait_for_review', `review:${reviewId}`, { projectId, timeoutMs });

          const deadline = Date.now() + Math.min(timeoutMs, 25_000);
          let review: Row | undefined;

          while (Date.now() < deadline) {
            const found = await getReviewsRepository().getById(reviewId);
            review = found && found.project_id === projectId ? (found as unknown as Row) : undefined;
            if (!review) return errorResult('Review not found');
            const s = String(review.status);
            if (s === 'done' || s === 'failed') break;
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            await sleep(Math.min(1000, remaining));
          }

          if (!review) return errorResult('Review not found');

          const findingsCount = (await getReviewsRepository().listFindings(reviewId)).length;

          return jsonResult({
            review: {
              id: review.id,
              status: review.status,
              summary: review.summary,
              files_reviewed: review.files_reviewed,
              input_tokens: review.input_tokens,
              output_tokens: review.output_tokens,
              started_at: review.started_at,
              created_at: review.created_at,
            },
            findingsCount,
            timedOut: String(review.status) !== 'done' && String(review.status) !== 'failed',
          });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );

    server.registerTool(
      'post_review_comments',
      {
        title: 'Post review comments',
        description: 'Post review findings as PR comments (requires a GitHub connection and a completed review).',
        inputSchema: {
          projectId: z.string().describe('Project ID'),
          reviewId: z.string().describe('Review ID'),
        },
      },
      async ({ projectId, reviewId }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          const r = await assertReview(projectId, reviewId) as unknown as Review;
          audit(uid, 'post_review_comments', `review:${reviewId}`, { projectId });

          if (r.status !== 'done') return errorResult('Review is not complete');
          if (!r.pr_number) return errorResult('Review has no PR number; cannot post comments');
          if (!r.repo_id) return errorResult('Review has no repository; cannot post comments');

          const repo = await getRepoInfo(r.repo_id);
          if (!repo) return errorResult('Repository not found');
          if (repo.provider !== 'github') return errorResult('Comment posting only supported for GitHub repositories');

          const ownerRepo = parseGHOwnerRepo(String(repo.url));
          const token = await findGitHubTokenForUser(uid);
          if (!ownerRepo || !token) return errorResult('GitHub credentials not found');

          const headSha = r.head_commit_sha ?? r.source_sha;
          if (!headSha) return errorResult('Review has no commit SHA; cannot post comments');

          const findings = ((await getReviewsRepository().listFindings(reviewId)) as unknown as Finding[])
            .filter((f) => f.accepted !== -1)
            .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));

          let posted = 0;
          let failed = 0;
          for (const f of findings) {
            if (f.posted_at) continue;
            const body = `**${f.severity.toUpperCase()}**: ${f.title}\n\n${f.body}`;
            const result = await _providers.githubPostComment(
              ownerRepo.owner, ownerRepo.repo, r.pr_number,
              body, headSha, f.file_path || null, f.line_number ?? null, token,
            );
            if (result.ok) {
              await getReviewsRepository().markFindingPosted(f.id, now());
              posted++;
            } else {
              failed++;
            }
          }

          if (posted > 0 || failed === 0) {
            await getReviewsRepository().update(reviewId, { posted_at: now() } as never);
          }

          return jsonResult({ ok: true, posted, failed });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );

    server.registerTool(
      'start_scan',
      {
        title: 'Start scan',
        description: 'Start a branch scan (estimate phase; confirm budget before reviewing).',
        inputSchema: {
          projectId: z.string().describe('Project ID'),
          repoId: z.string().describe('Repository ID'),
          branch: z.string().optional().describe('Branch to scan (default: repo default branch)'),
          includePaths: z.array(z.string()).optional().describe('Glob patterns to include'),
          excludePaths: z.array(z.string()).optional().describe('Glob patterns to exclude'),
        },
      },
      async ({ projectId, repoId, branch, includePaths, excludePaths }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);

          // Scan allowlist check
          const allowlist = (() => {
            const raw = getSetting(getDb(), 'review.fullScanUsers');
            if (!raw) return [] as string[];
            try { return JSON.parse(String(raw)) as string[]; } catch { return []; }
          })();
          if (!isAdmin && !allowlist.includes(uid)) {
            return errorResult('You are not authorized to run branch scans');
          }

          audit(uid, 'start_scan', `project:${projectId}`, { repoId, branch });

          const id = newId('sc_');
          const ts = now();
          await getScansRepository().create({
            id,
            project_id: projectId,
            repo_id: repoId,
            branch: branch ?? null,
            pinned_sha: null,
            include_paths: JSON.stringify(includePaths ?? []),
            exclude_paths: JSON.stringify(excludePaths ?? []),
            background_doc_ids: '[]',
            model_role: null,
            provider_id: null,
            model_id: null,
            status: 'estimating',
            fail_reason: null,
            budget_tokens: null,
            estimated_files: null,
            estimated_bytes: null,
            estimated_tokens: null,
            estimated_cost_usd: null,
            estimated_minutes: null,
            files_total: 0,
            files_done: 0,
            tokens_used: 0,
            cost_usd: 0,
            input_tokens: 0,
            output_tokens: 0,
            summary: null,
            review_id: null,
            created_by: uid,
            created_at: ts,
            started_at: null,
            completed_at: null,
            workflow_id: null,
          });

          return jsonResult({ scanId: id, status: 'estimating' });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );

    server.registerTool(
      'confirm_scan',
      {
        title: 'Confirm scan',
        description: 'Confirm the budget for a scan and start reviewing.',
        inputSchema: {
          projectId: z.string().describe('Project ID'),
          scanId: z.string().describe('Scan ID'),
          budgetTokens: z.number().int().min(1).describe('Token budget to confirm'),
        },
      },
      async ({ projectId, scanId, budgetTokens }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          const scan = await assertScan(projectId, scanId);
          audit(uid, 'confirm_scan', `scan:${scanId}`, { budgetTokens });

          const currentStatus = String(scan.status);
          if (currentStatus !== 'estimate_ready') {
            return errorResult(`Cannot confirm: scan is ${currentStatus}`);
          }

          await getScansRepository().update(scanId, { status: 'queued', budget_tokens: budgetTokens });

          return jsonResult({ ok: true, scanId, status: 'queued' });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );

    server.registerTool(
      'resume_scan',
      {
        title: 'Resume scan',
        description: 'Resume a failed or budget-stopped scan.',
        inputSchema: {
          projectId: z.string().describe('Project ID'),
          scanId: z.string().describe('Scan ID'),
        },
      },
      async ({ projectId, scanId }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          const scan = await assertScan(projectId, scanId);
          audit(uid, 'resume_scan', `scan:${scanId}`, { projectId });

          const currentStatus = String(scan.status);
          if (currentStatus !== 'failed' && currentStatus !== 'completed') {
            return errorResult(`Cannot resume: scan is ${currentStatus}`);
          }

          await getScansRepository().update(scanId, { status: 'queued', fail_reason: null });

          return jsonResult({ ok: true, scanId, status: 'queued' });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );
  }

  // ── MERGE scope tools ────────────────────────────────────────────────────────

  if (scopes.has('merge')) {
    server.registerTool(
      'merge_pull_request',
      {
        title: 'Merge pull request',
        description: 'Merge the PR associated with a completed review (GitHub only).',
        inputSchema: {
          projectId: z.string().describe('Project ID'),
          reviewId: z.string().describe('Review ID with a passing merge verdict'),
          strategy: z.enum(['squash', 'merge']).optional().default('squash'),
        },
      },
      async ({ projectId, reviewId, strategy = 'squash' }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          const r = await assertReview(projectId, reviewId) as unknown as Review;
          audit(uid, 'merge_pull_request', `review:${reviewId}`, { projectId, strategy });

          if (r.status !== 'done') return errorResult('Review is not complete');
          if (!r.pr_number) return errorResult('Review has no PR number');
          if (!r.repo_id) return errorResult('Review has no repository');

          const repo = await getRepoInfo(r.repo_id);
          if (!repo) return errorResult('Repository not found');
          if (repo.provider !== 'github') return errorResult('Merge only supported for GitHub repositories');

          const ownerRepo = parseGHOwnerRepo(String(repo.url));
          const token = await findGitHubTokenForUser(uid);
          if (!ownerRepo || !token) return errorResult('GitHub credentials not found');

          // Check merge verdict
          const findings = (await getReviewsRepository().listFindings(reviewId)) as unknown as Finding[];
          const verdict = computeMergeVerdict(r, findings, (() => {
            const raw = getSetting(getDb(), 'review.mergeThreshold');
            if (!raw) return 'high';
            try { return JSON.parse(String(raw)) as string; } catch { return 'high'; }
          })() as Parameters<typeof computeMergeVerdict>[2]);

          if (!verdict.mergeable) {
            return errorResult(`Merge blocked: ${verdict.reason}`);
          }

          const result = await _providers.githubMerge(
            ownerRepo.owner, ownerRepo.repo, r.pr_number,
            strategy as 'squash' | 'merge', token, r.head_commit_sha ?? null,
          );

          await getReviewsRepository().update(reviewId, {
            merged_at: now(), merged_by: uid, head_commit_sha: result.sha ?? r.head_commit_sha ?? null,
          });

          return jsonResult({ ok: true, sha: result.sha });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );
  }

  // ── Tests READ scope tools ────────────────────────────────────────────────────
  // Available to read-scoped tokens; not available to delegate tokens.

  if (scopes.has('read') && !isDelegateToken) {
    server.registerTool(
      'list_test_projects',
      {
        title: 'List test projects',
        description: 'List test projects for a portal project.',
        inputSchema: {
          projectId: z.string().describe('Portal project ID'),
        },
      },
      async ({ projectId }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          audit(uid, 'list_test_projects', `project:${projectId}`, {});
          const rows = (await testingRepo().listTestProjectsByProject(projectId))
            .sort((x, y) => y.created_at.localeCompare(x.created_at))
            .map((t) => ({
              id: t.id, name: t.name, app_url: t.app_url, api_base_url: t.api_base_url, viewport_width: t.viewport_width,
              viewport_height: t.viewport_height, timeout_secs: t.timeout_secs, rules_for_ai: t.rules_for_ai,
              created_by: t.created_by, created_at: t.created_at, updated_at: t.updated_at,
            })) as Row[];
          return jsonResult({ testProjects: rows });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );

    server.registerTool(
      'list_test_scripts',
      {
        title: 'List test scripts',
        description: 'List test scripts in a test project.',
        inputSchema: {
          projectId: z.string().describe('Portal project ID'),
          testProjectId: z.string().describe('Test project ID'),
          groupId: z.string().optional().describe('Filter by group ID'),
        },
      },
      async ({ projectId, testProjectId, groupId }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          const tp = await testingRepo().getTestProjectByProjectAndId(projectId, testProjectId);
          if (!tp) return errorResult('Test project not found');
          audit(uid, 'list_test_scripts', `test_project:${testProjectId}`, { groupId });
          const groups = await testingRepo().listGroupsByTestProject(testProjectId);
          const groupName = new Map(groups.map((g) => [g.id, g.name]));
          const rows = (await testingRepo().listScriptsByTestProject(testProjectId))
            .filter((x) => (!groupId || x.test_group_id === groupId) && groupName.has(x.test_group_id))
            .sort((a, b) => a.test_group_id.localeCompare(b.test_group_id) || a.sort_order - b.sort_order)
            .map((x) => ({
              id: x.id, name: x.name, test_group_id: x.test_group_id, group_name: groupName.get(x.test_group_id),
              sort_order: x.sort_order, steps: x.steps, created_by: x.created_by, created_at: x.created_at,
            })) as Row[];
          // Return steps as parsed JSON to be useful; vault refs are template strings, not actual values
          const scripts = rows.map((s) => ({
            ...s,
            steps: (() => { try { return JSON.parse(String(s.steps ?? '[]')); } catch { return []; } })(),
          }));
          return jsonResult({ scripts });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );

    server.registerTool(
      'get_test_run',
      {
        title: 'Get test run',
        description: 'Get a test run with its step results.',
        inputSchema: {
          projectId: z.string().describe('Portal project ID'),
          testProjectId: z.string().describe('Test project ID'),
          runId: z.string().describe('Test run ID'),
        },
      },
      async ({ projectId, testProjectId, runId }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          const tp = await testingRepo().getTestProjectByProjectAndId(projectId, testProjectId);
          if (!tp) return errorResult('Test project not found');
          const testRun = (await testingRepo().getTestRunByTestProjectAndId(testProjectId, runId)) as unknown as Row | null;
          if (!testRun) return errorResult('Test run not found');
          audit(uid, 'get_test_run', `test_run:${runId}`, { testProjectId });
          const steps = (await testingRepo().listStepsByRun(runId))
            .sort((a, b) => a.step_index - b.step_index)
            .map((x) => ({ id: x.id, script_id: x.script_id, step_index: x.step_index, status: x.status, duration_ms: x.duration_ms, error: x.error, created_at: x.created_at })) as Row[];
          // Omit screenshot_path — it's a server filesystem path, not useful over MCP
          return jsonResult({ run: testRun, steps });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );
  }

  // ── TESTS scope tools ─────────────────────────────────────────────────────────

  if (scopes.has('tests') && !isDelegateToken) {
    server.registerTool(
      'start_test_run',
      {
        title: 'Start test run',
        description: 'Start a test run for a script or an entire group.',
        inputSchema: {
          projectId: z.string().describe('Portal project ID'),
          testProjectId: z.string().describe('Test project ID'),
          scriptId: z.string().optional().describe('Script ID to run (mutually exclusive with groupId)'),
          groupId: z.string().optional().describe('Group ID to run all scripts in (mutually exclusive with scriptId)'),
        },
      },
      async ({ projectId, testProjectId, scriptId, groupId }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          const tp = (await testingRepo().getTestProjectByProjectAndId(projectId, testProjectId)) as unknown as TestProject | null;
          if (!tp) return errorResult('Test project not found');
          audit(uid, 'start_test_run', `test_project:${testProjectId}`, { scriptId, groupId });

          if (!scriptId && !groupId) return errorResult('Provide either scriptId or groupId');
          if (scriptId && groupId) return errorResult('Provide only one of scriptId or groupId');

          const maxConcurrent = Number(getSetting(getDb(), 'test.run_concurrency') ?? '2') || 2;
          if (_runningCount >= maxConcurrent) {
            return errorResult(`Concurrency limit reached (max ${maxConcurrent} concurrent runs)`);
          }

          let scripts: TestScript[];
          if (scriptId) {
            const script = (await testingRepo().getTestScriptByTestProjectAndId(testProjectId, scriptId)) as unknown as TestScript | null;
            if (!script) return errorResult('Script not found');
            scripts = [script];
          } else {
            scripts = ((await testingRepo().listScriptsByGroup(groupId!)) as unknown as TestScript[])
              .sort((a, b) => a.sort_order - b.sort_order);
            if (scripts.length === 0) return errorResult('No scripts in this group');
          }

          const runId = generateId();
          const ts = now();
          await testingRepo().createTestRun({
            id: runId,
            test_project_id: testProjectId,
            script_id: scriptId ?? null,
            group_id: groupId ?? null,
            status: 'queued',
            error: null,
            artifact_dir: null,
            created_by: uid,
            created_at: ts,
            started_at: null,
            finished_at: null,
          });

          await runInBackground('test-run', { runId, testProjectId, scriptIds: scripts.map((x) => x.id) });

          return jsonResult({ runId });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );

    server.registerTool(
      'cancel_test_run',
      {
        title: 'Cancel test run',
        description: 'Cancel a queued or running test run.',
        inputSchema: {
          projectId: z.string().describe('Portal project ID'),
          testProjectId: z.string().describe('Test project ID'),
          runId: z.string().describe('Test run ID to cancel'),
        },
      },
      async ({ projectId, testProjectId, runId }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          const tp = await testingRepo().getTestProjectByProjectAndId(projectId, testProjectId);
          if (!tp) return errorResult('Test project not found');
          const testRun = (await testingRepo().getTestRunByTestProjectAndId(testProjectId, runId)) as unknown as Row | null;
          if (!testRun) return errorResult('Test run not found');
          audit(uid, 'cancel_test_run', `test_run:${runId}`, { testProjectId });

          const status = String(testRun.status ?? '');
          if (status !== 'running' && status !== 'queued') {
            return jsonResult({ ok: true, status, alreadyFinished: true });
          }

          _cancelledRuns.add(runId);
          await testingRepo().updateTestRun(runId, { status: 'cancelled', finished_at: now() });

          const updated = await testingRepo().getTestRunById(runId);
          return jsonResult({ ok: true, status: updated?.status ?? 'cancelled' });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );

    server.registerTool(
      'generate_test_script',
      {
        title: 'Generate test script',
        description: 'Asynchronously generate a test script from a natural-language description.',
        inputSchema: {
          projectId: z.string().describe('Portal project ID'),
          testProjectId: z.string().describe('Test project ID'),
          description: z.string().max(4000).describe('Natural-language description of what to test'),
          groupId: z.string().optional().describe('Test group to add the script to (default: first group)'),
        },
      },
      async ({ projectId, testProjectId, description, groupId }) => {
        try {
          await assertProjectAccess(uid, isAdmin, projectId);
          const tp = (await testingRepo().getTestProjectByProjectAndId(projectId, testProjectId)) as unknown as TestProject | null;
          if (!tp) return errorResult('Test project not found');
          audit(uid, 'generate_test_script', `test_project:${testProjectId}`, { description: description.slice(0, 200) });

          // Resolve group
          let targetGroupId: string;
          if (groupId) {
            const group = await testingRepo().getTestGroupByTestProjectAndId(testProjectId, groupId);
            if (!group) return errorResult('Group not found in this test project');
            targetGroupId = groupId;
          } else {
            const groups = (await testingRepo().listGroupsByTestProject(testProjectId)).sort((a, b) => a.sort_order - b.sort_order);
            let existingId = groups[0]?.id;
            if (!existingId) {
              const gid = generateId();
              const ts = now();
              await testingRepo().createTestGroup({ id: gid, test_project_id: testProjectId, name: 'Default', sort_order: 0, created_at: ts, updated_at: ts });
              existingId = gid;
            }
            targetGroupId = existingId;
          }

          const genId = generateId();
          const ts = now();
          await testingRepo().createGeneration({
            id: genId,
            test_project_id: testProjectId,
            script_id: null,
            kind: 'generate',
            description: description.slice(0, 200),
            status: 'pending',
            error: null,
            result_script_ids: '[]',
            warnings: '[]',
            group_id: targetGroupId,
            attachment_ids: '[]',
            progress: '{}',
            started_at: null,
            cancelled_at: null,
            created_by: uid,
            created_at: ts,
            finished_at: null,
          });

          await runInBackground('test-generate', { genId, testProjectId: tp.id, description, targetGroupId, existingScriptId: null, createdBy: uid, attachmentIds: [] });

          return jsonResult({ generationId: genId });
        } catch (e: unknown) {
          return errorResult((e as Error).message);
        }
      },
    );
  }

  return server;
}
