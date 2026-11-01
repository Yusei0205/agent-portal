/**
 * Branch Scans (F9) — full-branch review, estimate-first, budget-gated.
 *
 * Routes:
 *   GET    /api/projects/:id/scans                   — list scans (with filters)
 *   POST   /api/projects/:id/scans                   — create scan (→ estimating)
 *   GET    /api/projects/:id/scans/:sid               — scan detail
 *   DELETE /api/projects/:id/scans/:sid               — delete scan
 *   GET    /api/projects/:id/scans/:sid/files         — list scan files
 *   POST   /api/projects/:id/scans/:sid/confirm       — confirm budget (→ queued)
 *   POST   /api/projects/:id/scans/:sid/resume        — resume stopped/failed scan
 *   GET    /api/scans/allowlist                       — get fullScanUsers list (admin)
 *   PUT    /api/scans/allowlist                       — set fullScanUsers list (admin)
 *   GET    /api/settings/bedrock-cross-account-policy — cross-account trust/perms (admin)
 */

import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, run, insert, getDb } from './db.ts';
import { generateId, now, newId, parseJson } from './util.ts';
import { getSetting, setSetting, getSettings } from './settings.ts';
import { appendAudit } from './audit.ts';
import { decrypt } from './secrets.ts';
import { config } from './config.ts';
import { computeCost, processReviewOutput } from './review.ts';
import type { RateCard } from './review.ts';
import { convertToMarkdown } from './convert.ts';
import path from 'node:path';
import fs from 'node:fs';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ScanStatus =
  | 'estimating'
  | 'estimate_ready'
  | 'queued'
  | 'fetching'
  | 'reviewing'
  | 'completed'
  | 'failed';

export interface Scan {
  id: string;
  project_id: string | null;
  repo_id: string | null;
  branch: string | null;
  pinned_sha: string | null;
  include_paths: string;       // JSON array of patterns
  exclude_paths: string;       // JSON array of patterns
  background_doc_ids: string;  // JSON array of vault_file ids
  model_role: string | null;
  provider_id: string | null;
  model_id: string | null;
  status: ScanStatus;
  fail_reason: string | null;
  budget_tokens: number | null;
  estimated_files: number | null;
  estimated_bytes: number | null;
  estimated_tokens: number | null;
  estimated_cost_usd: number | null;
  estimated_minutes: number | null;
  files_total: number;
  files_done: number;
  tokens_used: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  summary: string | null;
  review_id: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  workflow_id: string | null;
}

export interface ScanFile {
  id: string;
  scan_id: string;
  file_path: string;
  status: 'pending' | 'done' | 'skipped';
  tokens_used: number;
  done_at: string | null;
}

export interface FileEntry {
  path: string;
  size: number;
  sha: string;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Approximate chars-per-token ratio for estimation purposes. */
const CHARS_PER_TOKEN = 4;
/** Overhead tokens per file for system prompt + path + formatting. */
const TOKEN_OVERHEAD_PER_FILE = 600;
/** Estimated seconds to review one file (including latency). */
const SECONDS_PER_FILE = 8;
/** Maximum background docs total size (bytes) before we stop converting more. */
const MAX_BACKGROUND_BYTES = 512 * 1024 * 1024;

// ── Settings helpers ──────────────────────────────────────────────────────────

function getFullScanUsers(): string[] {
  const raw = getSetting(getDb(), 'review.fullScanUsers');
  if (!raw) return [];
  return parseJson<string[]>(raw, []);
}

async function setFullScanUsers(users: string[]): Promise<void> {
  await setSetting(getDb(), 'review.fullScanUsers', JSON.stringify(users));
}

function getRateCardForScan(): RateCard {
  const raw = getSetting(getDb(), 'review.rateCard');
  const DEFAULT: RateCard = { inputUsd: 3, outputUsd: 15, cacheWriteUsd: 3.75, cacheReadUsd: 0.30 };
  if (!raw) return DEFAULT;
  return { ...DEFAULT, ...parseJson<Partial<RateCard>>(raw, {}) };
}

function getLiteLLMSettings(): { baseUrl: string; keyEnc: string; model: string } {
  const baseUrl = getSetting(getDb(), 'litellm.baseUrl') ?? '';
  const keyEnc = getSetting(getDb(), 'litellm.key.enc') ?? '';
  const model = getSetting(getDb(), 'litellm.model') ?? 'gpt-4o';
  return { baseUrl: baseUrl.replace(/\/$/, ''), keyEnc, model };
}

// ── Allowlist check ───────────────────────────────────────────────────────────

function canRunScans(userId: string, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  const allowlist = getFullScanUsers();
  return allowlist.includes(userId);
}

// ── Gitignore-style path matcher ──────────────────────────────────────────────

function parsePatterns(raw: string | null | undefined): string[] {
  if (!raw || raw === '[]') return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) {
      return arr
        .map((x) => String(x ?? '').trim())
        .filter(Boolean);
    }
  } catch { /* fall through */ }
  // Plain text: newline/comma-separated
  return raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000GLOBSTAR\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000GLOBSTAR\u0000/g, '.*');
  return new RegExp(`(^|/)${escaped}(/|$)`);
}

/**
 * Returns true when `filePath` should be included given include and exclude pattern lists.
 * Logic:
 *   - If include patterns exist, the file must match at least one.
 *   - If exclude patterns exist, the file must not match any.
 */
export function matchesFilters(
  filePath: string,
  includePatterns: string[],
  excludePatterns: string[],
): boolean {
  const norm = filePath.replace(/\\/g, '/');

  if (excludePatterns.length > 0) {
    for (const p of excludePatterns) {
      if (globToRegex(p).test(norm)) return false;
    }
  }

  if (includePatterns.length > 0) {
    let matched = false;
    for (const p of includePatterns) {
      if (globToRegex(p).test(norm)) { matched = true; break; }
    }
    if (!matched) return false;
  }

  return true;
}

// ── Provider implementations (mockable) ───────────────────────────────────────

