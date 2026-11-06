/**
 * Open a pull request on the repository's host (GitHub, CodeCommit).
 *
 * Credentials come from the repository row the same way clones resolve them (see getCloneEnv in repos.ts):
 * for CodeCommit the project's default AWS account first, then the repository's Git connection; for GitHub the
 * Git connection's token. Other hosts are refused with `unsupported` (the branch is still pushed by the caller).
 *
 * Titles are cut at 120 characters and bodies at 60,000 (10,000 for CodeCommit, whose limit is lower); the body
 * is scrubbed of credentials before it is sent. Error text never carries credentials.
 */

import { decrypt } from './secrets.ts';
import { config } from './config.ts';
import { parseJson } from './util.ts';
import { redactCredentials } from './git-progress.ts';
import { getAwsAccountsRepository } from './repositories/aws-accounts.ts';
import { getGitConnectionsRepository } from './repositories/git-connections.ts';
import { parseCodeCommitRepoName, parseGitHubOwnerRepo } from './review.ts';
import type { Repository } from './repos.ts';

export interface CreatePrInput { repo: Repository; base: string; head: string; title: string; body: string }
export interface CreatedPr { number: number; url: string; existing: boolean }

export type PullRequestErrorCode = 'no-permission' | 'unsupported' | 'failed';

export class PullRequestError extends Error {
  code: PullRequestErrorCode;
  constructor(code: PullRequestErrorCode, message: string) {
    super(message);
    this.name = 'PullRequestError';
    this.code = code;
  }
}

const TITLE_MAX = 120;
const BODY_MAX = 60_000;
const CODECOMMIT_BODY_MAX = 10_000;

// ── Credentials ───────────────────────────────────────────────────────────────

export type PrCredentials =
  | { kind: 'github'; token: string }
  | { kind: 'codecommit'; region: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | null;

// ── Test seam ─────────────────────────────────────────────────────────────────

/** The part of a CodeCommit client this module uses. */
export interface CodeCommitLike { send(command: any): Promise<any> }

interface Clients {
  fetch: typeof fetch;
  codecommit: (creds: { region: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string }) => Promise<CodeCommitLike> | CodeCommitLike;
  credentials: (repo: Repository, kind: 'github' | 'codecommit') => Promise<PrCredentials>;
}

const defaults: Clients = {
  fetch: (input, init) => fetch(input, init),
  codecommit: async (c) => {
    const { CodeCommitClient } = await import('@aws-sdk/client-codecommit');
    return new CodeCommitClient({
      region: c.region,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken },
    });
  },
  credentials: resolveCredentials,
};

let clients: Clients = { ...defaults };

/** Test seam, like `_providers` in review.ts. Call with no argument to restore the real clients. */
export function _setPullRequestClients(over: Partial<Clients> = {}): void {
  clients = { ...defaults, ...over };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Remove credentials from text that is sent to a host or shown to a person. */
export function scrubSecrets(text: string): string {
  return redactCredentials(text)
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '***')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '***')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 ***')
    .replace(/\b(aws_secret_access_key|aws_session_token|secret_access_key|password|token)(\s*[=:]\s*)["']?[^\s"']{8,}["']?/gi, '$1$2***');
}

function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…';
}

function noPermission(repo: Repository): PullRequestError {
  return new PullRequestError(
    'no-permission',
    `No permission to open a pull request on ${repo.name || 'this repository'}. A GitHub token needs repo write access; CodeCommit needs GitPush and CreatePullRequest.`,
  );
}

function failed(message: string): PullRequestError {
  return new PullRequestError('failed', cut(scrubSecrets(message), 500));
}

const CODECOMMIT_HOST_RE = /git-codecommit(-fips)?\.([a-z0-9-]+)\.(vpce\.)?amazonaws\.com/;
const CODECOMMIT_GRC_RE = /^codecommit:(?::([a-z0-9-]+))?\/\/(?:[A-Za-z0-9_-]+@)?([A-Za-z0-9_.-]+)$/;

