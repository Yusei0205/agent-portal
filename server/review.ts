/**
 * Code Review API (P10) — R1 Merge Gate, R2 Re-run, R3 Cost/Dashboard,
 * R4 Report Export, R5 Jira Context.
 *
 * Routes (existing, backward-compatible):
 *   GET    /api/projects/:id/reviews
 *   POST   /api/projects/:id/reviews
 *   GET    /api/projects/:id/reviews/:rid
 *   DELETE /api/projects/:id/reviews/:rid
 *   GET    /api/projects/:id/reviews/:rid/findings
 *   PUT    /api/projects/:id/reviews/:rid/findings/:fid
 *   POST   /api/projects/:id/reviews/:rid/post
 *
 * New routes:
 *   POST   /api/projects/:id/reviews/:rid/merge    (R1)
 *   POST   /api/projects/:id/reviews/:rid/rerun    (R2)
 *   GET    /api/projects/:id/reviews/:rid/export/xlsx  (R4)
 *   GET    /api/projects/:id/reviews/:rid/export/docx  (R4)
 *   GET    /api/reviews/dashboard                   (R3)
 *   GET    /api/settings/review                     (R1/R3)
 *   PUT    /api/settings/review                     (R1/R3, admin)
 */

import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, run, insert, getDb } from './db.ts';
import { generateId, now, parseJson, newId } from './util.ts';
import { getSetting, setSetting, getSettings } from './settings.ts';
import { getReviewsRepository } from './repositories/reviews.ts';
import type { ReviewRecord, FindingRecord } from './repositories/reviews.ts';
import { emit } from './events.ts';
import { appendAudit } from './audit.ts';
import { buildXlsx, buildDocx } from './docgen.ts';
import { decrypt } from './secrets.ts';
import { config } from './config.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Review {
  id: string;
  project_id: string;
  base_ref: string;
  head_ref: string;
  pr_number: number | null;
  repo_id: string | null;
  status: 'pending' | 'running' | 'done' | 'failed';
  post_mode: 'draft' | 'auto';
  from_loop: string | null;
  workflow_id: string | null;
  min_severity: string;
  summary: string | null;
  /** Full untruncated assistant transcript. Only returned by the detail endpoint. */
  raw_output: string | null;
  created_by: string | null;
  created_at: string;
  // R2: reproducibility
  parent_review_id: string | null;
  source_sha: string | null;
  dest_sha: string | null;
  provider_id: string | null;
  model_id: string | null;
  jira_context: string;
  run_log: string;
  // R3: cost tracking
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  llm_requests: number;
  retry_count: number;
  tool_calls: number;
  files_reviewed: number;
  duration_ms: number | null;
  started_at: string | null;
  // R1: merge
  merged_at: string | null;
  merged_by: string | null;
  head_commit_sha: string | null;
}

export interface Finding {
  id: string;
  review_id: string;
  file_path: string;
  line_number: number | null;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  body: string;
  confidence: number | null;
  accepted: number;
  posted_at: string | null;
  created_at: string;
}

export interface JiraContext {
  key: string | null;
  summary: string | null;
  description: string | null;
  source: 'explicit' | 'branch' | 'none';
  reason: string | null;
}

export interface RateCard {
  inputUsd: number;
  outputUsd: number;
  cacheWriteUsd: number;
  cacheReadUsd: number;
}

export interface MergeVerdict {
  verdict: 'mergeable' | 'blocked';
  mergeable: boolean;
  worstSeverity: Severity | null;
  reason: string;
  activeFindings: number;
}

type MergeStrategy = 'squash' | 'merge';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
type Severity = (typeof SEVERITIES)[number];

const MERGE_THRESHOLDS = ['critical', 'high', 'medium', 'low', 'info', 'none'] as const;
type MergeThreshold = (typeof MERGE_THRESHOLDS)[number];

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4,
};

// Represents a provider-level merge conflict (not-mergeable / merge-conflict).
// Mapped to HTTP 409 in the merge route.
class MergeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeConflictError';
  }
}

const DEFAULT_RATE_CARD: RateCard = {
  inputUsd: 3,
  outputUsd: 15,
  cacheWriteUsd: 3.75,
  cacheReadUsd: 0.30,
};

// ── Settings helpers ──────────────────────────────────────────────────────────

function getMergeThreshold(): MergeThreshold {
  const raw = getSetting(getDb(), 'review.mergeThreshold');
  if (raw) {
    try {
      const v = JSON.parse(raw);
      if (typeof v === 'string' && MERGE_THRESHOLDS.includes(v as MergeThreshold)) {
        return v as MergeThreshold;
      }
    } catch { /* fall through */ }
  }
  return 'high';
}

export function getRateCard(): RateCard {
  const raw = getSetting(getDb(), 'review.rateCard');
  if (raw) {
    const parsed = parseJson<Partial<RateCard>>(raw, {});
    return { ...DEFAULT_RATE_CARD, ...parsed };
  }
  return { ...DEFAULT_RATE_CARD };
}

export function getPrCommentMode(): 'manual' | 'automatic' {
  const raw = getSetting(getDb(), 'review.prCommentMode');
  if (raw) {
    try {
      const v = JSON.parse(raw);
      if (v === 'automatic') return 'automatic';
    } catch { /* fall through */ }
  }
  return 'manual';
}

// ── Cost computation (R3) ─────────────────────────────────────────────────────

export function computeCost(
  review: Pick<Review, 'input_tokens' | 'cache_write_tokens' | 'cache_read_tokens' | 'output_tokens'>,
  rateCard: RateCard,
): { estimatedUsd: number; cacheSavedUsd: number } {
  const M = 1_000_000;
  const estimatedUsd =
    (review.input_tokens / M) * rateCard.inputUsd +
    (review.cache_write_tokens / M) * rateCard.cacheWriteUsd +
    (review.cache_read_tokens / M) * rateCard.cacheReadUsd +
    (review.output_tokens / M) * rateCard.outputUsd;
  const cacheSavedUsd =
    (review.cache_read_tokens / M) * (rateCard.inputUsd - rateCard.cacheReadUsd);
  return { estimatedUsd, cacheSavedUsd };
}

// ── Merge verdict (R1) ────────────────────────────────────────────────────────

/**
 * Compute merge verdict. Exported for direct unit testing.
 *
 * threshold meaning: the worst severity that is STILL mergeable.
 *   'critical' → nothing blocked (anything is ok)
 *   'high'     → blocks critical
 *   'medium'   → blocks critical + high
 *   'low'      → blocks critical + high + medium
 *   'info'     → blocks everything except info
 *   'none'     → only zero-finding reviews pass
 */
export function computeMergeVerdict(
  review: Pick<Review, 'status'>,
  findings: Pick<Finding, 'accepted' | 'severity'>[],
  threshold: MergeThreshold,
): MergeVerdict {
  if (review.status !== 'done') {
    return {
      verdict: 'blocked',
      mergeable: false,
      worstSeverity: null,
      activeFindings: 0,
      reason: `Review is not completed (status: ${review.status})`,
    };
  }

  const active = findings.filter((f) => f.accepted !== -1);

  if (active.length === 0) {
    return {
      verdict: 'mergeable',
      mergeable: true,
      worstSeverity: null,
      activeFindings: 0,
      reason: 'No active findings',
    };
  }

  if (threshold === 'none') {
    const worstRank = Math.min(...active.map((f) => SEVERITY_RANK[f.severity]));
    const worstSeverity = SEVERITIES[worstRank];
    return {
      verdict: 'blocked',
      mergeable: false,
      worstSeverity,
      activeFindings: active.length,
      reason: `${active.length} active finding(s); threshold requires zero findings`,
    };
  }

  const worstRank = Math.min(...active.map((f) => SEVERITY_RANK[f.severity]));
  const worstSeverity = SEVERITIES[worstRank];
  const thresholdRank = SEVERITY_RANK[threshold as Severity];

  if (worstRank < thresholdRank) {
    return {
      verdict: 'blocked',
      mergeable: false,
      worstSeverity,
      activeFindings: active.length,
      reason: `${worstSeverity} finding found; threshold allows only ${threshold} or less severe`,
    };
  }

  return {
    verdict: 'mergeable',
    mergeable: true,
    worstSeverity,
    activeFindings: active.length,
    reason: `Worst finding (${worstSeverity}) is within threshold (${threshold})`,
  };
}

// ── Jira helpers (R5) ─────────────────────────────────────────────────────────

/**
 * Parse a Jira issue key (e.g. XACT-828) from a branch name.
 * Handles formats like: feature/XACT-828, feature/XACT-828-some-description, XACT-828-fix-bug.
 */
export function parseJiraKeyFromBranch(branch: string): string | null {
  const match = branch.match(/\b([A-Za-z][A-Za-z0-9]+-\d+)\b/);
  return match ? match[1].toUpperCase() : null;
}