/** Fetch the file tree for a repo at a given branch/ref. Returns null sha if unavailable. */
async function _doFetchFileTree(
  repoId: string,
  branch: string | null,
  actorId: string,
  projectId: string,
): Promise<{ files: FileEntry[]; pinnedSha: string | null }> {
  const repo = one<{ url: string; provider: string; default_branch: string | null }>(
    'SELECT url, provider, default_branch FROM repositories WHERE id = ?',
    repoId,
  );
  if (!repo) return { files: [], pinnedSha: null };

  const ref = branch || repo.default_branch || 'main';

  if (repo.provider === 'github') {
    return _fetchGitHubTree(repo.url, ref, actorId);
  }

  if (repo.provider === 'codecommit') {
    return _fetchCodeCommitTree(repo.url, ref, projectId, actorId);
  }

  if (repo.provider === 'bitbucket') {
    return _fetchBitbucketTree(repo.url, ref, actorId);
  }

  return { files: [], pinnedSha: null };
}

function findGitHubToken(actorId: string): string | null {
  interface ConnRow { credentials_enc: string | null }
  const conns = all<ConnRow>(
    "SELECT credentials_enc FROM git_connections_v2 WHERE provider = 'github' AND (owner_id = ? OR scope = 'shared') ORDER BY created_at",
    actorId,
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

function parseGitHubOwnerRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:[/?#]|$)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

async function _fetchGitHubTree(
  repoUrl: string,
  ref: string,
  actorId: string,
): Promise<{ files: FileEntry[]; pinnedSha: string | null }> {
  const ownerRepo = parseGitHubOwnerRepo(repoUrl);
  if (!ownerRepo) return { files: [], pinnedSha: null };
  const token = findGitHubToken(actorId);
  if (!token) return { files: [], pinnedSha: null };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Resolve ref → sha
  const branchResp = await fetch(
    `https://api.github.com/repos/${ownerRepo.owner}/${ownerRepo.repo}/commits/${encodeURIComponent(ref)}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );
  if (!branchResp.ok) return { files: [], pinnedSha: null };
  const branchData = await branchResp.json() as { sha?: string; commit?: { tree?: { sha?: string } } };
  const commitSha = branchData.sha ?? null;
  const treeSha = branchData.commit?.tree?.sha ?? commitSha;
  if (!treeSha) return { files: [], pinnedSha: null };

  const treeResp = await fetch(
    `https://api.github.com/repos/${ownerRepo.owner}/${ownerRepo.repo}/git/trees/${treeSha}?recursive=1`,
    { headers, signal: AbortSignal.timeout(60_000) },
  );
  if (!treeResp.ok) return { files: [], pinnedSha: null };
  const treeData = await treeResp.json() as {
    tree?: Array<{ path?: string; type?: string; size?: number; sha?: string }>;
  };

  const files = (treeData.tree ?? [])
    .filter((item) => item.type === 'blob')
    .map((item) => ({ path: item.path ?? '', size: item.size ?? 0, sha: item.sha ?? '' }));

  return { files, pinnedSha: commitSha };
}

interface CodeCommitCreds {
  region: string;
  authMethod: 'keys' | 'profile' | 'instance-role' | 'sso' | 'portal-sso';
  accessKeyId?: string;
  secretAccessKey?: string;
  profileName?: string;
}

function findCodeCommitCreds(projectId: string, actorId: string): CodeCommitCreds | null {
  interface AccRow { credentials_enc: string | null; region: string | null; auth_method: string; profile_name: string | null }
  const accounts = all<AccRow>(
    'SELECT credentials_enc, region, auth_method, profile_name FROM aws_accounts WHERE project_id = ? ORDER BY created_at',
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
    } else if (method === 'profile' && a.profile_name) {
      return { authMethod: 'profile', region, profileName: a.profile_name };
    } else if (method === 'instance-role') {
      return { authMethod: 'instance-role', region };
    } else if (method === 'sso') {
      return { authMethod: 'sso', region, profileName: a.profile_name ?? undefined };
    }
  }
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
        interface AccRow2 { credentials_enc: string | null; auth_method: string }
        const acc = one<AccRow2>('SELECT credentials_enc, auth_method FROM aws_accounts WHERE id = ? LIMIT 1', creds.awsAccountId);
        if (acc?.auth_method === 'keys' && acc.credentials_enc) {
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

function parseCodeCommitRepoName(url: string): string | null {
  const m = url.match(/\/repos\/([^/?#]+)/);
  return m ? m[1] : null;
}

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
  return new CodeCommitClient(base);
}

async function _fetchCodeCommitTree(
  repoUrl: string,
  ref: string,
  projectId: string,
  actorId: string,
): Promise<{ files: FileEntry[]; pinnedSha: string | null }> {
  const repoName = parseCodeCommitRepoName(repoUrl);
  if (!repoName) return { files: [], pinnedSha: null };
  const creds = findCodeCommitCreds(projectId, actorId);
  if (!creds) return { files: [], pinnedSha: null };

  const { GetBranchCommand, GetFolderCommand } = await import('@aws-sdk/client-codecommit');
  const client = await makeCodeCommitClient(creds);

  let commitId: string | null = null;
  try {
    const branchResult = await client.send(new GetBranchCommand({ repositoryName: repoName, branchName: ref }));
    commitId = branchResult.branch?.commitId ?? null;
  } catch { return { files: [], pinnedSha: null }; }
  if (!commitId) return { files: [], pinnedSha: null };

  // Recursively list files via GetFolder
  const files: FileEntry[] = [];
  const queue = [''];
  while (queue.length > 0) {
    const folder = queue.shift() ?? '';
    try {
      const result = await client.send(new GetFolderCommand({ repositoryName: repoName, commitSpecifier: commitId, folderPath: folder || '/' }));
      for (const f of result.files ?? []) {
        if (f.absolutePath) files.push({ path: f.absolutePath.replace(/^\//, ''), size: 0, sha: f.blobId ?? '' });
      }
      for (const sf of result.subFolders ?? []) {
        if (sf.absolutePath) queue.push(sf.absolutePath);
      }
    } catch { break; }
  }

  return { files, pinnedSha: commitId };
}

// ── Bitbucket helpers ─────────────────────────────────────────────────────────

function parseBitbucketOwnerRepo(url: string): { workspace: string; repoSlug: string } | null {
  const m = url.match(/bitbucket\.org[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:[/?#]|$)/);
  if (!m) return null;
  return { workspace: m[1], repoSlug: m[2] };
}

function findBitbucketCreds(actorId: string): { email: string; apiToken: string } | null {
  interface ConnRow { credentials_enc: string | null }
  const conns = all<ConnRow>(
    "SELECT credentials_enc FROM git_connections_v2 WHERE provider = 'bitbucket' AND (owner_id = ? OR scope = 'shared') ORDER BY created_at",
    actorId,
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

async function _fetchBitbucketTree(
  repoUrl: string,
  ref: string,
  actorId: string,
): Promise<{ files: FileEntry[]; pinnedSha: string | null }> {
  const ownerRepo = parseBitbucketOwnerRepo(repoUrl);
  if (!ownerRepo) return { files: [], pinnedSha: null };
  const creds = findBitbucketCreds(actorId);
  if (!creds) return { files: [], pinnedSha: null };

  const auth = 'Basic ' + Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64');
  const base = `https://api.bitbucket.org/2.0/repositories/${ownerRepo.workspace}/${ownerRepo.repoSlug}`;

  // Resolve branch → commit SHA
  const branchResp = await fetch(
    `${base}/refs/branches/${encodeURIComponent(ref)}`,
    { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
  );
  if (!branchResp.ok) return { files: [], pinnedSha: null };
  const branchData = await branchResp.json() as { target?: { hash?: string } };
  const commitSha = branchData.target?.hash ?? null;
  if (!commitSha) return { files: [], pinnedSha: null };

  // Recursively list all files
  const files: FileEntry[] = [];
  const dirQueue: string[] = [''];

  while (dirQueue.length > 0) {
    const dir = dirQueue.shift() ?? '';
    let nextUrl: string | null =
      `${base}/src/${commitSha}/${dir}?pagelen=100`;
    while (nextUrl) {
      const resp = await fetch(nextUrl, {
        headers: { Authorization: auth, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) { nextUrl = null; break; }
      const data = await resp.json() as {
        values?: Array<{ type?: string; path?: string; size?: number }>;
        next?: string;
      };
      for (const entry of data.values ?? []) {
        if (entry.type === 'commit_file') {
          files.push({ path: entry.path ?? '', size: entry.size ?? 0, sha: '' });
        } else if (entry.type === 'commit_directory') {
          dirQueue.push((entry.path ?? '') + '/');
        }
      }
      nextUrl = data.next ?? null;
    }
  }

  return { files, pinnedSha: commitSha };
}

async function _doFetchFileContent(
  repoId: string,
  filePath: string,
  _sha: string,
  actorId: string,
  projectId: string,
): Promise<string> {
  const repo = one<{ url: string; provider: string }>(
    'SELECT url, provider FROM repositories WHERE id = ?',
    repoId,
  );
  if (!repo) return '';

  if (repo.provider === 'github') {
    const ownerRepo = parseGitHubOwnerRepo(repo.url);
    const token = findGitHubToken(actorId);
    if (!ownerRepo || !token) return '';
    const resp = await fetch(
      `https://api.github.com/repos/${ownerRepo.owner}/${ownerRepo.repo}/contents/${encodeURIComponent(filePath)}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15_000) },
    );
    if (!resp.ok) return '';
    const data = await resp.json() as { content?: string; encoding?: string };
    if (data.encoding === 'base64' && data.content) {
      return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
    }
    return '';
  }

  if (repo.provider === 'codecommit') {
    const repoName = parseCodeCommitRepoName(repo.url);
    const creds = findCodeCommitCreds(projectId, actorId);
    if (!repoName || !creds) return '';
    const { GetFileCommand } = await import('@aws-sdk/client-codecommit');
    const client = await makeCodeCommitClient(creds);
    const result = await client.send(new GetFileCommand({ repositoryName: repoName, filePath: '/' + filePath }));
    if (result.fileContent) return Buffer.from(result.fileContent).toString('utf8');
    return '';
  }

  if (repo.provider === 'bitbucket') {
    const ownerRepo = parseBitbucketOwnerRepo(repo.url);
    const bbCreds = findBitbucketCreds(actorId);
    if (!ownerRepo || !bbCreds) return '';
    const resp = await fetch(
      `https://api.bitbucket.org/2.0/repositories/${ownerRepo.workspace}/${ownerRepo.repoSlug}/src/HEAD/${encodeURIComponent(filePath)}`,
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${bbCreds.email}:${bbCreds.apiToken}`).toString('base64'),
          Accept: 'text/plain',
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!resp.ok) return '';
    return resp.text();
  }

  return '';
}

/** Call LiteLLM-compatible OpenAI chat API; returns text and real token counts. */
async function _doLiteLLMReview(
  fileContent: string,
  filePath: string,
  backgroundText: string,
  liteLLM: { baseUrl: string; keyEnc: string; model: string },
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const apiKey = liteLLM.keyEnc ? decrypt(liteLLM.keyEnc, config.secretKey) : '';
  const systemPrompt = [
    'You are a senior code reviewer. Review the provided code file and identify security vulnerabilities, bugs, and code quality issues.',
    'Return findings ONLY as a JSON array with objects: { file, line, severity, title, body }.',
    'severity must be one of: critical, high, medium, low, info.',
    backgroundText ? `\n\nBackground context:\n${backgroundText.slice(0, 12000)}` : '',
  ].join('');

  const userPrompt = `Review this file: ${filePath}\n\n\`\`\`\n${fileContent.slice(0, 60000)}\n\`\`\`\n\nReturn findings as JSON array only.`;

  const resp = await fetch(`${liteLLM.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: liteLLM.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!resp.ok) throw new Error(`LiteLLM API error: ${resp.status} ${resp.statusText}`);
  const data = await resp.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

/** Call the Anthropic Messages API directly; returns text and real token counts. */
async function _doAnthropicReview(
  fileContent: string,
  filePath: string,
  backgroundText: string,
  opts: { apiKey: string; model: string; baseUrl?: string },
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const systemPrompt = [
    'You are a senior code reviewer. Review the provided code file and identify security vulnerabilities, bugs, and code quality issues.',
    'Return findings ONLY as a JSON array with objects: { file, line, severity, title, body }.',
    'severity must be one of: critical, high, medium, low, info.',
    backgroundText ? `\n\nBackground context:\n${backgroundText.slice(0, 12000)}` : '',
  ].join('');

  const userPrompt = `Review this file: ${filePath}\n\n\`\`\`\n${fileContent.slice(0, 60000)}\n\`\`\`\n\nReturn findings as JSON array only.`;

  const base = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const resp = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
    const msg = (body as { error?: { message?: string } }).error?.message ?? resp.statusText;
    throw new Error(`Anthropic API error: ${msg}`);
  }

  const data = await resp.json() as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  return {
    text: (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}

// ── Mockable providers ────────────────────────────────────────────────────────

/**
 * Override these in tests to avoid real network calls.
 */
export const _scanProviders = {
  fetchFileTree: _doFetchFileTree as (
    repoId: string,
    branch: string | null,
    actorId: string,
    projectId: string,
  ) => Promise<{ files: FileEntry[]; pinnedSha: string | null }>,

  fetchFileContent: _doFetchFileContent as (
    repoId: string,
    filePath: string,
    sha: string,
    actorId: string,
    projectId: string,
  ) => Promise<string>,

  liteLLMReview: _doLiteLLMReview as (
    fileContent: string,
    filePath: string,
    backgroundText: string,
    liteLLM: { baseUrl: string; keyEnc: string; model: string },
  ) => Promise<{ text: string; inputTokens: number; outputTokens: number }>,

  anthropicReview: _doAnthropicReview as (
    fileContent: string,
    filePath: string,
    backgroundText: string,
    opts: { apiKey: string; model: string; baseUrl?: string },
  ) => Promise<{ text: string; inputTokens: number; outputTokens: number }>,
};

// ── Background document resolution ───────────────────────────────────────────

async function resolveBackgroundText(
  docIds: string[],
  projectId: string,
): Promise<string> {
  if (docIds.length === 0) return '';

  const parts: string[] = [];
  let totalBytes = 0;

  for (const docId of docIds) {
    const file = one<{ name: string; path: string; mime_type: string | null; size_bytes: number | null }>(
      'SELECT name, path, mime_type, size_bytes FROM vault_files WHERE id = ? AND (project_id = ? OR project_id IS NULL)',
      docId,
      projectId,
    );
    if (!file) continue;
    const fileSize = file.size_bytes ?? 0;
    if (totalBytes + fileSize > MAX_BACKGROUND_BYTES) break;
    totalBytes += fileSize;

    const fullPath = path.join(config.dataDir, file.path);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const md = await convertToMarkdown(fullPath, file.mime_type ?? '');
      parts.push(`## Background: ${file.name}\n\n${md}`);
    } catch {
      // skip unconvertible docs
    }
  }

  return parts.join('\n\n---\n\n');
}

// ── Provider resolution helpers ───────────────────────────────────────────────

type ScanProviderName = 'litellm' | 'anthropic' | 'bedrock';

/**
 * Determine which provider to use for a scan, given the scan's explicit
 * provider_id override and the portal's current provider settings.
 * Returns the resolved provider name, or null if no provider is configured.
 */
function resolveScanProvider(
  scanProviderId: string | null,
): ScanProviderName | null {
  // Explicit override wins
  if (scanProviderId === 'litellm') return 'litellm';
  if (scanProviderId === 'anthropic') return 'anthropic';
  if (scanProviderId === 'bedrock') return 'bedrock';

  // Fall back to portal settings
  const settings = getSettings();
  const mode = settings.provider.mode;

  if (mode === 'litellm') {
    return settings.litellm.baseUrl ? 'litellm' : null;
  }
  if (mode === 'anthropic') {
    return settings.provider.hasKey ? 'anthropic' : null;
  }
  if (mode === 'bedrock') return 'bedrock';

  return null; // demo, kiro — no review provider
}

/** Resolve the Anthropic API key from portal settings. */
function getAnthropicKeyForScan(): string {
  const settings = getSettings();
  if (!settings.provider.anthropicKeyEnc) return '';
  try { return decrypt(settings.provider.anthropicKeyEnc, config.secretKey); }
  catch { return ''; }
}

async function runEstimation(scanId: string): Promise<void> {
  const scan = one<Scan>('SELECT * FROM p10_scans WHERE id = ?', scanId);
  if (!scan || scan.status !== 'estimating') return;

  try {
    const includePats = parsePatterns(scan.include_paths);
    const excludePats = parsePatterns(scan.exclude_paths);
    const actorId = scan.created_by ?? '';
    const projectId = scan.project_id ?? '';
    const repoId = scan.repo_id ?? '';

    const { files, pinnedSha } = await _scanProviders.fetchFileTree(repoId, scan.branch, actorId, projectId);

    const filtered = files.filter((f) => matchesFilters(f.path, includePats, excludePats));
    const totalBytes = filtered.reduce((sum, f) => sum + f.size, 0);
    const estimatedTokens = filtered.reduce(
      (sum, f) => sum + Math.ceil(f.size / CHARS_PER_TOKEN) + TOKEN_OVERHEAD_PER_FILE,
      0,
    );

    const rateCard = getRateCardForScan();
    const M = 1_000_000;
    const estimatedCostUsd = (estimatedTokens / M) * (rateCard.inputUsd + rateCard.outputUsd * 0.3);
    const estimatedMinutes = (filtered.length * SECONDS_PER_FILE) / 60;

    run(
      `UPDATE p10_scans SET
         status = 'estimate_ready',
         pinned_sha = ?,
         estimated_files = ?,
         estimated_bytes = ?,
         estimated_tokens = ?,
         estimated_cost_usd = ?,
         estimated_minutes = ?
       WHERE id = ? AND status = 'estimating'`,
      pinnedSha,
      filtered.length,
      totalBytes,
      estimatedTokens,
      estimatedCostUsd,
      estimatedMinutes,
      scanId,
    );

    // Pre-populate the file list for the estimate
    if (filtered.length > 0) {
      const ts = now();
      const existing = new Set(
        all<{ file_path: string }>('SELECT file_path FROM p10_scan_files WHERE scan_id = ?', scanId).map((r) => r.file_path),
      );
      for (const f of filtered) {
        if (existing.has(f.path)) continue;
        insert('p10_scan_files', {
          id: newId('sf_'),
          scan_id: scanId,
          file_path: f.path,
          file_sha: f.sha,
          file_size: f.size,
          status: 'pending',
          tokens_used: 0,
          done_at: null,
        });
      }
      run('UPDATE p10_scans SET files_total = ? WHERE id = ?', filtered.length, scanId);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    run(
      "UPDATE p10_scans SET status = 'failed', fail_reason = ? WHERE id = ?",
      `Estimation failed: ${msg.slice(0, 500)}`,
      scanId,
    );
  }
}

// ── Scan runner ───────────────────────────────────────────────────────────────

async function runScan(scanId: string): Promise<void> {
  const scan = one<Scan>('SELECT * FROM p10_scans WHERE id = ?', scanId);
  if (!scan) return;
  if (!['queued', 'fetching', 'reviewing'].includes(scan.status)) return;

  run(
    "UPDATE p10_scans SET status = 'fetching', started_at = COALESCE(started_at, ?) WHERE id = ?",
    now(),
    scanId,
  );

  const actorId = scan.created_by ?? '';
  const projectId = scan.project_id ?? '';
  const repoId = scan.repo_id ?? '';
  const budgetTokens = scan.budget_tokens ?? Infinity;

  // Ensure we have a linked p10_review to store findings in
  let reviewId = scan.review_id;
  if (!reviewId) {
    reviewId = generateId();
    const ts = now();
    insert('p10_reviews', {
      id: reviewId,
      project_id: projectId,
      base_ref: scan.pinned_sha ?? scan.branch ?? 'HEAD',
      head_ref: scan.branch ?? 'HEAD',
      pr_number: null,
      repo_id: repoId,
      status: 'running',
      post_mode: 'draft',
      from_loop: null,
      workflow_id: null,
      min_severity: 'medium',
      summary: null,
      raw_output: null,
      created_by: actorId,
      created_at: ts,
      parent_review_id: null,
      source_sha: scan.pinned_sha,
      dest_sha: null,
      head_commit_sha: scan.pinned_sha,
      provider_id: scan.provider_id,
      model_id: scan.model_id,
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
      started_at: ts,
      merged_at: null,
      merged_by: null,
      scan_id: scanId,
    });
    run('UPDATE p10_scans SET review_id = ? WHERE id = ?', reviewId, scanId);
  } else {
    run("UPDATE p10_reviews SET status = 'running' WHERE id = ? AND status != 'running'", reviewId);
  }

  // Resolve background documents
  const docIds = parseJson<string[]>(scan.background_doc_ids, []);
  const backgroundText = await resolveBackgroundText(docIds, projectId);

  // Determine provider — must be resolved before processing files
  const providerName = resolveScanProvider(scan.provider_id);
  const liteLLMCfg = getLiteLLMSettings();
  const anthropicKey = getAnthropicKeyForScan();
  const anthropicModel = scan.model_id ?? (getSettings().defaultModel || 'claude-sonnet-4-5');
  const anthropicBaseUrl = getSettings().headroomProxyUrl || undefined;

  run("UPDATE p10_scans SET status = 'reviewing' WHERE id = ?", scanId);

  // Process pending files
  const pendingFiles = all<{ id: string; file_path: string; file_sha: string | null; file_size: number | null }>(
    "SELECT id, file_path, file_sha, file_size FROM p10_scan_files WHERE scan_id = ? AND status = 'pending' ORDER BY file_path",
    scanId,
  );

  let tokensUsed = scan.tokens_used ?? 0;
  let filesDone = scan.files_done ?? 0;
  let budgetExhausted = false;
  let rawOutputAccumulator = '';

  for (const file of pendingFiles) {
    // Re-read current token usage
    const current = one<{ tokens_used: number; budget_tokens: number | null; status: string }>(
      'SELECT tokens_used, budget_tokens, status FROM p10_scans WHERE id = ?',
      scanId,
    );
    if (!current || current.status === 'failed') return;

    tokensUsed = current.tokens_used;
    const effectiveBudget = current.budget_tokens ?? Infinity;

    if (tokensUsed >= effectiveBudget) {
      budgetExhausted = true;
      break;
    }

    let fileContent: string;
    try {
      fileContent = await _scanProviders.fetchFileContent(repoId, file.file_path, file.file_sha ?? '', actorId, projectId);
    } catch {
      run("UPDATE p10_scan_files SET status = 'skipped', done_at = ? WHERE id = ?", now(), file.id);
      continue;
    }

    if (!fileContent.trim()) {
      run("UPDATE p10_scan_files SET status = 'skipped', done_at = ? WHERE id = ?", now(), file.id);
      continue;
    }

    const estimatedFileTokens = Math.ceil(fileContent.length / CHARS_PER_TOKEN) + TOKEN_OVERHEAD_PER_FILE;
    if (tokensUsed + estimatedFileTokens > effectiveBudget) {
      budgetExhausted = true;
      break;
    }

    let reviewText = '';
    let fileTokens = estimatedFileTokens;

    try {
      if (providerName === 'litellm') {
        const result = await _scanProviders.liteLLMReview(fileContent, file.file_path, backgroundText, liteLLMCfg);
        reviewText = result.text;
        fileTokens = (result.inputTokens + result.outputTokens) || estimatedFileTokens;
      } else if (providerName === 'anthropic') {
        const result = await _scanProviders.anthropicReview(fileContent, file.file_path, backgroundText, {
          apiKey: anthropicKey,
          model: anthropicModel,
          baseUrl: anthropicBaseUrl,
        });
        reviewText = result.text;
        fileTokens = (result.inputTokens + result.outputTokens) || estimatedFileTokens;
      } else if (providerName === 'bedrock') {
        // Bedrock: route through LiteLLM if a gateway is configured, otherwise skip
        if (liteLLMCfg.baseUrl) {
          const result = await _scanProviders.liteLLMReview(fileContent, file.file_path, backgroundText, liteLLMCfg);
          reviewText = result.text;
          fileTokens = (result.inputTokens + result.outputTokens) || estimatedFileTokens;
        } else {
          fileTokens = 0;
        }
      } else {
        // No provider configured — skip this file (should have been caught at confirm)
        fileTokens = 0;
      }
    } catch {
      run("UPDATE p10_scan_files SET status = 'skipped', done_at = ? WHERE id = ?", now(), file.id);
      continue;
    }

    if (reviewText) {
      rawOutputAccumulator += `\n\n<!-- file: ${file.file_path} -->\n${reviewText}`;
    }

    tokensUsed += fileTokens;
    filesDone++;

    run(
      "UPDATE p10_scan_files SET status = 'done', tokens_used = ?, done_at = ? WHERE id = ?",
      fileTokens,
      now(),
      file.id,
    );

    run(
      'UPDATE p10_scans SET tokens_used = ?, files_done = ? WHERE id = ?',
      tokensUsed,
      filesDone,
      scanId,
    );
  }

  // Flush accumulated review text to the linked review record and extract findings
  if (rawOutputAccumulator && reviewId) {
    run(
      'UPDATE p10_reviews SET raw_output = COALESCE(raw_output, \'\') || ?, files_reviewed = ? WHERE id = ?',
      rawOutputAccumulator,
      filesDone,
      reviewId,
    );
    processReviewOutput(reviewId);
  }

  const finalStatus = budgetExhausted ? 'failed' : 'completed';
  const failReason = budgetExhausted ? 'budget_exhausted' : null;

  run(
    `UPDATE p10_scans SET status = ?, fail_reason = ?, completed_at = ? WHERE id = ?`,
    finalStatus,
    failReason,
    now(),
    scanId,
  );

  if (reviewId) {
    run(
      "UPDATE p10_reviews SET status = ? WHERE id = ?",
      budgetExhausted ? 'failed' : 'done',
      reviewId,
    );
  }
}

// ── Access helpers ────────────────────────────────────────────────────────────

function hasTokenScope(req: PortalRequest, scope: string): boolean {
  if (!req.authViaToken) return true;
  return (req.tokenScopes ?? []).includes(scope);
}

function requireProjectAccess(req: PortalRequest, res: PortalResponse, projectId: string): boolean {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  const project = one<{ id: string }>('SELECT id FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!project) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  const member = one<{ user_id: string }>(
    'SELECT user_id FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    req.user.id,
  );
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  return true;
}

function requireAdmin(req: PortalRequest, res: PortalResponse): boolean {
  if (!req.user?.is_admin) { sendJson(res, 403, { error: 'Admin access required' }); return false; }
  return true;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerScanRoutes(): void {

  // ── GET /api/scans/allowlist ──────────────────────────────────────────────
  router.get('/api/scans/allowlist', requireAuth((req: PortalRequest, res: PortalResponse): void => {
    if (!requireAdmin(req, res)) return;
    sendJson(res, 200, { users: getFullScanUsers() });
  }));

  // ── PUT /api/scans/allowlist ──────────────────────────────────────────────
  router.put('/api/scans/allowlist', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    const body = req.body as Record<string, unknown>;
    const users = body.users;
    if (!Array.isArray(users)) {
      sendJson(res, 400, { error: 'users must be an array of user IDs' });
      return;
    }
    const ids = users.map((u) => String(u)).filter(Boolean);
    await setFullScanUsers(ids);
    appendAudit(getDb(), req.user!.id, 'scan.allowlist.update', 'scan:allowlist', { count: ids.length }, req.ip);
    sendJson(res, 200, { users: ids });
  }));

  // ── GET /api/settings/bedrock-cross-account-policy ────────────────────────
  router.get('/api/settings/bedrock-cross-account-policy', requireAuth((req: PortalRequest, res: PortalResponse): void => {
    if (!requireAdmin(req, res)) return;

    // Try to determine the portal's runtime role ARN.
    // In ECS/EC2 with IMDS it may be available in the environment.
    const runtimeRoleArn =
      process.env.PORTAL_ROLE_ARN ??
      process.env.AWS_ROLE_ARN ??
      '<!-- PLACEHOLDER: Set PORTAL_ROLE_ARN env var to the portal\'s IAM role ARN -->';

    const isPlaceholder = runtimeRoleArn.startsWith('<!--');

    const trustPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AllowPortalToAssumeRole',
          Effect: 'Allow',
          Principal: { AWS: runtimeRoleArn },
          Action: 'sts:AssumeRole',
        },
      ],
    };

    const bedrockRegion = getSetting(getDb(), 'bedrock.region') ?? 'us-east-1';
    const accountId = process.env.AWS_ACCOUNT_ID ?? '*';

    const permissionsPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AllowBedrockInvoke',
          Effect: 'Allow',
          Action: [
            'bedrock:InvokeModel',
            'bedrock:InvokeModelWithResponseStream',
          ],
          Resource: [
            `arn:aws:bedrock:${bedrockRegion}::foundation-model/*`,
            `arn:aws:bedrock:${bedrockRegion}:${accountId}:inference-profile/*`,
          ],
        },
      ],
    };

    sendJson(res, 200, {
      trustPolicy,
      permissionsPolicy,
      principalArn: runtimeRoleArn,
      isPrincipalPlaceholder: isPlaceholder,
      hint: isPlaceholder
        ? 'Set the PORTAL_ROLE_ARN environment variable to the ARN of the IAM role running this portal.'
        : null,
    });
  }));

  // ── GET /api/projects/:id/scans ───────────────────────────────────────────
  router.get('/api/projects/:id/scans', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const q = req.query;
    const runBy = q.get('runBy') ?? 'everyone';
    const status = q.get('status');
    const repoId = q.get('repository');
    const dateFrom = q.get('dateFrom');
    const dateTo = q.get('dateTo');
    const search = q.get('q');
    const page = Math.max(1, parseInt(q.get('page') ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.get('limit') ?? '20', 10)));
    const offset = (page - 1) * limit;

    const conditions: string[] = ['s.project_id = ?'];
    const params: (string | number | null)[] = [req.params.id];

    if (runBy === 'me') {
      conditions.push('s.created_by = ?');
      params.push(req.user!.id);
    } else if (runBy !== 'everyone') {
      conditions.push('s.created_by = ?');
      params.push(runBy);
    }

    if (status) {
      conditions.push('s.status = ?');
      params.push(status);
    }

    if (repoId) {
      conditions.push('s.repo_id = ?');
      params.push(repoId);
    }

    if (dateFrom) {
      conditions.push('s.created_at >= ?');
      params.push(dateFrom);
    }

    if (dateTo) {
      conditions.push('s.created_at <= ?');
      params.push(dateTo);
    }

    if (search) {
      conditions.push("(s.branch LIKE ? OR s.include_paths LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }

    const where = conditions.join(' AND ');

    const total = (one<{ n: number }>(`SELECT COUNT(*) AS n FROM p10_scans s WHERE ${where}`, ...params) ?? { n: 0 }).n;

    const scans = all<Scan>(
      `SELECT s.* FROM p10_scans s WHERE ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );

    sendJson(res, 200, { scans, total, page, limit });
  });

  // ── POST /api/projects/:id/scans ──────────────────────────────────────────
  router.post('/api/projects/:id/scans', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'review')) { sendJson(res, 403, { error: 'review scope required' }); return; }
    if (!requireProjectAccess(req, res, req.params.id)) return;

    if (!canRunScans(req.user!.id, Boolean(req.user!.is_admin))) {
      sendJson(res, 403, {
        error: 'Branch scans are restricted. Ask an admin to add you to the scan allowlist.',
        reason: 'not_in_allowlist',
      });
      return;
    }

    const body = req.body as Record<string, unknown>;

    const repoId = body.repoId != null ? String(body.repoId) : null;
    if (!repoId) {
      sendJson(res, 400, { error: 'repoId is required' });
      return;
    }

    const repo = one<{ id: string; project_id: string }>(
      'SELECT id, project_id FROM repositories WHERE id = ?',
      repoId,
    );
    if (!repo || repo.project_id !== req.params.id) {
      sendJson(res, 400, { error: 'Repository not found in this project' });
      return;
    }

    const branch = body.branch != null ? String(body.branch).trim() || null : null;

    // Parse include/exclude paths
    const rawInclude = body.includePaths;
    const rawExclude = body.excludePaths;
    const includePats = parsePatterns(
      Array.isArray(rawInclude)
        ? JSON.stringify(rawInclude)
        : typeof rawInclude === 'string'
        ? rawInclude
        : '[]',
    );
    const excludePats = parsePatterns(
      Array.isArray(rawExclude)
        ? JSON.stringify(rawExclude)
        : typeof rawExclude === 'string'
        ? rawExclude
        : '[]',
    );

    const backgroundDocIds = Array.isArray(body.backgroundDocIds)
      ? (body.backgroundDocIds as unknown[]).map((x) => String(x))
      : [];

    const modelRole = body.modelRole != null ? String(body.modelRole).slice(0, 500) : null;
    const providerId = body.providerId != null ? String(body.providerId).slice(0, 100) : null;
    const modelId = body.modelId != null ? String(body.modelId).slice(0, 200) : null;

    const id = generateId();
    const ts = now();

    insert('p10_scans', {
      id,
      project_id: req.params.id,
      repo_id: repoId,
      branch,
      pinned_sha: null,
      include_paths: JSON.stringify(includePats),
      exclude_paths: JSON.stringify(excludePats),
      background_doc_ids: JSON.stringify(backgroundDocIds),
      model_role: modelRole,
      provider_id: providerId,
      model_id: modelId,
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
      created_by: req.user!.id,
      created_at: ts,
      started_at: null,
      completed_at: null,
      workflow_id: null,
    });

    appendAudit(getDb(), req.user!.id, 'scan.create', `scan:${id}`, { projectId: req.params.id, repoId, branch }, req.ip);

    const scan = one<Scan>('SELECT * FROM p10_scans WHERE id = ?', id);
    sendJson(res, 201, { scan });

    // Start estimation in background
    setImmediate(() => { runEstimation(id).catch(() => { /* best effort */ }); });
  }));

  // ── GET /api/projects/:id/scans/:sid ──────────────────────────────────────
  router.get('/api/projects/:id/scans/:sid', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const scan = one<Scan>('SELECT * FROM p10_scans WHERE id = ? AND project_id = ?', req.params.sid, req.params.id);
    if (!scan) { sendJson(res, 404, { error: 'Scan not found' }); return; }

    const rateCard = getRateCardForScan();
    const fakeCostInput = { input_tokens: scan.tokens_used ?? 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0 };
    const { estimatedUsd } = computeCost(fakeCostInput, rateCard);

    sendJson(res, 200, {
      scan: { ...scan, estimatedRunUsd: estimatedUsd },
    });
  });

  // ── DELETE /api/projects/:id/scans/:sid ───────────────────────────────────
  router.delete('/api/projects/:id/scans/:sid', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const scan = one<Scan>('SELECT * FROM p10_scans WHERE id = ? AND project_id = ?', req.params.sid, req.params.id);
    if (!scan) { sendJson(res, 404, { error: 'Scan not found' }); return; }

    if (scan.status === 'fetching' || scan.status === 'reviewing') {
      sendJson(res, 400, { error: 'Cannot delete a running scan. Wait for it to finish.' });
      return;
    }

    run('DELETE FROM p10_scans WHERE id = ?', scan.id);
    sendJson(res, 200, { ok: true });
  });

  // ── GET /api/projects/:id/scans/:sid/files ────────────────────────────────
  router.get('/api/projects/:id/scans/:sid/files', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const scan = one<{ id: string }>('SELECT id FROM p10_scans WHERE id = ? AND project_id = ?', req.params.sid, req.params.id);
    if (!scan) { sendJson(res, 404, { error: 'Scan not found' }); return; }

    const files = all<ScanFile>(
      'SELECT id, scan_id, file_path, status, tokens_used, done_at FROM p10_scan_files WHERE scan_id = ? ORDER BY file_path',
      scan.id,
    );
    sendJson(res, 200, { files });
  });

  // ── POST /api/projects/:id/scans/:sid/confirm ─────────────────────────────
  router.post('/api/projects/:id/scans/:sid/confirm', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'review')) { sendJson(res, 403, { error: 'review scope required' }); return; }
    if (!requireProjectAccess(req, res, req.params.id)) return;

    if (!canRunScans(req.user!.id, Boolean(req.user!.is_admin))) {
      sendJson(res, 403, {
        error: 'Branch scans are restricted. Ask an admin to add you to the scan allowlist.',
        reason: 'not_in_allowlist',
      });
      return;
    }

    const scan = one<Scan>('SELECT * FROM p10_scans WHERE id = ? AND project_id = ?', req.params.sid, req.params.id);
    if (!scan) { sendJson(res, 404, { error: 'Scan not found' }); return; }

    if (scan.status !== 'estimate_ready') {
      sendJson(res, 400, { error: `Cannot confirm: scan is in state '${scan.status}', expected 'estimate_ready'` });
      return;
    }

    // F9: Fail early if no review provider is configured — don't queue a scan
    // that will silently produce no findings.
    const effectiveProvider = resolveScanProvider(scan.provider_id);
    if (!effectiveProvider) {
      const mode = getSettings().provider.mode;
      sendJson(res, 400, {
        error: `No review provider is configured for scans. The current portal provider ("${mode}") does not support code review. Configure Anthropic, Bedrock, or LiteLLM in Settings › Provider.`,
        reason: 'no_provider',
      });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const budgetTokens = Number(body.budgetTokens);
    if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
      sendJson(res, 400, { error: 'budgetTokens must be a positive number' });
      return;
    }

    run(
      "UPDATE p10_scans SET status = 'queued', budget_tokens = ? WHERE id = ?",
      Math.round(budgetTokens),
      scan.id,
    );

    appendAudit(getDb(), req.user!.id, 'scan.confirm', `scan:${scan.id}`, { budgetTokens }, req.ip);

    const updated = one<Scan>('SELECT * FROM p10_scans WHERE id = ?', scan.id);
    sendJson(res, 200, { scan: updated });

    // Start scan in background
    setImmediate(() => { runScan(scan.id).catch(() => { /* best effort */ }); });
  }));

  // ── POST /api/projects/:id/scans/:sid/resume ──────────────────────────────
  router.post('/api/projects/:id/scans/:sid/resume', requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasTokenScope(req, 'review')) { sendJson(res, 403, { error: 'review scope required' }); return; }
    if (!requireProjectAccess(req, res, req.params.id)) return;

    if (!canRunScans(req.user!.id, Boolean(req.user!.is_admin))) {
      sendJson(res, 403, {
        error: 'Branch scans are restricted. Ask an admin to add you to the scan allowlist.',
        reason: 'not_in_allowlist',
      });
      return;
    }

    const scan = one<Scan>('SELECT * FROM p10_scans WHERE id = ? AND project_id = ?', req.params.sid, req.params.id);
    if (!scan) { sendJson(res, 404, { error: 'Scan not found' }); return; }

    if (!['failed', 'completed'].includes(scan.status)) {
      sendJson(res, 400, { error: `Cannot resume: scan is in state '${scan.status}'` });
      return;
    }

    const body = req.body as Record<string, unknown>;

    // Optionally raise the budget
    let newBudget = scan.budget_tokens;
    if (body.budgetTokens != null) {
      const v = Number(body.budgetTokens);
      if (!Number.isFinite(v) || v <= 0) {
        sendJson(res, 400, { error: 'budgetTokens must be a positive number' });
        return;
      }
      newBudget = Math.round(v);
    }

    if (!newBudget) {
      sendJson(res, 400, { error: 'No budget set. Provide budgetTokens.' });
      return;
    }

    // Check if there are any pending files left
    const pendingCount = (one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM p10_scan_files WHERE scan_id = ? AND status = 'pending'",
      scan.id,
    ) ?? { n: 0 }).n;

    if (pendingCount === 0) {
      sendJson(res, 400, { error: 'No pending files to resume. All files have been processed.' });
      return;
    }

    run(
      "UPDATE p10_scans SET status = 'queued', budget_tokens = ?, fail_reason = NULL WHERE id = ?",
      newBudget,
      scan.id,
    );

    appendAudit(getDb(), req.user!.id, 'scan.resume', `scan:${scan.id}`, { newBudget }, req.ip);

    const updated = one<Scan>('SELECT * FROM p10_scans WHERE id = ?', scan.id);
    sendJson(res, 200, { scan: updated });

    // Continue scan in background
    setImmediate(() => { runScan(scan.id).catch(() => { /* best effort */ }); });
  }));
}