function hostKind(repo: Repository): 'github' | 'codecommit' | null {
  const url = repo.url ?? '';
  if (repo.provider === 'github' || /^https:\/\/github\.com\//i.test(url)) return 'github';
  if (repo.provider === 'codecommit' || CODECOMMIT_HOST_RE.test(url) || CODECOMMIT_GRC_RE.test(url)) return 'codecommit';
  return null;
}

function codecommitTarget(url: string): { name: string; region: string | null } | null {
  const grc = url.match(CODECOMMIT_GRC_RE);
  if (grc) return { name: grc[2], region: grc[1] ?? null };
  const name = parseCodeCommitRepoName(url);
  if (!name) return null;
  return { name, region: url.match(CODECOMMIT_HOST_RE)?.[2] ?? null };
}

// ── Credential lookup (same order as getCloneEnv in repos.ts) ─────────────────

async function resolveCredentials(repo: Repository, kind: 'github' | 'codecommit'): Promise<PrCredentials> {
  if (kind === 'codecommit' && repo.project_id) {
    try {
      const { projectAwsEnv } = await import('./project-aws.ts');
      const env = await projectAwsEnv(String(repo.project_id));
      if (env?.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
        return {
          kind: 'codecommit',
          region: env.AWS_REGION || 'us-east-1',
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          sessionToken: env.AWS_SESSION_TOKEN,
        };
      }
    } catch { /* fall back to the connection */ }
  }

  if (!repo.connection_id) return null;
  const conn = await getGitConnectionsRepository().getById(repo.connection_id);
  if (!conn?.credentials_enc) return null;
  let creds: Record<string, string>;
  try {
    creds = parseJson<Record<string, string>>(decrypt(conn.credentials_enc, config.secretKey), {});
  } catch {
    return null;
  }

  if (kind === 'github') return creds.token ? { kind: 'github', token: creds.token } : null;
  if (conn.provider !== 'codecommit') return null;

  const region = creds.region || 'us-east-1';
  const mode = creds.mode ?? 'keys';
  let src: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string } = {};
  if (mode === 'keys') {
    src = creds;
  } else if (mode === 'aws-account') {
    const { readDefaultId } = await import('./project-aws.ts');
    const accountId = creds.awsAccountId || (repo.project_id ? readDefaultId(String(repo.project_id)) : null);
    const acc = accountId ? await getAwsAccountsRepository().getById(accountId) : null;
    if (acc && (!repo.project_id || !acc.project_id || String(acc.project_id) === String(repo.project_id)) && acc.auth_method === 'keys' && acc.credentials_enc) {
      src = parseJson<Record<string, string>>(decrypt(acc.credentials_enc, config.secretKey), {});
    }
  } else if (mode === 'portal-sso') {
    const { getBedrockSsoCredentials } = await import('./bedrock-sso.ts');
    src = await getBedrockSsoCredentials();
  }
  if (!src.accessKeyId || !src.secretAccessKey) return null;
  return { kind: 'codecommit', region, accessKeyId: src.accessKeyId, secretAccessKey: src.secretAccessKey, sessionToken: src.sessionToken };
}

// ── GitHub ────────────────────────────────────────────────────────────────────