function extractAdfText(node: unknown, depth = 0): string {
  if (!node || typeof node !== 'object' || depth > 12) return '';
  const n = node as Record<string, unknown>;
  if (typeof n.text === 'string') return n.text;
  if (Array.isArray(n.content)) {
    return (n.content as unknown[])
      .map((c) => extractAdfText(c, depth + 1))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

async function resolveJiraContext(
  projectId: string,
  branch: string,
  explicitKey?: string | null,
): Promise<JiraContext> {
  const key = (explicitKey?.trim().toUpperCase()) || parseJiraKeyFromBranch(branch);

  if (!key) {
    return { key: null, summary: null, description: null, source: 'none', reason: 'No Jira key in branch name or request' };
  }

  const source = explicitKey?.trim() ? 'explicit' : 'branch';

  interface McpRow { config_enc: string | null }
  const integration = one<McpRow>(
    "SELECT config_enc FROM mcp_integrations WHERE project_id = ? AND type = 'atlassian' AND enabled = 1 LIMIT 1",
    projectId,
  );

  if (!integration || !integration.config_enc) {
    return { key, summary: null, description: null, source, reason: 'No Jira integration configured for this project' };
  }

  let baseUrl: string;
  let token: string;
  let jiraEmail = '';
  try {
    const plain = decrypt(integration.config_enc, config.secretKey);
    const cfg = JSON.parse(plain) as Record<string, unknown>;
    baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl.replace(/\/$/, '') : '';
    token = typeof cfg.token === 'string' ? cfg.token : '';
    jiraEmail = typeof cfg.email === 'string' ? cfg.email.trim() : '';
    if (!baseUrl || !token) {
      return { key, summary: null, description: null, source, reason: 'Jira integration missing baseUrl or token' };
    }
  } catch {
    return { key, summary: null, description: null, source, reason: 'Could not read Jira integration credentials' };
  }

  // Jira Cloud requires Basic auth: base64(email:api_token).
  // Jira Data Center / Server accepts Bearer with a personal access token.
  // We use Basic when an email is configured (Cloud), Bearer otherwise (Server/DC).
  const authHeader = jiraEmail
    ? `Basic ${Buffer.from(`${jiraEmail}:${token}`).toString('base64')}`
    : `Bearer ${token}`;

  try {
    const resp = await fetch(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description`, {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!resp.ok) {
      return { key, summary: null, description: null, source, reason: `Jira API returned ${resp.status}` };
    }

    const data = await resp.json() as { fields?: { summary?: string; description?: unknown } };
    const summary = typeof data.fields?.summary === 'string' ? data.fields.summary : null;
    let description: string | null = null;
    if (data.fields?.description) {
      if (typeof data.fields.description === 'string') {
        description = data.fields.description.slice(0, 2000);
      } else {
        description = extractAdfText(data.fields.description).slice(0, 2000) || null;
      }
    }

    return { key, summary, description, source, reason: null };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { key, summary: null, description: null, source, reason: `Jira fetch failed: ${msg.slice(0, 200)}` };
  }
}

// ── Provider operations (R1 merge + R2 post, injectable for tests) ─────────────

interface GitHubMergeResult { sha: string }

/**
 * Credentials for a CodeCommit operation.
 * 'keys': direct accessKeyId/secretAccessKey (static IAM keys).
 * 'profile': use a named AWS CLI profile from ~/.aws/credentials.
 * 'instance-role': use the EC2/ECS instance profile (default credential chain).
 * 'sso': use AWS SSO via a named profile.
 * 'portal-sso': use the portal-wide Bedrock SSO identity.
 */
interface CodeCommitCreds {
  region: string;
  authMethod: 'keys' | 'profile' | 'instance-role' | 'sso' | 'portal-sso';
  accessKeyId?: string;
  secretAccessKey?: string;
  profileName?: string;
}

/** Build a CodeCommitClient from a CodeCommitCreds config. */
async function makeCodeCommitClient(creds: CodeCommitCreds) {
  const { CodeCommitClient } = await import('@aws-sdk/client-codecommit');
  const base = { region: creds.region };
  if (creds.authMethod === 'keys' && creds.accessKeyId && creds.secretAccessKey) {
    return new CodeCommitClient({ ...base, credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey } });
  }
  if (creds.authMethod === 'profile' && creds.profileName) {
    const { fromIni } = await import('@aws-sdk/credential-providers');
    return new CodeCommitClient({ ...base, credentials: fromIni({ profile: creds.profileName }) });
  }
  if (creds.authMethod === 'sso') {
    const { fromSSO } = await import('@aws-sdk/credential-providers');
    return new CodeCommitClient({ ...base, credentials: fromSSO({ profile: creds.profileName }) });
  }
  if (creds.authMethod === 'portal-sso') {
    const { getBedrockSsoCredentials } = await import('./bedrock-sso.ts');
    const c = await getBedrockSsoCredentials();
    return new CodeCommitClient({ ...base, credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken } });
  }
  // instance-role: SDK uses the default credential chain (IMDS / env / container)
  return new CodeCommitClient(base);
}

async function _doGitHubGetPrHead(
  owner: string, repo: string, prNumber: number, token: string,
): Promise<string | null> {
  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json() as { head?: { sha?: string } };
  return data.head?.sha ?? null;
}

/**
 * Fetch both source (head) and destination (base) commit SHAs for a GitHub PR.
 * Used during review creation/re-run to persist both SHAs upfront.
 */
async function _doGitHubGetPrShas(
  owner: string, repo: string, prNumber: number, token: string,
): Promise<{ sourceSha: string | null; destSha: string | null }> {
  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return { sourceSha: null, destSha: null };
  const data = await resp.json() as { head?: { sha?: string }; base?: { sha?: string } };
  return { sourceSha: data.head?.sha ?? null, destSha: data.base?.sha ?? null };
}

async function _doGitHubMerge(
  owner: string, repo: string, prNumber: number, strategy: MergeStrategy, token: string, sha?: string | null,
): Promise<GitHubMergeResult> {
  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      merge_method: strategy === 'squash' ? 'squash' : 'merge',
      ...(sha ? { sha } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await resp.json().catch(() => ({})) as { message?: string };
  if (resp.status === 405 || resp.status === 409) {
    // 405 = Method Not Allowed (already merged); 409 = Conflict (merge conflicts)
    throw new MergeConflictError(`GitHub merge not mergeable (${resp.status}): ${body.message ?? resp.statusText}`);
  }
  if (!resp.ok) {
    throw new Error(`GitHub merge failed (${resp.status}): ${body.message ?? resp.statusText}`);
  }
  const data = body as { sha?: string };
  return { sha: data.sha ?? '' };
}

async function _doGitHubPostComment(
  owner: string, repo: string, prNumber: number,
  body: string, commitId: string, path: string | null, line: number | null, token: string,
): Promise<{ ok: boolean; status: number }> {
  const payload: Record<string, unknown> = { body, commit_id: commitId };
  if (path && line != null) {
    payload.path = path;
    payload.line = line;
    payload.side = 'RIGHT';
  } else {
    payload.event = 'COMMENT';
  }
  const url = path && line != null
    ? `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`
    : `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  return { ok: resp.ok, status: resp.status };
}

async function _doCodeCommitGetPrHead(
  repositoryName: string, prId: string, creds: CodeCommitCreds,
): Promise<string | null> {
  const { GetPullRequestCommand } = await import('@aws-sdk/client-codecommit');
  const client = await makeCodeCommitClient(creds);
  const result = await client.send(new GetPullRequestCommand({ pullRequestId: prId }));
  const target = result.pullRequest?.pullRequestTargets?.[0];
  return target?.sourceCommit ?? null;
}

/**
 * Fetch both source and destination commit SHAs for a CodeCommit PR.
 * Used during review creation/re-run to persist both SHAs upfront.
 */
async function _doCodeCommitGetPrShas(
  repositoryName: string, prId: string, creds: CodeCommitCreds,
): Promise<{ sourceSha: string | null; destSha: string | null }> {
  const { GetPullRequestCommand } = await import('@aws-sdk/client-codecommit');
  const client = await makeCodeCommitClient(creds);
  const result = await client.send(new GetPullRequestCommand({ pullRequestId: prId }));
  const target = result.pullRequest?.pullRequestTargets?.[0];
  return {
    sourceSha: target?.sourceCommit ?? null,
    destSha: target?.destinationCommit ?? null,
  };
}

async function _doCodeCommitMerge(
  repositoryName: string, prId: string, sourceCommitId: string,
  strategy: MergeStrategy, creds: CodeCommitCreds,
): Promise<void> {
  const { MergePullRequestBySquashCommand, MergePullRequestByThreeWayCommand } = await import('@aws-sdk/client-codecommit');
  const client = await makeCodeCommitClient(creds);
  try {
    if (strategy === 'squash') {
      await client.send(new MergePullRequestBySquashCommand({ pullRequestId: prId, repositoryName, sourceCommitId }));
    } else {
      // 'merge' = real three-way merge commit; fast-forward fails when destination has moved
      await client.send(new MergePullRequestByThreeWayCommand({ pullRequestId: prId, repositoryName, sourceCommitId }));
    }
  } catch (e: unknown) {
    const name = (e as { name?: string })?.name ?? '';
    // Map provider merge-conflict and not-mergeable errors to a distinct error type
    if (
      name === 'ManualMergeRequiredException' ||
      name === 'MergeConflictException' ||
      name === 'ConcurrentReferenceUpdateException' ||
      name === 'PullRequestAlreadyClosedException' ||
      name === 'PullRequestApprovalRulesNotSatisfiedException'
    ) {
      throw new MergeConflictError(`CodeCommit: ${name} — ${(e as { message?: string })?.message ?? ''}`);
    }
    throw e;
  }
}

async function _doCodeCommitPostComment(
  repositoryName: string, prId: string,
  beforeCommitId: string, afterCommitId: string,
  content: string, filePath: string | null, lineNumber: number | null,
  clientRequestToken: string, creds: CodeCommitCreds,
): Promise<void> {
  const { PostCommentForPullRequestCommand } = await import('@aws-sdk/client-codecommit');
  const client = await makeCodeCommitClient(creds);
  await client.send(new PostCommentForPullRequestCommand({
    pullRequestId: prId,
    repositoryName,
    beforeCommitId,
    afterCommitId,
    content,
    ...(filePath && lineNumber != null ? {
      location: { filePath, filePosition: lineNumber, relativeFileVersion: 'AFTER' as const },
    } : {}),
    clientRequestToken,
  }));
}

// ── Bitbucket provider helpers ────────────────────────────────────────────────

function parseBitbucketOwnerRepoFromUrl(url: string): { workspace: string; repoSlug: string } | null {
  const m = url.match(/bitbucket\.org[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:[/?#]|$)/);
  if (!m) return null;
  return { workspace: m[1], repoSlug: m[2] };
}

function findBitbucketCredsForUser(userId: string): { email: string; apiToken: string } | null {
  interface ConnRow { credentials_enc: string | null }
  const conns = all<ConnRow>(
    "SELECT credentials_enc FROM git_connections_v2 WHERE provider = 'bitbucket' AND (owner_id = ? OR scope = 'shared') ORDER BY created_at",
    userId,
  );
  for (const c of conns) {
    if (!c.credentials_enc) continue;
    try {
      const plain = decrypt(c.credentials_enc, config.secretKey);
      const creds = JSON.parse(plain) as Record<string, unknown>;
      if (typeof creds.email === 'string' && typeof creds.apiToken === 'string' && creds.apiToken) {
        return { email: creds.email, apiToken: creds.apiToken };
      }
    } catch { /* skip */ }
  }
  return null;
}

function bitbucketBasicAuthHeader(email: string, apiToken: string): string {
  return 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
}

async function _doBitbucketGetPrShas(
  workspace: string, repoSlug: string, prId: string,
  email: string, apiToken: string,
): Promise<{ sourceSha: string | null; destSha: string | null }> {
  const resp = await fetch(
    `https://api.bitbucket.org/2.0/repositories/${workspace}/${repoSlug}/pullrequests/${prId}`,
    {
      headers: { Authorization: bitbucketBasicAuthHeader(email, apiToken), Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!resp.ok) return { sourceSha: null, destSha: null };
  const data = await resp.json() as {
    source?: { commit?: { hash?: string } };
    destination?: { commit?: { hash?: string } };
  };
  return {
    sourceSha: data.source?.commit?.hash ?? null,
    destSha: data.destination?.commit?.hash ?? null,
  };
}

async function _doBitbucketMerge(
  workspace: string, repoSlug: string, prId: string,
  email: string, apiToken: string,
): Promise<void> {
  const resp = await fetch(
    `https://api.bitbucket.org/2.0/repositories/${workspace}/${repoSlug}/pullrequests/${prId}/merge`,
    {
      method: 'POST',
      headers: {
        Authorization: bitbucketBasicAuthHeader(email, apiToken),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'commit' }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (resp.status === 409) {
    const body = await resp.json().catch(() => ({})) as { error?: { message?: string } };
    throw new MergeConflictError(`Bitbucket merge conflict: ${body.error?.message ?? resp.statusText}`);
  }
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(`Bitbucket merge failed (${resp.status}): ${body.error?.message ?? resp.statusText}`);
  }
}

async function _doBitbucketPostComment(
  workspace: string, repoSlug: string, prId: string,
  content: string, filePath: string | null, lineNumber: number | null,
  email: string, apiToken: string,
): Promise<{ ok: boolean; status: number }> {
  const payload: Record<string, unknown> = {
    content: { raw: content },
  };
  if (filePath && lineNumber != null) {
    payload.inline = { to: lineNumber, path: filePath };
  }
  const resp = await fetch(
    `https://api.bitbucket.org/2.0/repositories/${workspace}/${repoSlug}/pullrequests/${prId}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: bitbucketBasicAuthHeader(email, apiToken),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    },
  );
  return { ok: resp.ok, status: resp.status };
}

/**
 * Test-injectable provider implementations.
 * Override these in tests to mock network calls.
 * Reset by re-assigning the default functions.
 */
export const _providers = {
  githubGetPrHead: _doGitHubGetPrHead,
  githubGetPrShas: _doGitHubGetPrShas,
  githubMerge: _doGitHubMerge as (
    owner: string, repo: string, prNumber: number, strategy: MergeStrategy, token: string, sha?: string | null,
  ) => Promise<GitHubMergeResult>,
  githubPostComment: _doGitHubPostComment as (
    owner: string, repo: string, prNumber: number,
    body: string, commitId: string, path: string | null, line: number | null, token: string,
  ) => Promise<{ ok: boolean; status: number }>,
  codecommitGetPrHead: _doCodeCommitGetPrHead,
  codecommitGetPrShas: _doCodeCommitGetPrShas,
  codecommitMerge: _doCodeCommitMerge,
  codecommitPostComment: _doCodeCommitPostComment,
  bitbucketGetPrShas: _doBitbucketGetPrShas,
  bitbucketMerge: _doBitbucketMerge,
  bitbucketPostComment: _doBitbucketPostComment,
};

// ── Credential lookup helpers ─────────────────────────────────────────────────

function parseGitHubOwnerRepo(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:[/?#]|$)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function parseCodeCommitRepoName(url: string): string | null {
  const match = url.match(/\/repos\/([^/?#]+)/);
  return match ? match[1] : null;
}

function findGitHubToken(userId: string): string | null {
  interface ConnRow { credentials_enc: string | null }
  const conns = all<ConnRow>(
    "SELECT credentials_enc FROM git_connections_v2 WHERE provider = 'github' AND (owner_id = ? OR scope = 'shared') ORDER BY created_at",
    userId,
  );
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

function findCodeCommitCreds(projectId: string, actorId: string): CodeCommitCreds | null {
  // 1. Check aws_accounts for any supported auth method
  interface AccRow { credentials_enc: string | null; region: string | null; auth_method: string; profile_name: string | null }
  const accounts = all<AccRow>(
    "SELECT credentials_enc, region, auth_method, profile_name FROM aws_accounts WHERE project_id = ? ORDER BY created_at",
    projectId,
  );
  for (const a of accounts) {
    const method = a.auth_method as CodeCommitCreds['authMethod'];
    const region = a.region ?? 'us-east-1';
    if (method === 'keys') {
      if (!a.credentials_enc) continue;
      try {
        const plain = decrypt(a.credentials_enc, config.secretKey);
        const creds = JSON.parse(plain) as Record<string, unknown>;
        if (typeof creds.accessKeyId === 'string' && typeof creds.secretAccessKey === 'string') {
          return { authMethod: 'keys', region, accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey };
        }
      } catch { /* skip */ }
    } else if (method === 'profile') {
      const profileName = a.profile_name ?? undefined;
      if (profileName) return { authMethod: 'profile', region, profileName };
    } else if (method === 'instance-role') {
      return { authMethod: 'instance-role', region };
    } else if (method === 'sso') {
      return { authMethod: 'sso', region, profileName: a.profile_name ?? undefined };
    }
  }

  // 2. Fall back to git_connections_v2 for provider=codecommit.
  //    Mirror findGitHubToken: only scope='shared' OR owner_id matches the acting user.
  //    Never use another user's personal connection.
  interface ConnRow { credentials_enc: string | null }
  const conns = all<ConnRow>(
    "SELECT credentials_enc FROM git_connections_v2 WHERE provider = 'codecommit' AND (owner_id = ? OR scope = 'shared') ORDER BY created_at",
    actorId,
  );
  for (const c of conns) {
    if (!c.credentials_enc) continue;
    try {
      const plain = decrypt(c.credentials_enc, config.secretKey);
      const creds = JSON.parse(plain) as Record<string, unknown>;
      const region = typeof creds.region === 'string' && creds.region ? creds.region : 'us-east-1';
      const mode = typeof creds.mode === 'string' ? creds.mode : 'keys';

      if (mode === 'keys' && typeof creds.accessKeyId === 'string' && typeof creds.secretAccessKey === 'string') {
        return { authMethod: 'keys', region, accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey };
      }
      if (mode === 'portal-sso') {
        return { authMethod: 'portal-sso', region };
      }
      if (mode === 'aws-account' && typeof creds.awsAccountId === 'string') {
        interface AccRow { credentials_enc: string | null; auth_method: string }
        const acc = one<AccRow>('SELECT credentials_enc, auth_method FROM aws_accounts WHERE id = ? LIMIT 1', creds.awsAccountId);
        if (acc && acc.auth_method === 'keys' && acc.credentials_enc) {
          try {
            const accPlain = decrypt(acc.credentials_enc, config.secretKey);
            const accCreds = JSON.parse(accPlain) as Record<string, unknown>;
            if (typeof accCreds.accessKeyId === 'string' && typeof accCreds.secretAccessKey === 'string') {
              return { authMethod: 'keys', region, accessKeyId: accCreds.accessKeyId, secretAccessKey: accCreds.secretAccessKey };
            }
          } catch { /* skip */ }
        }
        if (acc?.auth_method === 'instance-role') return { authMethod: 'instance-role', region };
      }
    } catch { /* skip */ }
  }

  return null;
}

// ── Review view helpers ───────────────────────────────────────────────────────

function addComputedFields(
  review: Review,
  findings: Pick<Finding, 'accepted' | 'severity'>[],
): Record<string, unknown> {
  const rateCard = getRateCard();
  const cost = computeCost(review, rateCard);
  const verdict = computeMergeVerdict(review, findings, getMergeThreshold());
  const jiraCtx = parseJson<JiraContext>(review.jira_context || '{}', { key: null, summary: null, description: null, source: 'none', reason: null });
  return {
    ...review,
    jira_context: jiraCtx,
    cost: { ...cost, label: 'estimated' },
    verdict,
  };
}

/**
 * Returns true when the request has the given scope, or is a browser session (all scopes allowed).
 * Handles the extended scope set: read | write | review | merge | tests.
 */
function hasTokenScope(req: PortalRequest, scope: string): boolean {
  if (!req.authViaToken) return true;
  return (req.tokenScopes ?? []).includes(scope);
}

function requireProjectAccess(req: PortalRequest, res: PortalResponse, projectId: string): boolean {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return false;
  }
  // S1-TODO(projects): requireProjectAccess is a sync helper called from many sync route handlers.
  // Converting all callers to async in this batch would touch 20+ routes across review.ts.
  // Leave on direct SQLite until the review module gets its own async conversion pass.
  const project = one<{ id: string }>('SELECT id FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return false;
  }
  if (req.user.is_admin) return true;
  const member = one<{ user_id: string; access: string }>(
    'SELECT user_id, access FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    req.user.id,
  );
  if (!member) {
    sendJson(res, 404, { error: 'Project not found' });
    return false;
  }
  return true;
}

function requireProjectEditor(req: PortalRequest, res: PortalResponse, projectId: string): boolean {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return false;
  }
  // S1-TODO(projects): requireProjectEditor is a sync helper called from many sync route handlers.
  // Converting all callers to async in this batch would touch 20+ routes across review.ts.
  // Leave on direct SQLite until the review module gets its own async conversion pass.
  if (req.user.is_admin) return true;
  const member = one<{ user_id: string; access: string }>(
    'SELECT user_id, access FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    req.user.id,
  );
  if (!member) {
    sendJson(res, 404, { error: 'Project not found' });
    return false;
  }
  if (!['editor', 'owner', 'admin'].includes(String(member.access))) {
    sendJson(res, 403, { error: 'Editor access required' });
    return false;
  }
  return true;
}

function requireAdmin(req: PortalRequest, res: PortalResponse): boolean {
  if (!req.user?.is_admin) {
    sendJson(res, 403, { error: 'Admin access required' });
    return false;
  }
  return true;
}

// ── Finding parsers (existing) ────────────────────────────────────────────────

function parseSeverity(raw: unknown): Severity {
  const s = String(raw ?? '').toLowerCase().trim();
  if (SEVERITIES.includes(s as Severity)) return s as Severity;
  return 'medium';
}

function parseFindingsFromText(text: string): Array<Partial<Finding>> {
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/i);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      const arr = Array.isArray(parsed) ? parsed : (parsed.findings ?? parsed.results ?? []);
      if (Array.isArray(arr)) return normalizeParsedFindings(arr);
    } catch { /* fall through */ }
  }
  const jsonObjMatch = text.match(/\{[\s\S]*"findings"\s*:\s*\[[\s\S]*?\][\s\S]*\}/);
  if (jsonObjMatch) {
    try {
      const parsed = JSON.parse(jsonObjMatch[0]);
      if (Array.isArray(parsed.findings)) return normalizeParsedFindings(parsed.findings);
    } catch { /* fall through */ }
  }
  const jsonArrMatch = text.match(/\[\s*\{[\s\S]*?\}\s*\]/);
  if (jsonArrMatch) {
    try {
      const arr = JSON.parse(jsonArrMatch[0]);
      if (Array.isArray(arr)) return normalizeParsedFindings(arr);
    } catch { /* fall through */ }
  }
  return parseFindingsFromMarkdown(text);
}

function normalizeParsedFindings(arr: unknown[]): Array<Partial<Finding>> {
  return arr.map((item: unknown) => {
    const f = item as Record<string, unknown>;
    return {
      file_path: String(f.file ?? f.file_path ?? f.path ?? '').trim(),
      line_number: f.line != null ? (Number.isFinite(Number(f.line)) ? Number(f.line) : null) : null,
      severity: parseSeverity(f.severity),
      title: String(f.title ?? f.message ?? f.category ?? 'Finding').slice(0, 200),
      body: String(f.body ?? f.description ?? f.message ?? '').slice(0, 2000),
      confidence: f.confidence != null ? Math.min(1, Math.max(0, Number(f.confidence))) : null,
    };
  }).filter((f) => f.file_path || f.body);
}

function parseFindingsFromMarkdown(text: string): Array<Partial<Finding>> {
  const findings: Array<Partial<Finding>> = [];
  const rowRe = /^\|(.+)\|$/gm;
  let match: RegExpExecArray | null;
  const rows: string[][] = [];
  while ((match = rowRe.exec(text)) !== null) {
    const cols = match[1].split('|').map((c) => c.trim());
    if (cols.every((c) => /^[-: ]+$/.test(c))) continue;
    rows.push(cols);
  }
  if (rows.length < 2) return findings;
  const headers = rows[0].map((h) => h.toLowerCase().replace(/[^a-z_]/g, ''));
  for (const row of rows.slice(1)) {
    const f: Record<string, string> = {};
    headers.forEach((h, i) => { if (row[i] !== undefined) f[h] = row[i]; });
    const fp = f.filepath ?? f.file ?? f.filename ?? '';
    const body = f.body ?? f.description ?? f.message ?? f.details ?? '';
    if (!fp && !body) continue;
    findings.push({
      file_path: fp.slice(0, 500),
      line_number: f.line != null && Number.isFinite(Number(f.line)) ? Number(f.line) : null,
      severity: parseSeverity(f.severity),
      title: (f.title ?? f.category ?? f.rule ?? 'Finding').slice(0, 200),
      body: body.slice(0, 2000),
      confidence: null,
    });
  }
  return findings;
}

function deduplicateFindings(incoming: Array<Partial<Finding>>, existingKey: Set<string>): Array<Partial<Finding>> {
  const result: Array<Partial<Finding>> = [];
  for (const f of incoming) {
    const key = `${f.file_path ?? ''}|${f.line_number ?? ''}|${(f.body ?? '').toLowerCase().trim().slice(0, 100)}`;
    if (existingKey.has(key)) continue;
    existingKey.add(key);
    result.push(f);
  }
  return result;
}

export function processReviewOutput(reviewId: string, workDir?: string): number {
  const review = one<Review>('SELECT * FROM p10_reviews WHERE id = ?', reviewId);
  if (!review) return 0;

  // Prefer raw_output (full untruncated transcript) over summary (bounded display text)
  // for finding extraction. raw_output is populated by review-lifecycle.ts after a run.
  let text = review.raw_output ?? review.summary ?? '';

  if (workDir) {
    const candidateFiles = ['findings.json', 'findings.md', 'review.json', 'review.md', 'output.json', 'output.md'];
    for (const fname of candidateFiles) {
      const fpath = path.join(workDir, fname);
      try {
        if (fs.existsSync(fpath)) {
          text += '\n' + fs.readFileSync(fpath, 'utf8');
        }
      } catch { /* skip */ }
    }
  }

  const parsed = parseFindingsFromText(text);

  const existing = all<Finding>('SELECT file_path, line_number, body FROM p10_findings WHERE review_id = ?', reviewId);
  const existingKeys = new Set(
    existing.map((f) => `${f.file_path}|${f.line_number ?? ''}|${(f.body ?? '').toLowerCase().trim().slice(0, 100)}`),
  );

  const toInsert = deduplicateFindings(parsed, existingKeys);
  const ts = now();
  for (const f of toInsert) {
    if (!f.file_path && !f.body) continue;
    insert('p10_findings', {
      id: newId('f_'),
      review_id: reviewId,
      file_path: f.file_path ?? '',
      line_number: f.line_number ?? null,
      severity: f.severity ?? 'medium',
      title: f.title ?? 'Finding',
      body: f.body ?? '',
      confidence: f.confidence ?? null,
      accepted: 0,
      posted_at: null,
      created_at: ts,
    });
  }

  return toInsert.length;
}

// ── Dashboard period helper ───────────────────────────────────────────────────

function dashboardPeriodToSince(period: string): string {
  const n = new Date();
  if (period === 'today') {
    const d = new Date(n);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }
  const days = Number(period);
  if (Number.isFinite(days) && days > 0) {
    return new Date(n.getTime() - days * 86_400_000).toISOString();
  }
  return new Date(n.getTime() - 30 * 86_400_000).toISOString();
}

// ── Safe filename ─────────────────────────────────────────────────────────────

function safeFilename(s: string): string {
  return s.replace(/[^a-z0-9._-]/gi, '_').slice(0, 80);
}

// ── Auto-post head-moved check (shared between /post and triggerAutoPost) ──────

/**
 * Check whether auto-post should be skipped for a review because the PR head
 * has moved since the review ran.
 *
 * First tries a live provider lookup (preferred). If the provider is unreachable
 * or no credentials are found, falls back to the static head_commit_sha guard
 * (only catches the case where the client explicitly set headCommitSha different
 * from sourceSha at creation time).
 *
 * Returns { skip: true, reason } when auto-post should be skipped.
 */
async function checkAutoPostShouldSkip(
  review: Review,
  actorId: string,
): Promise<{ skip: boolean; reason?: string }> {
  if (review.source_sha && review.repo_id && review.pr_number != null) {
    try {
      const repo = one<{ url: string; provider: string }>(
        'SELECT url, provider FROM repositories WHERE id = ?',
        review.repo_id,
      );
      if (repo) {
        let currentHead: string | null = null;
        if (repo.provider === 'github') {
          const ownerRepo = parseGitHubOwnerRepo(repo.url);
          const token = findGitHubToken(actorId);
          if (ownerRepo && token) {
            currentHead = await _providers.githubGetPrHead(ownerRepo.owner, ownerRepo.repo, review.pr_number, token);
          }
        } else if (repo.provider === 'codecommit') {
          const creds = findCodeCommitCreds(review.project_id ?? '', actorId);
          const repoName = parseCodeCommitRepoName(repo.url);
          if (creds && repoName) {
            currentHead = await _providers.codecommitGetPrHead(repoName, String(review.pr_number), creds);
          }
        }
        if (currentHead !== null && currentHead !== review.source_sha) {
          return { skip: true, reason: 'Skipped: PR head moved since review ran' };
        }
      }
    } catch { /* fall through to static check */ }
  }

  // Static fallback: head_commit_sha differs from source_sha (explicitly set by caller
  // when creating the review, e.g. if the head moved between review start and finish).
  if (review.source_sha && review.head_commit_sha && review.source_sha !== review.head_commit_sha) {
    return { skip: true, reason: 'Skipped: PR head moved during review' };
  }

  return { skip: false };
}

// ── Auto-post trigger (exported for lifecycle hooks) ─────────────────────────

/**
 * Auto-post eligible findings for a completed review.
 * Uses the review's created_by as the actor for credential lookup.
 * Applies the same dedupe rules as the /post route.
 */
export async function triggerAutoPost(reviewId: string, _projectId?: string): Promise<{ posted: number; skipped: number }> {
  const review = await getReviewsRepository().getById(reviewId);
  if (!review || review.status !== 'done') return { posted: 0, skipped: 0 };
  // Auto-post when either the review-level mode is 'auto' OR the global prCommentMode is 'automatic'.
  if (review.post_mode !== 'auto' && getPrCommentMode() !== 'automatic') return { posted: 0, skipped: 0 };

  const actorId = review.created_by ?? '';

  // Skip if already posted for this PR revision
  if (review.source_sha && review.repo_id && review.pr_number != null) {
    const alreadyPosted = await getReviewsRepository().checkAlreadyPosted(review.repo_id, review.pr_number, review.source_sha, review.id);
    if (alreadyPosted) return { posted: 0, skipped: 0 };
  }

  const minSevRank = SEVERITIES.indexOf(review.min_severity as Severity);
  const findings = await getReviewsRepository().listFindings(review.id);
  const activeFindings = findings.filter((f) => f.accepted !== -1);
  const toPost = activeFindings.filter((f) => {
    if (f.posted_at) return false;
    if (f.accepted === 1) return true;
    return SEVERITIES.indexOf(f.severity as Severity) <= minSevRank;
  });

  if (toPost.length === 0) return { posted: 0, skipped: activeFindings.length };

  const ts = now();
  const repo = review.repo_id
    ? one<{ url: string; provider: string }>('SELECT url, provider FROM repositories WHERE id = ?', review.repo_id)
    : null;

  if (!repo || !review.source_sha || review.pr_number == null) {
    return { posted: 0, skipped: toPost.length };
  }

  // Use the shared helper to check if the PR head has moved since the review ran.
  const skipCheck = await checkAutoPostShouldSkip(review as unknown as Review, actorId);
  if (skipCheck.skip) {
    return { posted: 0, skipped: toPost.length };
  }

  if (repo.provider === 'github') {
    const ownerRepo = parseGitHubOwnerRepo(repo.url);
    const token = findGitHubToken(actorId);
    if (!ownerRepo || !token) return { posted: 0, skipped: toPost.length };
    let postedCount = 0;
    for (const f of toPost) {
      try {
        const result = await _providers.githubPostComment(
          ownerRepo.owner, ownerRepo.repo, review.pr_number,
          `**[${f.severity.toUpperCase()}] ${f.title}**\n\n${f.body}`,
          review.source_sha, f.file_path || null, f.line_number, token,
        );
        if (result.ok) {
          await getReviewsRepository().markFindingPosted(f.id, ts);
          postedCount++;
        }
      } catch { /* best-effort */ }
    }
    return { posted: postedCount, skipped: activeFindings.length - postedCount };
  }

  if (repo.provider === 'codecommit' && review.dest_sha) {
    const creds = findCodeCommitCreds(review.project_id ?? '', actorId);
    const repoName = parseCodeCommitRepoName(repo.url);
    if (!creds || !repoName) return { posted: 0, skipped: toPost.length };
    let postedCount = 0;
    for (const f of toPost) {
      try {
        await _providers.codecommitPostComment(
          repoName, String(review.pr_number),
          review.dest_sha, review.source_sha,
          `**[${f.severity.toUpperCase()}] ${f.title}**\n\n${f.body}`,
          f.file_path || null, f.line_number, f.id, creds,
        );
        await getReviewsRepository().markFindingPosted(f.id, ts);
        postedCount++;
      } catch { /* best-effort */ }
    }
    return { posted: postedCount, skipped: activeFindings.length - postedCount };
  }

  return { posted: 0, skipped: toPost.length };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerReviewRoutes(): void {

  // ── GET /api/settings/review ──────────────────────────────────────────────
  router.get('/api/settings/review', requireAuth((req: PortalRequest, res: PortalResponse): void => {
    sendJson(res, 200, {
      mergeThreshold: getMergeThreshold(),
      rateCard: getRateCard(),
      prCommentMode: getPrCommentMode(),
    });
  }));

  // ── PUT /api/settings/review (admin only) ─────────────────────────────────
  router.put('/api/settings/review', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireAdmin(req, res)) return;

    const body = req.body as Record<string, unknown>;
    const db = getDb();

    if (body.mergeThreshold !== undefined) {
      const v = String(body.mergeThreshold);
      if (!MERGE_THRESHOLDS.includes(v as MergeThreshold)) {
        sendJson(res, 400, { error: `mergeThreshold must be one of: ${MERGE_THRESHOLDS.join(', ')}` });
        return;
      }
      await setSetting(db, 'review.mergeThreshold', JSON.stringify(v));
    }

    if (body.rateCard !== undefined && typeof body.rateCard === 'object') {
      const rc = body.rateCard as Record<string, unknown>;
      const current = getRateCard();
      const updated: RateCard = { ...current };
      for (const key of ['inputUsd', 'outputUsd', 'cacheWriteUsd', 'cacheReadUsd'] as const) {
        if (rc[key] !== undefined) {
          const v = Number(rc[key]);
          if (!Number.isFinite(v) || v < 0) {
            sendJson(res, 400, { error: `rateCard.${key} must be a non-negative number` });
            return;
          }
          updated[key] = v;
        }
      }
      await setSetting(db, 'review.rateCard', JSON.stringify(updated));
    }

    if (body.prCommentMode !== undefined) {
      const v = String(body.prCommentMode);
      if (v !== 'manual' && v !== 'automatic') {
        sendJson(res, 400, { error: 'prCommentMode must be "manual" or "automatic"' });
        return;
      }
      await setSetting(db, 'review.prCommentMode', JSON.stringify(v));
    }

    sendJson(res, 200, {
      mergeThreshold: getMergeThreshold(),
      rateCard: getRateCard(),
      prCommentMode: getPrCommentMode(),
    });
  }));

  // ── GET /api/reviews/dashboard (R3) ──────────────────────────────────────
  router.get('/api/reviews/dashboard', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const period = req.query.get('period') ?? '30';
    if (!['today', '7', '30', '90'].includes(period)) {
      sendJson(res, 400, { error: 'period must be today, 7, 30, or 90' });
      return;
    }
    const since = dashboardPeriodToSince(period);
    const isAdmin = Boolean(req.user!.is_admin);
    const userId = req.user!.id;

    let projectIds: string[];
    if (isAdmin) {
      // S1-TODO(projects): This query should use getProjectRepository().listProjects() once
      // the route handler is converted to async. Leaving on direct SQLite for now because
      // the surrounding review lifecycle handler is sync.
      projectIds = all<{ id: string }>('SELECT id FROM projects WHERE archived = 0').map((r) => r.id);
    } else {
      // S1-TODO(projects): This query should use getProjectRepository().listMyProjects(userId) once
      // the route handler is converted to async. Leaving on direct SQLite for now because
      // the surrounding review lifecycle handler is sync.
      projectIds = all<{ project_id: string }>(
        'SELECT project_id FROM project_members WHERE user_id = ?',
        userId,
      ).map((r) => r.project_id);
    }

    if (projectIds.length === 0) {
      sendJson(res, 200, {
        period,
        since,
        totalEstimatedUsd: 0,
        totalCacheSavedUsd: 0,
        reviews: { total: 0, completed: 0, failed: 0 },
        pullRequests: { count: 0, mergedViaPortal: 0, distinctPeople: 0 },
        tokens: { input: 0, output: 0 },
        recentReviews: [],
      });
      return;
    }

    const reviews = await getReviewsRepository().listByProjectIds(projectIds, since);

    const rateCard = getRateCard();
    let totalEstimatedUsd = 0;
    let totalCacheSavedUsd = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let completedCount = 0;
    let failedCount = 0;
    let mergedViaPortal = 0;
    const prSet = new Set<string>();
    const peopleSet = new Set<string>();

    for (const r of reviews) {
      const { estimatedUsd, cacheSavedUsd } = computeCost(r, rateCard);
      totalEstimatedUsd += estimatedUsd;
      totalCacheSavedUsd += cacheSavedUsd;
      totalInputTokens += (r.input_tokens ?? 0) + (r.cache_read_tokens ?? 0);
      totalOutputTokens += r.output_tokens ?? 0;
      if (r.status === 'done') completedCount++;
      if (r.status === 'failed') failedCount++;
      if (r.merged_at) mergedViaPortal++;
      if (r.pr_number != null && r.repo_id) prSet.add(`${r.repo_id}:${r.pr_number}`);
      if (r.created_by) peopleSet.add(r.created_by);
    }

    const recentReviews = await Promise.all(reviews.slice(0, 20).map(async (r) => {
      const findings = await getReviewsRepository().listFindings(r.id);
      const verdict = computeMergeVerdict(r as unknown as Review, findings as unknown as Array<Pick<Finding, 'accepted' | 'severity'>>, getMergeThreshold());
      const { estimatedUsd } = computeCost(r as unknown as Review, rateCard);
      const repoName = r.repo_id
        ? one<{ name: string }>('SELECT name FROM repositories WHERE id = ?', r.repo_id)?.name ?? null
        : null;
      return {
        id: r.id, project_id: r.project_id, base_ref: r.base_ref, head_ref: r.head_ref,
        pr_number: r.pr_number, repo_id: r.repo_id, repo_name: repoName, status: r.status,
        finding_count: findings.length, verdict: verdict.verdict, estimatedUsd,
        merged_at: r.merged_at, created_at: r.created_at,
      };
    }));

    sendJson(res, 200, {
      period,
      since,
      totalEstimatedUsd,
      totalCacheSavedUsd,
      reviews: { total: reviews.length, completed: completedCount, failed: failedCount },
      pullRequests: { count: prSet.size, mergedViaPortal, distinctPeople: peopleSet.size },
      tokens: { input: totalInputTokens, output: totalOutputTokens },
      recentReviews,
    });
  }));

  // ── GET /api/projects/:id/reviews ─────────────────────────────────────────
  router.get('/api/projects/:id/reviews', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const q = req.query;
    const runBy = q.get('runBy') ?? 'everyone';
    const account = q.get('account');    // filter by provider_id
    const status = q.get('status');
    const type = q.get('type');          // 'pr' | 'scan'
    const repoId = q.get('repository');
    const dateFrom = q.get('dateFrom');
    const dateTo = q.get('dateTo');
    const search = q.get('q');
    const page = Math.max(1, parseInt(q.get('page') ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.get('limit') ?? '20', 10)));
    const offset = (page - 1) * limit;

    const conditions: string[] = ['r.project_id = ?'];
    const params: (string | number | null)[] = [req.params.id];

    if (runBy === 'me') {
      conditions.push('r.created_by = ?');
      params.push(req.user!.id);
    } else if (runBy !== 'everyone') {
      conditions.push('r.created_by = ?');
      params.push(runBy);
    }

    if (account) {
      conditions.push('r.provider_id = ?');
      params.push(account);
    }

    if (status) {
      conditions.push('r.status = ?');
      params.push(status);
    }

    if (type === 'pr') {
      conditions.push('r.pr_number IS NOT NULL AND r.scan_id IS NULL');
    } else if (type === 'scan') {
      conditions.push('r.scan_id IS NOT NULL');
    }

    if (repoId) {
      conditions.push('r.repo_id = ?');
      params.push(repoId);
    }

    if (dateFrom) {
      conditions.push('r.created_at >= ?');
      params.push(dateFrom);
    }

    if (dateTo) {
      conditions.push('r.created_at <= ?');
      params.push(dateTo);
    }

    if (search) {
      conditions.push("(r.head_ref LIKE ? OR r.base_ref LIKE ? OR r.summary LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const where = conditions.join(' AND ');

    const total = (one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM p10_reviews r WHERE ${where}`,
      ...params,
    ) ?? { n: 0 }).n;

    type ReviewListRow = Omit<Review, 'run_log' | 'raw_output'> & { finding_count?: number; repo_name?: string };
    const reviews = all<ReviewListRow>(
      `SELECT
         r.id, r.project_id, r.base_ref, r.head_ref, r.pr_number, r.repo_id,
         r.status, r.post_mode, r.from_loop, r.workflow_id, r.min_severity,
         r.summary, r.created_by, r.created_at, r.parent_review_id, r.source_sha,
         r.dest_sha, r.provider_id, r.model_id, r.jira_context,
         r.input_tokens, r.cache_write_tokens, r.cache_read_tokens, r.output_tokens,
         r.llm_requests, r.retry_count, r.tool_calls, r.files_reviewed,
         r.duration_ms, r.started_at, r.merged_at, r.merged_by, r.head_commit_sha,
         (SELECT COUNT(*) FROM p10_findings f WHERE f.review_id = r.id) AS finding_count,
         repos.name AS repo_name
       FROM p10_reviews r
       LEFT JOIN repositories repos ON repos.id = r.repo_id
       WHERE ${where}
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );

    sendJson(res, 200, { reviews, total, page, limit });
  });

  // ── POST /api/projects/:id/reviews ────────────────────────────────────────
  router.post('/api/projects/:id/reviews', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'review')) { sendJson(res, 403, { error: 'review scope required' }); return; }
    if (!requireProjectEditor(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const repoId = body.repoId != null ? String(body.repoId) : null;
    const baseRef = String(body.baseRef ?? '').trim();
    const headRef = String(body.headRef ?? '').trim();

    if (!baseRef) { sendJson(res, 400, { error: 'baseRef is required' }); return; }
    if (!headRef) { sendJson(res, 400, { error: 'headRef is required' }); return; }

    if (repoId) {
      const repo = one<{ id: string; project_id: string }>(
        'SELECT id, project_id FROM repositories WHERE id = ?',
        repoId,
      );
      if (!repo || repo.project_id !== req.params.id) {
        sendJson(res, 400, { error: 'That repository belongs to another project' });
        return;
      }
    }

    const prNumber = body.prNumber != null ? Number(body.prNumber) : null;
    const postMode = body.postMode === 'auto'
      ? 'auto'
      : (body.postMode === 'draft' ? 'draft' : (getPrCommentMode() === 'automatic' ? 'auto' : 'draft'));
    const minSeverity = SEVERITIES.includes(body.minSeverity as Severity) ? String(body.minSeverity) : 'medium';
    const sourceSha = body.sourceSha != null ? String(body.sourceSha).slice(0, 64) : null;
    const destSha = body.destSha != null ? String(body.destSha).slice(0, 64) : null;
    const headCommitSha = body.headCommitSha != null ? String(body.headCommitSha).slice(0, 64) : sourceSha;
    const providerId = body.providerId != null ? String(body.providerId).slice(0, 100) : null;
    const modelId = body.modelId != null ? String(body.modelId).slice(0, 200) : null;
    const explicitJiraKey = body.jiraKey != null ? String(body.jiraKey).slice(0, 50) : null;

    const jiraCtx = await resolveJiraContext(req.params.id, headRef, explicitJiraKey);

    // Item 4: If the client didn't supply sourceSha or destSha, attempt to resolve
    // both from the provider so portal-created reviews always have both commit SHAs.
    let resolvedSourceSha = sourceSha;
    let resolvedDestSha = destSha;
    if ((!resolvedSourceSha || !resolvedDestSha) && repoId && prNumber != null) {
      try {
        const repoRow = one<{ url: string; provider: string }>('SELECT url, provider FROM repositories WHERE id = ?', repoId);
        if (repoRow?.provider === 'github') {
          const ownerRepo = parseGitHubOwnerRepo(repoRow.url);
          const ghToken = findGitHubToken(req.user!.id);
          if (ownerRepo && ghToken) {
            const shas = await _providers.githubGetPrShas(ownerRepo.owner, ownerRepo.repo, prNumber, ghToken);
            if (!resolvedSourceSha && shas.sourceSha) resolvedSourceSha = shas.sourceSha.slice(0, 64);
            if (!resolvedDestSha && shas.destSha) resolvedDestSha = shas.destSha.slice(0, 64);
          }
        } else if (repoRow?.provider === 'codecommit') {
          const ccCreds = findCodeCommitCreds(req.params.id, req.user!.id);
          const ccRepoName = parseCodeCommitRepoName(repoRow.url);
          if (ccCreds && ccRepoName) {
            const shas = await _providers.codecommitGetPrShas(ccRepoName, String(prNumber), ccCreds);
            if (!resolvedSourceSha && shas.sourceSha) resolvedSourceSha = shas.sourceSha.slice(0, 64);
            if (!resolvedDestSha && shas.destSha) resolvedDestSha = shas.destSha.slice(0, 64);
          }
        }
      } catch { /* best-effort: leave as null if provider lookup fails */ }
    }

    let goal = `Code review: ${baseRef} → ${headRef}${prNumber ? ` (PR #${prNumber})` : ''}`;
    if (jiraCtx.summary) {
      goal += `\n\nJira ticket: ${jiraCtx.key} — ${jiraCtx.summary}`;
      if (jiraCtx.description) goal += `\n\nBackground: ${jiraCtx.description.slice(0, 1000)}`;
    }

    let workflowId: string | null = null;
    try {
      const wid = generateId();
      const ts0 = now();
      // Choose engine based on providerId or portal provider setting.
      // 'litellm' → uses the LiteLLM review engine (runner.ts dispatches to runLiteLLM).
      // Other provider modes → engine that matches (anthropic/bedrock → claude-code,
      // kiro → kiro, demo → demo).
      const portalMode = getSettings().provider.mode;
      const effectiveProvider = providerId ?? portalMode;
      const reviewEngine =
        effectiveProvider === 'litellm' ? 'litellm'
        : (effectiveProvider === 'anthropic' || effectiveProvider === 'bedrock') ? 'claude-code'
        : effectiveProvider === 'kiro' ? 'kiro'
        : 'demo';
      insert('p6_workflows', {
        id: wid,
        project_id: req.params.id,
        goal,
        status: 'pending',
        engine: reviewEngine,
        trust_tools: 0,
        lead_agent: body.leadAgent != null ? String(body.leadAgent) : null,
        workspace_id: null,
        output_files_enabled: 0,
        repo_ids: repoId ? JSON.stringify([repoId]) : '[]',
        iteration_count: 0,
        max_iterations: 1,
        kind: 'review',
        created_by: req.user!.id,
        created_at: ts0,
        updated_at: ts0,
      });
      workflowId = wid;
      emit(req.params.id, { type: 'workflow.created', workflowId: wid });
    } catch { /* continue without workflow */ }

    const id = generateId();
    const ts = now();

    const review = await getReviewsRepository().create({
      id, project_id: req.params.id, base_ref: baseRef, head_ref: headRef,
      pr_number: prNumber, repo_id: repoId, status: 'pending', post_mode: postMode,
      from_loop: null, workflow_id: workflowId, min_severity: minSeverity,
      summary: null, raw_output: null, created_by: req.user!.id, created_at: ts,
      parent_review_id: null, source_sha: resolvedSourceSha, dest_sha: resolvedDestSha,
      head_commit_sha: headCommitSha ?? resolvedSourceSha,
      provider_id: providerId, model_id: modelId, jira_context: JSON.stringify(jiraCtx),
      run_log: '[]', input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0,
      output_tokens: 0, llm_requests: 0, retry_count: 0, tool_calls: 0,
      files_reviewed: 0, duration_ms: null, started_at: null,
      merged_at: null, merged_by: null,
    });

    sendJson(res, 201, { review });
  });

  // ── GET /api/projects/:id/reviews/:rid ────────────────────────────────────
  router.get('/api/projects/:id/reviews/:rid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const review = await getReviewsRepository().getById(req.params.rid);
    if (!review || review.project_id !== req.params.id) { sendJson(res, 404, { error: 'Review not found' }); return; }

    const findings = await getReviewsRepository().listFindings(review.id);
    const sorted = [...findings].sort((a, b) => {
      const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      const sa = severityOrder[a.severity] ?? 4;
      const sb = severityOrder[b.severity] ?? 4;
      if (sa !== sb) return sa - sb;
      return a.file_path.localeCompare(b.file_path);
    });

    const reviewOut = addComputedFields(review as unknown as Review, sorted as unknown as Array<Pick<Finding, 'accepted' | 'severity'>>);
    sendJson(res, 200, { review: reviewOut, findings: sorted });
  });

  // ── DELETE /api/projects/:id/reviews/:rid ─────────────────────────────────
  router.delete('/api/projects/:id/reviews/:rid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireProjectEditor(req, res, req.params.id)) return;

    const review = await getReviewsRepository().getById(req.params.rid);
    if (!review || review.project_id !== req.params.id) { sendJson(res, 404, { error: 'Review not found' }); return; }
    if (review.status === 'running') {
      sendJson(res, 400, { error: 'Wait for the review to finish before deleting it' });
      return;
    }

    await getReviewsRepository().delete(review.id, req.params.id);
    sendJson(res, 200, { ok: true });
  });

  // ── GET /api/projects/:id/reviews/:rid/findings ───────────────────────────
  router.get('/api/projects/:id/reviews/:rid/findings', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const review = await getReviewsRepository().getById(req.params.rid);
    if (!review || review.project_id !== req.params.id) { sendJson(res, 404, { error: 'Review not found' }); return; }

    const findings = await getReviewsRepository().listFindings(review.id);
    sendJson(res, 200, { findings });
  });

  // ── PUT /api/projects/:id/reviews/:rid/findings/:fid ─────────────────────
  router.put('/api/projects/:id/reviews/:rid/findings/:fid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireProjectEditor(req, res, req.params.id)) return;

    const review = await getReviewsRepository().getById(req.params.rid);
    if (!review || review.project_id !== req.params.id) { sendJson(res, 404, { error: 'Review not found' }); return; }

    const finding = await getReviewsRepository().getFindingById(req.params.fid, review.id);
    if (!finding) { sendJson(res, 404, { error: 'Finding not found' }); return; }

    const body = req.body as Record<string, unknown>;
    const accepted = Number(body.accepted);
    if (accepted !== 1 && accepted !== -1 && accepted !== 0) {
      sendJson(res, 400, { error: 'accepted must be 1 (accept), -1 (dismiss), or 0 (pending)' });
      return;
    }

    await getReviewsRepository().updateFinding(finding.id, { accepted, review_id: review.id });
    const updated = await getReviewsRepository().getFindingById(finding.id, review.id);
    sendJson(res, 200, { finding: updated, ok: true });
  });

  // ── POST /api/projects/:id/reviews/:rid/post ──────────────────────────────
  router.post('/api/projects/:id/reviews/:rid/post', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'review')) { sendJson(res, 403, { error: 'review scope required' }); return; }
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    if (!req.user.is_admin) {
      // S1-TODO(projects): This membership check should use getProjectRepository().isMember() once
      // this route handler is converted to async. Leaving on direct SQLite for now.
      const member = one<{ access: string }>(
        'SELECT access FROM project_members WHERE project_id = ? AND user_id = ?',
        req.params.id,
        req.user.id,
      );
      if (!member || !['owner', 'admin', 'editor'].includes(member.access)) {
        sendJson(res, 403, { error: 'Editor or admin access required to post findings' });
        return;
      }
    }

    const review = await getReviewsRepository().getById(req.params.rid);
    if (!review || review.project_id !== req.params.id) { sendJson(res, 404, { error: 'Review not found' }); return; }
    if (review.status !== 'done') {
      sendJson(res, 400, { error: 'Wait for the review to finish before posting' });
      return;
    }

    const isAutoMode = review.post_mode === 'auto';

    // R2: Auto-post dedupe + live head check
    if (isAutoMode) {
      const skipCheck = await checkAutoPostShouldSkip(review as unknown as Review, req.user!.id);
      if (skipCheck.skip) {
        sendJson(res, 200, { posted: 0, skipped: 0, message: skipCheck.reason ?? 'Skipped', autoSkipped: true });
        return;
      }

      // If another review for the same (repo, pr, source_sha) already posted, skip
      if (review.source_sha && review.repo_id && review.pr_number != null) {
        const alreadyPosted = await getReviewsRepository().checkAlreadyPosted(review.repo_id, review.pr_number, review.source_sha, review.id);
        if (alreadyPosted) {
          sendJson(res, 200, { posted: 0, skipped: 0, message: 'Skipped: already posted for this PR revision', autoSkipped: true });
          return;
        }
      }
    }

    const minSevRank = SEVERITIES.indexOf(review.min_severity as Severity);
    const findings = await getReviewsRepository().listFindings(review.id);
    const activeFindings = findings.filter((f) => f.accepted !== -1);

    // For manual mode: deduplicate findings already posted
    const toPost = activeFindings.filter((f) => {
      if (f.posted_at) return false;
      if (f.accepted === 1) return true;
      const rank = SEVERITIES.indexOf(f.severity as Severity);
      return rank <= minSevRank;
    });

    const skipped = activeFindings.length - toPost.length;
    const ts = now();

    // If there is nothing to post, skip all provider interaction
    if (toPost.length === 0) {
      sendJson(res, 200, {
        posted: 0,
        skipped,
        message: 'Nothing to post',
      });
      return;
    }

    // Load the repo now — we definitely need it
    const repo = review.repo_id ? one<{ url: string; provider: string }>('SELECT url, provider FROM repositories WHERE id = ?', review.repo_id) : null;

    if (!repo) {
      sendJson(res, 400, { error: 'Review has no associated repository', reason: 'no_repository' });
      return;
    }
    if (review.pr_number == null) {
      sendJson(res, 400, { error: 'Review has no PR number', reason: 'missing_pr_number' });
      return;
    }

    // ── CodeCommit ───────────────────────────────────────────────────────────
    if (repo.provider === 'codecommit') {
      if (!review.source_sha || !review.dest_sha) {
        sendJson(res, 400, { error: 'Cannot post: review is missing source or destination SHA', reason: 'missing_sha' });
        return;
      }
      const creds = findCodeCommitCreds(req.params.id, req.user!.id);
      if (!creds) {
        sendJson(res, 400, { error: 'No AWS credentials found for CodeCommit. Add an AWS account or a shared CodeCommit git connection.', reason: 'no_credentials' });
        return;
      }
      const repoName = parseCodeCommitRepoName(repo.url);
      if (!repoName) {
        sendJson(res, 400, { error: 'Cannot parse CodeCommit repository name from URL', reason: 'bad_url' });
        return;
      }

      const postFailures: Array<{ findingId: string; status: number }> = [];
      for (const f of toPost) {
        try {
          await _providers.codecommitPostComment(
            repoName,
            String(review.pr_number),
            review.dest_sha,
            review.source_sha,
            `**[${f.severity.toUpperCase()}] ${f.title}**\n\n${f.body}`,
            f.file_path || null,
            f.line_number,
            f.id,
            creds,
          );
          // Only stamp posted_at if the provider accepted the comment
          run('UPDATE p10_findings SET posted_at = ? WHERE id = ?', ts, f.id);
        } catch {
          postFailures.push({ findingId: f.id, status: 0 });
        }
      }

      const postedCount = toPost.length - postFailures.length;

      if (postFailures.length > 0) {
        sendJson(res, 207, {
          posted: postedCount,
          skipped,
          failed: postFailures.length,
          failures: postFailures,
          message: `${postFailures.length} finding(s) failed to post to CodeCommit`,
        });
        return;
      }

      // Best-effort summary comment
      try {
        const summaryBody = `## Code Review Summary\n\n${postedCount} finding(s) posted.\n\n${toPost.map((f) => `- **[${f.severity.toUpperCase()}]** ${f.file_path}:${f.line_number ?? '?'} — ${f.title}`).join('\n')}`;
        await _providers.codecommitPostComment(
          repoName, String(review.pr_number),
          review.dest_sha, review.source_sha,
          summaryBody, null, null, `summary-${review.id}`, creds,
        );
      } catch { /* best-effort */ }

      sendJson(res, 200, {
        posted: postedCount,
        skipped,
        message: `Posted ${postedCount} finding${postedCount === 1 ? '' : 's'}`,
      });
      return;
    }

    // ── GitHub ───────────────────────────────────────────────────────────────
    if (repo.provider === 'github') {
      if (!review.source_sha) {
        sendJson(res, 400, { error: 'Cannot post: review is missing source SHA', reason: 'missing_sha' });
        return;
      }
      const ownerRepo = parseGitHubOwnerRepo(repo.url);
      if (!ownerRepo) {
        sendJson(res, 400, { error: 'Cannot parse GitHub owner/repo from URL', reason: 'bad_url' });
        return;
      }
      const token = findGitHubToken(req.user!.id);
      if (!token) {
        sendJson(res, 400, { error: 'No GitHub credentials found. Add a GitHub git connection.', reason: 'no_credentials' });
        return;
      }

      const postFailures: Array<{ findingId: string; status: number }> = [];
      for (const f of toPost) {
        try {
          const result = await _providers.githubPostComment(
            ownerRepo.owner, ownerRepo.repo, review.pr_number,
            `**[${f.severity.toUpperCase()}] ${f.title}**\n\n${f.body}`,
            review.source_sha,
            f.file_path || null,
            f.line_number,
            token,
          );
          if (result.ok) {
            run('UPDATE p10_findings SET posted_at = ? WHERE id = ?', ts, f.id);
          } else {
            postFailures.push({ findingId: f.id, status: result.status });
          }
        } catch {
          postFailures.push({ findingId: f.id, status: 0 });
        }
      }

      const postedCount = toPost.length - postFailures.length;

      if (postFailures.length > 0) {
        sendJson(res, 207, {
          posted: postedCount,
          skipped,
          failed: postFailures.length,
          failures: postFailures,
          message: `${postFailures.length} finding(s) failed to post to GitHub`,
        });
        return;
      }

      sendJson(res, 200, {
        posted: postedCount,
        skipped,
        message: `Posted ${postedCount} finding${postedCount === 1 ? '' : 's'}`,
      });
      return;
    }

    // Unsupported provider
    sendJson(res, 400, { error: `Posting not supported for provider: ${repo.provider}`, reason: 'unsupported_provider' });
  });

  // ── POST /api/projects/:id/reviews/:rid/merge (R1) ────────────────────────
  router.post('/api/projects/:id/reviews/:rid/merge', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'merge')) { sendJson(res, 403, { error: 'merge scope required' }); return; }
    if (!requireProjectEditor(req, res, req.params.id)) return;

    const review = one<Review>(
      'SELECT * FROM p10_reviews WHERE id = ? AND project_id = ?',
      req.params.rid,
      req.params.id,
    );
    if (!review) { sendJson(res, 404, { error: 'Review not found' }); return; }

    const body = req.body as Record<string, unknown>;
    const strategyRaw = body.strategy;
    const strategy: MergeStrategy = strategyRaw === 'merge' ? 'merge' : 'squash';

    if (review.status !== 'done') {
      sendJson(res, 409, { error: 'Cannot merge: review is not completed', reason: 'not_completed' });
      return;
    }

    const findings = all<Finding>('SELECT * FROM p10_findings WHERE review_id = ?', review.id);
    const threshold = getMergeThreshold();
    const verdict = computeMergeVerdict(review, findings, threshold);

    if (!verdict.mergeable) {
      sendJson(res, 409, {
        error: `Cannot merge: ${verdict.reason}`,
        reason: 'gate_blocked',
        verdict,
      });
      return;
    }

    if (!review.repo_id || review.pr_number == null) {
      sendJson(res, 400, { error: 'Review has no associated repository or PR number' });
      return;
    }

    const repo = one<{ url: string; provider: string }>('SELECT url, provider FROM repositories WHERE id = ?', review.repo_id);
    if (!repo) { sendJson(res, 404, { error: 'Repository not found' }); return; }

    // Item 2b: refuse merge when source_sha is unknown — we cannot pin the merge
    if (!review.source_sha) {
      sendJson(res, 400, {
        error: 'Cannot merge: the reviewed commit SHA is unknown. Re-run the review or supply sourceSha when creating it.',
        reason: 'missing_source_sha',
      });
      return;
    }

    // Item 2c: staleness check — lookup failure or null head → 409 stale_review
    {
      let currentHead: string | null = null;
      let lookupAttempted = false;
      try {
        if (repo.provider === 'github') {
          const ghToken = findGitHubToken(req.user!.id);
          const ownerRepoStale = parseGitHubOwnerRepo(repo.url);
          if (ghToken && ownerRepoStale) {
            lookupAttempted = true;
            currentHead = await _providers.githubGetPrHead(ownerRepoStale.owner, ownerRepoStale.repo, review.pr_number, ghToken);
          }
        } else if (repo.provider === 'codecommit') {
          const ccCreds = findCodeCommitCreds(req.params.id, req.user!.id);
          const ccRepoNameStale = parseCodeCommitRepoName(repo.url);
          if (ccCreds && ccRepoNameStale) {
            lookupAttempted = true;
            currentHead = await _providers.codecommitGetPrHead(ccRepoNameStale, String(review.pr_number), ccCreds);
          }
        }
      } catch {
        lookupAttempted = true;
        currentHead = null;
      }

      if (lookupAttempted && currentHead === null) {
        sendJson(res, 409, {
          error: 'Cannot merge: could not verify the current PR head (provider lookup failed or returned no data).',
          reason: 'stale_review',
        });
        return;
      }

      if (currentHead !== null && currentHead !== review.source_sha) {
        sendJson(res, 409, {
          error: `Cannot merge: PR head has moved since this review ran (expected ${review.source_sha.slice(0, 8)}, current ${currentHead.slice(0, 8)})`,
          reason: 'stale_review',
        });
        return;
      }
    }

    // Perform merge
    try {
      if (repo.provider === 'github') {
        const ownerRepo = parseGitHubOwnerRepo(repo.url);
        if (!ownerRepo) {
          sendJson(res, 400, { error: 'Could not parse GitHub owner/repo from URL' });
          return;
        }
        const token = findGitHubToken(req.user!.id);
        if (!token) {
          sendJson(res, 400, { error: 'No GitHub credentials found. Add a GitHub git connection.' });
          return;
        }
        // Item 2a: pass source_sha so GitHub refuses if the head moved concurrently
        await _providers.githubMerge(ownerRepo.owner, ownerRepo.repo, review.pr_number, strategy, token, review.source_sha);
      } else if (repo.provider === 'codecommit') {
        const repoName = parseCodeCommitRepoName(repo.url);
        if (!repoName) {
          sendJson(res, 400, { error: 'Could not parse CodeCommit repository name from URL' });
          return;
        }
        const creds = findCodeCommitCreds(req.params.id, req.user!.id);
        if (!creds) {
          sendJson(res, 400, { error: 'No AWS credentials found for CodeCommit. Add an AWS account (keys, profile, instance-role, or SSO) or a CodeCommit git connection with AWS keys.' });
          return;
        }
        // Item 2d: source_sha is guaranteed non-null by the check above
        const sourceCommitId = review.source_sha;
        await _providers.codecommitMerge(repoName, String(review.pr_number), sourceCommitId, strategy, creds);
      } else {
        sendJson(res, 400, { error: `Merge not supported for provider: ${repo.provider}` });
        return;
      }
    } catch (e: unknown) {
      if (e instanceof MergeConflictError || (e as { name?: string })?.name === 'MergeConflictError') {
        sendJson(res, 409, { error: `Merge conflict: ${(e as Error).message.slice(0, 500)}`, reason: 'merge_conflict' });
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      sendJson(res, 502, { error: `Merge failed: ${msg.slice(0, 500)}` });
      return;
    }

    const mergedAt = now();
    run(
      'UPDATE p10_reviews SET merged_at = ?, merged_by = ? WHERE id = ?',
      mergedAt,
      req.user!.id,
      review.id,
    );

    appendAudit(
      getDb(),
      req.user!.id,
      'review.merge',
      `review:${review.id}`,
      { projectId: req.params.id, prNumber: review.pr_number, strategy, provider: repo.provider },
      req.ip,
    );

    sendJson(res, 200, { ok: true, mergedAt, strategy });
  });

  // ── POST /api/projects/:id/reviews/:rid/rerun (R2) ────────────────────────
  router.post('/api/projects/:id/reviews/:rid/rerun', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'review')) { sendJson(res, 403, { error: 'review scope required' }); return; }
    if (!requireProjectEditor(req, res, req.params.id)) return;

    const parent = one<Review>(
      'SELECT * FROM p10_reviews WHERE id = ? AND project_id = ?',
      req.params.rid,
      req.params.id,
    );
    if (!parent) { sendJson(res, 404, { error: 'Review not found' }); return; }

    const body = req.body as Record<string, unknown>;
    const postMode = body.postMode === 'auto' ? 'auto' : (body.postMode === 'draft' ? 'draft' : parent.post_mode);
    const minSeverity = SEVERITIES.includes(body.minSeverity as Severity)
      ? String(body.minSeverity)
      : parent.min_severity;

    const id = generateId();
    const ts = now();

    const jiraCtx = parseJson<JiraContext>(parent.jira_context || '{}', { key: null, summary: null, description: null, source: 'none', reason: null });

    let workflowId: string | null = null;
    try {
      let rerunGoal = `Code review (re-run): ${parent.base_ref} → ${parent.head_ref}${parent.pr_number ? ` (PR #${parent.pr_number})` : ''}`;
      if (jiraCtx.summary) {
        rerunGoal += `\n\nJira ticket: ${jiraCtx.key} — ${jiraCtx.summary}`;
        if (jiraCtx.description) rerunGoal += `\n\nBackground: ${jiraCtx.description.slice(0, 1000)}`;
      }
      const wid = generateId();
      insert('p6_workflows', {
        id: wid,
        project_id: req.params.id,
        goal: rerunGoal,
        status: 'pending',
        engine: 'demo',
        trust_tools: 0,
        lead_agent: null,
        workspace_id: null,
        output_files_enabled: 0,
        repo_ids: parent.repo_id ? JSON.stringify([parent.repo_id]) : '[]',
        iteration_count: 0,
        max_iterations: 1,
        kind: 'review',
        created_by: req.user!.id,
        created_at: ts,
        updated_at: ts,
      });
      workflowId = wid;
      emit(req.params.id, { type: 'workflow.created', workflowId: wid });
    } catch { /* continue */ }

    // Attempt to refresh source/dest SHAs from the provider (best-effort).
    // Uses the parent shas as fallback so existing re-run tests are unaffected
    // when no repo/pr is attached.
    let refreshedSourceSha = parent.source_sha;
    let refreshedDestSha = parent.dest_sha;
    if (parent.repo_id && parent.pr_number != null) {
      try {
        const repoRow = one<{ url: string; provider: string }>(
          'SELECT url, provider FROM repositories WHERE id = ?',
          parent.repo_id,
        );
        if (repoRow?.provider === 'github') {
          const ownerRepo = parseGitHubOwnerRepo(repoRow.url);
          const token = findGitHubToken(req.user!.id);
          if (ownerRepo && token) {
            const shas = await _providers.githubGetPrShas(ownerRepo.owner, ownerRepo.repo, parent.pr_number, token);
            if (shas.sourceSha) refreshedSourceSha = shas.sourceSha.slice(0, 64);
            if (shas.destSha) refreshedDestSha = shas.destSha.slice(0, 64);
          }
        } else if (repoRow?.provider === 'codecommit') {
          const creds = findCodeCommitCreds(req.params.id, req.user!.id);
          const repoName = parseCodeCommitRepoName(repoRow.url);
          if (creds && repoName) {
            const shas = await _providers.codecommitGetPrShas(repoName, String(parent.pr_number), creds);
            if (shas.sourceSha) refreshedSourceSha = shas.sourceSha.slice(0, 64);
            if (shas.destSha) refreshedDestSha = shas.destSha.slice(0, 64);
          }
        }
      } catch { /* best-effort: use parent shas */ }
    }

    insert('p10_reviews', {
      id,
      project_id: req.params.id,
      base_ref: parent.base_ref,
      head_ref: parent.head_ref,
      pr_number: parent.pr_number,
      repo_id: parent.repo_id,
      status: 'pending',
      post_mode: postMode,
      from_loop: parent.from_loop,
      workflow_id: workflowId,
      min_severity: minSeverity,
      summary: null,
      created_by: req.user!.id,
      created_at: ts,
      parent_review_id: parent.id,
      source_sha: refreshedSourceSha,
      dest_sha: refreshedDestSha,
      head_commit_sha: refreshedSourceSha ?? parent.head_commit_sha,
      provider_id: parent.provider_id,
      model_id: parent.model_id,
      jira_context: JSON.stringify(jiraCtx),
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
    });

    const review = one<Review>('SELECT * FROM p10_reviews WHERE id = ?', id);
    sendJson(res, 201, { review, parentReviewId: parent.id });
  });

  // ── GET /api/projects/:id/reviews/:rid/export/xlsx (R4) ───────────────────
  router.get('/api/projects/:id/reviews/:rid/export/xlsx', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const review = one<Review>(
      'SELECT * FROM p10_reviews WHERE id = ? AND project_id = ?',
      req.params.rid,
      req.params.id,
    );
    if (!review) { sendJson(res, 404, { error: 'Review not found' }); return; }

    const findings = all<Finding>(
      `SELECT * FROM p10_findings WHERE review_id = ?
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, file_path, line_number`,
      review.id,
    );

    const rateCard = getRateCard();
    const { estimatedUsd, cacheSavedUsd } = computeCost(review, rateCard);
    const verdict = computeMergeVerdict(review, findings, getMergeThreshold());

    const rows: unknown[][] = [
      ['Review Report'],
      [],
      ['Repository', review.repo_id ?? ''],
      ['PR Number', review.pr_number ?? ''],
      ['Base Branch', review.base_ref],
      ['Head Branch', review.head_ref],
      ['Source Commit', review.source_sha ?? ''],
      ['Dest Commit', review.dest_sha ?? ''],
      ['Model', review.model_id ?? ''],
      ['Status', review.status],
      ['Merge Verdict', verdict.verdict],
      ['Estimated Cost (USD)', estimatedUsd.toFixed(6)],
      ['Cache Saved (USD)', cacheSavedUsd.toFixed(6)],
      ['Created At', review.created_at],
      [],
      ['Findings'],
      ['Severity', 'File', 'Line', 'Title', 'Body', 'Confidence', 'Status'],
      ...findings.map((f) => [
        f.severity,
        f.file_path,
        f.line_number ?? '',
        f.title,
        f.body,
        f.confidence != null ? f.confidence : '',
        f.accepted === 1 ? 'accepted' : f.accepted === -1 ? 'dismissed' : 'pending',
      ]),
    ];

    let buf: Buffer;
    try {
      buf = await buildXlsx(rows);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      sendJson(res, 500, { error: `Export failed: ${msg}` });
      return;
    }

    const filename = safeFilename(`review-${review.id.slice(0, 8)}-${review.head_ref.replace(/[^a-z0-9]/gi, '_')}.xlsx`);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });

  // ── GET /api/projects/:id/reviews/:rid/export/docx (R4) ───────────────────
  router.get('/api/projects/:id/reviews/:rid/export/docx', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const review = one<Review>(
      'SELECT * FROM p10_reviews WHERE id = ? AND project_id = ?',
      req.params.rid,
      req.params.id,
    );
    if (!review) { sendJson(res, 404, { error: 'Review not found' }); return; }

    const findings = all<Finding>(
      `SELECT * FROM p10_findings WHERE review_id = ?
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, file_path, line_number`,
      review.id,
    );

    const rateCard = getRateCard();
    const { estimatedUsd, cacheSavedUsd } = computeCost(review, rateCard);
    const verdict = computeMergeVerdict(review, findings, getMergeThreshold());

    const lines: string[] = [
      '# Code Review Report',
      '',
      `## Metadata`,
      `- **PR Number**: ${review.pr_number ?? 'N/A'}`,
      `- **Base Branch**: ${review.base_ref}`,
      `- **Head Branch**: ${review.head_ref}`,
      `- **Source Commit**: ${review.source_sha ?? 'N/A'}`,
      `- **Dest Commit**: ${review.dest_sha ?? 'N/A'}`,
      `- **Model**: ${review.model_id ?? 'N/A'}`,
      `- **Status**: ${review.status}`,
      `- **Merge Verdict**: ${verdict.verdict}`,
      `- **Estimated Cost**: $${estimatedUsd.toFixed(6)} (estimated)`,
      `- **Cache Saved**: $${cacheSavedUsd.toFixed(6)}`,
      `- **Created At**: ${review.created_at}`,
      '',
      `## Findings (${findings.length})`,
      '',
      ...findings.flatMap((f) => [
        `### [${f.severity.toUpperCase()}] ${f.title}`,
        `**File**: ${f.file_path}${f.line_number != null ? `:${f.line_number}` : ''}`,
        `**Status**: ${f.accepted === 1 ? 'Accepted' : f.accepted === -1 ? 'Dismissed' : 'Pending'}`,
        '',
        f.body,
        '',
      ]),
    ];

    let buf: Buffer;
    try {
      buf = await buildDocx(lines.join('\n'));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      sendJson(res, 500, { error: `Export failed: ${msg}` });
      return;
    }

    const filename = safeFilename(`review-${review.id.slice(0, 8)}-${review.head_ref.replace(/[^a-z0-9]/gi, '_')}.docx`);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}