/** Unknown state keeps duplicate protection in place; only confirmed closed PRs can be replaced. */
export async function githubPullRequestState(repo: Repository, number: number): Promise<'open' | 'closed' | null> {
  if (hostKind(repo) !== 'github' || !Number.isSafeInteger(number) || number < 1) return null;
  const slug = parseGitHubOwnerRepo(repo.url);
  if (!slug) return null;
  try {
    const creds = await clients.credentials(repo, 'github');
    if (creds?.kind !== 'github') return null;
    const response = await clients.fetch(`https://api.github.com/repos/${encodeURIComponent(slug.owner)}/${encodeURIComponent(slug.repo)}/pulls/${number}`, {
      headers: { Authorization: `Bearer ${creds.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const value = await response.json();
    return value?.state === 'open' || value?.state === 'closed' ? value.state : null;
  } catch { return null; }
}

async function createOnGitHub(input: CreatePrInput, title: string, body: string): Promise<CreatedPr> {
  const { repo, base, head } = input;
  const slug = parseGitHubOwnerRepo(repo.url);
  if (!slug) throw failed('Cannot read the owner and repository name from the GitHub address.');
  const creds = await clients.credentials(repo, 'github');
  if (!creds || creds.kind !== 'github') throw noPermission(repo);

  const api = `https://api.github.com/repos/${encodeURIComponent(slug.owner)}/${encodeURIComponent(slug.repo)}/pulls`;
  const headers = {
    Authorization: `Bearer ${creds.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };

  let res: Response;
  try {
    res = await clients.fetch(api, {
      method: 'POST', headers, body: JSON.stringify({ title, body, head, base }), signal: AbortSignal.timeout(20_000),
    });
  } catch (e: any) {
    throw failed(`GitHub could not be reached: ${e?.message ?? e}`);
  }

  if (res.status === 201 || res.status === 200) {
    const j: any = await res.json().catch(() => ({}));
    if (!j.number || !j.html_url) throw failed('GitHub answered without a pull request number.');
    return { number: j.number, url: j.html_url, existing: false };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) throw noPermission(repo);

  const text = await res.text().catch(() => '');
  if (res.status === 422 && /already exists/i.test(text)) {
    const q = `${api}?state=open&head=${encodeURIComponent(`${slug.owner}:${head}`)}&base=${encodeURIComponent(base)}`;
    let list: Response;
    try {
      list = await clients.fetch(q, { method: 'GET', headers, signal: AbortSignal.timeout(20_000) });
    } catch (e: any) {
      throw failed(`GitHub could not be reached: ${e?.message ?? e}`);
    }
    if (list.status === 401 || list.status === 403 || list.status === 404) throw noPermission(repo);
    const arr: any = await list.json().catch(() => []);
    const hit = Array.isArray(arr) ? arr[0] : null;
    if (hit?.number && hit.html_url) return { number: hit.number, url: hit.html_url, existing: true };
    throw failed('A pull request for this branch already exists, but it could not be found.');
  }
  let detail = text;
  try {
    const j = JSON.parse(text);
    detail = [j.message, ...(Array.isArray(j.errors) ? j.errors.map((x: any) => x.message).filter(Boolean) : [])].filter(Boolean).join(': ');
  } catch { /* keep raw text */ }
  throw failed(`GitHub refused the pull request (${res.status}): ${detail}`);
}

// ── CodeCommit ────────────────────────────────────────────────────────────────

function awsErrorName(e: unknown): string {
  return String((e as any)?.name ?? (e as any)?.code ?? '');
}

async function createOnCodeCommit(input: CreatePrInput, title: string, body: string): Promise<CreatedPr> {
  const { repo, base, head } = input;
  const target = codecommitTarget(repo.url);
  if (!target) throw failed('Cannot read the repository name from the CodeCommit address.');
  const creds = await clients.credentials(repo, 'codecommit');
  if (!creds || creds.kind !== 'codecommit') throw noPermission(repo);
  const region = target.region || creds.region;
  const { CreatePullRequestCommand, ListPullRequestsCommand, GetPullRequestCommand } = await import('@aws-sdk/client-codecommit');
  const client = await clients.codecommit({ ...creds, region });
  const urlFor = (id: string) =>
    `https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/${encodeURIComponent(target.name)}/pull-requests/${id}?region=${region}`;
  const toResult = (id: string, existing: boolean): CreatedPr => ({ number: Number(id), url: urlFor(id), existing });

  const mapError = (e: unknown): never => {
    const name = awsErrorName(e);
    if (/AccessDenied|Authorization|Unauthorized|InvalidUserArn/i.test(name)) throw noPermission(repo);
    if (/ExpiredToken|TokenRefresh/i.test(name)) throw failed('The AWS credentials have expired. Refresh them and try again.');
    throw failed(`CodeCommit refused the pull request${name ? ` (${name})` : ''}: ${(e as any)?.message ?? e}`);
  };

  try {
    const out = await client.send(new CreatePullRequestCommand({
      title,
      description: body,
      targets: [{ repositoryName: target.name, sourceReference: head, destinationReference: base }],
    }));
    const id = out?.pullRequest?.pullRequestId;
    if (!id) throw failed('CodeCommit answered without a pull request id.');
    return toResult(String(id), false);
  } catch (e) {
    if (e instanceof PullRequestError) throw e;
    if (awsErrorName(e) !== 'PullRequestAlreadyExistsException') return mapError(e);
  }

  // Already exists: find the open one with the same source and destination.
  try {
    let nextToken: string | undefined;
    let seen = 0;
    do {
      const page: any = await client.send(new ListPullRequestsCommand({ repositoryName: target.name, pullRequestStatus: 'OPEN', nextToken }));
      for (const id of page?.pullRequestIds ?? []) {
        if (++seen > 100) break;
        const got: any = await client.send(new GetPullRequestCommand({ pullRequestId: id }));
        const t = got?.pullRequest?.pullRequestTargets?.[0];
        if (t && t.sourceReference?.replace(/^refs\/heads\//, '') === head && t.destinationReference?.replace(/^refs\/heads\//, '') === base) {
          return toResult(String(id), true);
        }
      }
      nextToken = seen > 100 ? undefined : page?.nextToken;
    } while (nextToken);
  } catch (e) {
    if (e instanceof PullRequestError) throw e;
    return mapError(e);
  }
  throw failed('A pull request for this branch already exists, but it could not be found.');
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function createPullRequest(input: CreatePrInput): Promise<CreatedPr> {
  const kind = hostKind(input.repo);
  if (!kind) {
    throw new PullRequestError('unsupported', 'Pull requests are only opened on GitHub and CodeCommit. The branch was pushed; open the pull request on the host.');
  }
  const title = cut(scrubSecrets(String(input.title ?? '')).replace(/\s+/g, ' ').trim(), TITLE_MAX) || input.head;
  const body = cut(scrubSecrets(String(input.body ?? '')), kind === 'codecommit' ? CODECOMMIT_BODY_MAX : BODY_MAX);
  return kind === 'github' ? createOnGitHub(input, title, body) : createOnCodeCommit(input, title, body);
}
