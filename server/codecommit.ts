/**
 * List CodeCommit repositories available to the configured AWS sign-in.
 *
 * Endpoint: GET /api/projects/:pid/codecommit/repos?region=<optional>
 *
 * Access: same as the connect-repository endpoint (project editor or above).
 * Credentials: resolved via awsEnv() — all auth methods except 'bedrock-key'
 * (which is CodeCommit-incompatible — returns 400).
 *
 * AWS SDK client factory is injectable via setCodeCommitClientFactory for tests.
 */

import {
  CodeCommitClient,
  ListRepositoriesCommand,
  BatchGetRepositoriesCommand,
  CreatePullRequestCommand,
  GetPullRequestCommand,
  ListPullRequestsCommand,
  PostCommentForPullRequestCommand,
} from '@aws-sdk/client-codecommit';
import { fromIni } from '@aws-sdk/credential-providers';
import { get } from './http.ts';
import { getSettings } from './settings.ts';
import { badRequest, HttpError } from './util.ts';
import { requireProject } from './projects.ts';

// ---- Types -------------------------------------------------------

export interface CodeCommitRepo {
  name: string;
  description: string;
  cloneUrlHttp: string;
  defaultBranch: string;
  lastModified: string | null;
}

// ---- Client factory seam (injectable for tests) ------------------

type CodeCommitFactory = (region: string, credentials: AwsCredentials) => CodeCommitClient;

export interface AwsCredentials {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** A named profile on the server (a project that signs in with a profile). */
  profile?: string;
}

let _ccFactory: CodeCommitFactory = (region, credentials) => {
  // If explicit key/secret provided, use them; otherwise fall back to SDK default chain
  if (credentials.accessKeyId && credentials.secretAccessKey) {
    return new CodeCommitClient({
      region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    });
  }
  if (credentials.profile) {
    return new CodeCommitClient({ region, credentials: fromIni({ profile: credentials.profile, ignoreCache: true }) });
  }
  return new CodeCommitClient({ region });
};

/** Override the CodeCommit client factory (test seam). */
export function setCodeCommitClientFactory(f: CodeCommitFactory): void {
  _ccFactory = f;
}

function ccClient(region: string, credentials: AwsCredentials): CodeCommitClient {
  return _ccFactory(region, credentials);
}

// ---- Region validation -------------------------------------------

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

// ---- Resolve credentials from the configured sign-in method ------

/**
 * Returns { region, credentials } for CodeCommit.
 * Throws 400 if bedrock-key is configured (not supported for CodeCommit).
 */
async function resolveCodeCommitCredentials(
  projectId: string,
  overrideRegion?: string,
): Promise<{ region: string; credentials: AwsCredentials }> {
  // A project with its own AWS account uses it. Otherwise the Settings credentials apply, as before.
  const { projectHasOwnAws, projectAwsCredentials } = await import('./project-aws.ts');
  if (projectHasOwnAws(projectId)) {
    const c = await projectAwsCredentials(projectId);
    return { region: overrideRegion || c.region, credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken, profile: c.profile } };
  }
  const s = getSettings();
  const auth = s.aws.auth;

  if (auth === 'bedrock-key') {
    throw badRequest(
      'The Bedrock API key sign-in method does not support CodeCommit. ' +
        'Switch to a different AWS sign-in method in Settings › AWS sign-in.',
    );
  }

  const region = overrideRegion || s.aws.region;

  // Import here to avoid circular deps (settings → codecommit would be circular;
  // this module imports from settings but settings doesn't import us)
  const { awsEnv } = await import('./settings.ts');
  const env = await awsEnv();

  const credentials: AwsCredentials = {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
    // A named profile has no keys in the environment; the SDK must be told which profile to read.
    profile: !env.AWS_ACCESS_KEY_ID ? env.AWS_PROFILE : undefined,
  };

  return { region, credentials };
}

// ---- Error mapping -----------------------------------------------

function mapAwsError(e: unknown): never {
  const name: string = (e as any)?.name ?? (e as any)?.code ?? '';
  const msg: string = (e as any)?.message ?? String(e);

  if (name === 'AccessDeniedException' || name === 'AuthorizationException') {
    throw badRequest(
      'Access denied. The AWS identity does not have permission to list CodeCommit repositories.',
    );
  }

  if (
    name === 'ExpiredTokenException' ||
    name === 'TokenRefreshRequired' ||
    name === 'UnauthorizedException'
  ) {
    throw badRequest(
      'AWS credentials have expired. Sign in with AWS SSO again in Settings › AWS sign-in.',
    );
  }

  if (name === 'InvalidUserArn' || name === 'EncryptionIntegrityChecksFailedException') {
    throw badRequest(`AWS CodeCommit error: ${msg}`);
  }

  // Rethrow as 502 for unexpected SDK errors
  throw new HttpError(502, `CodeCommit returned an error: ${msg}`);
}

// ---- Core logic --------------------------------------------------

/** Fetch all repository names via paginated ListRepositories, then enrich with BatchGetRepositories. */
export async function listCodeCommitRepos(
  region: string,
  credentials: AwsCredentials,
): Promise<CodeCommitRepo[]> {
  const client = ccClient(region, credentials);

  // 1. ListRepositories (paginated) — returns only id + name
  const names: string[] = [];
  let nextToken: string | undefined;
  try {
    do {
      const res = await client.send(
        new ListRepositoriesCommand({
          nextToken,
          sortBy: 'repositoryName',
          order: 'ascending',
        }),
      );
      for (const r of res.repositories ?? []) {
        if (r.repositoryName) names.push(r.repositoryName);
      }
      nextToken = res.nextToken;
    } while (nextToken);
  } catch (e) {
    mapAwsError(e);
  }

  if (names.length === 0) return [];

  // 2. BatchGetRepositories (max 25 per call) — adds description, clone URL, etc.
  const CHUNK = 25;
  const repos: CodeCommitRepo[] = [];

  for (let i = 0; i < names.length; i += CHUNK) {
    const chunk = names.slice(i, i + CHUNK);
    try {
      const res = await client.send(
        new BatchGetRepositoriesCommand({ repositoryNames: chunk }),
      );
      for (const r of res.repositories ?? []) {
        repos.push({
          name: r.repositoryName ?? '',
          description: r.repositoryDescription ?? '',
          cloneUrlHttp: r.cloneUrlHttp ?? '',
          defaultBranch: r.defaultBranch ?? '',
          lastModified:
            r.lastModifiedDate instanceof Date
              ? r.lastModifiedDate.toISOString()
              : typeof r.lastModifiedDate === 'number'
                ? new Date(r.lastModifiedDate).toISOString()
                : null,
        });
      }
    } catch (e) {
      mapAwsError(e);
    }
  }

  return repos;
}

// ---- Pull requests -----------------------------------------------

const CC_HTTPS_RE = /^https:\/\/git-codecommit\.([a-z0-9-]+)\.amazonaws\.com\/v1\/repos\/([A-Za-z0-9_.-]+)$/;
const CC_GRC_RE = /^codecommit:(?::([a-z0-9-]+):)?\/\/(?:([A-Za-z0-9_-]+)@)?([A-Za-z0-9_.-]+)$/;

/** Repository name, region and profile named in a CodeCommit address (HTTPS or git-remote-codecommit form). */
export function codeCommitTarget(url: string): { repositoryName: string; region?: string; profile?: string } | null {
  const h = url.match(CC_HTTPS_RE);
  if (h) return { repositoryName: h[2], region: h[1] };
  const g = url.match(CC_GRC_RE);
  if (g) return { repositoryName: g[3], region: g[1] || undefined, profile: g[2] || undefined };
  return null;
}

/** The CodeCommit console page of a pull request. */
export function codeCommitPrUrl(region: string, repositoryName: string, id: string | number): string {
  return `https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/${encodeURIComponent(repositoryName)}/pull-requests/${id}/details?region=${region}`;
}

function prError(e: unknown, source: string, destination: string): never {
  const name: string = (e as any)?.name ?? (e as any)?.code ?? '';
  const msg: string = (e as any)?.message ?? String(e);
  if (name === 'AccessDeniedException' || name === 'AuthorizationException') {
    throw badRequest('The AWS identity may not open pull requests in this CodeCommit repository (it needs codecommit:CreatePullRequest).');
  }
  if (name === 'ExpiredTokenException' || name === 'TokenRefreshRequired' || name === 'UnauthorizedException') {
    throw badRequest('AWS credentials have expired. Sign in with AWS SSO again in Settings › AWS sign-in.');
  }
  if (name === 'ReferenceDoesNotExistException') throw badRequest(`CodeCommit has no branch "${source}" or "${destination}" in this repository.`);
  if (name === 'SourceAndDestinationAreSameException') throw badRequest(`"${source}" and "${destination}" point at the same commit, so there is nothing to review.`);
  throw new HttpError(502, `CodeCommit could not open the pull request: ${msg}`);
}

/**
 * Open a pull request from `source` into `destination`, or return the open one that already does exactly that
 * (asking twice must not create duplicates). CodeCommit has no draft pull requests.
 */
export async function openCodeCommitPullRequest(
  region: string,
  credentials: AwsCredentials,
  repositoryName: string,
  pr: { title: string; description: string; source: string; destination: string },
): Promise<{ number: number; url: string; existing: boolean }> {
  const client = ccClient(region, credentials);
  const src = `refs/heads/${pr.source}`;
  const dst = `refs/heads/${pr.destination}`;
  const same = (ref: string | undefined, want: string) => ref === want || `refs/heads/${ref}` === want;
  try {
    // A duplicate would be among the newest open ones.
    for (const id of await newestOpenIds(client, repositoryName, 20)) {
      const got = await client.send(new GetPullRequestCommand({ pullRequestId: id }));
      const t = got.pullRequest?.pullRequestTargets?.find((x) => x.repositoryName === repositoryName);
      if (t && same(t.sourceReference, src) && same(t.destinationReference, dst)) {
        return { number: Number(id), url: codeCommitPrUrl(region, repositoryName, id), existing: true };
      }
    }
  } catch (e) {
    // Reading open pull requests is only a duplicate check; creating still reports a real problem.
    const name = (e as any)?.name ?? '';
    if (name !== 'AccessDeniedException' && name !== 'AuthorizationException') prError(e, pr.source, pr.destination);
  }
  try {
    const res = await client.send(
      new CreatePullRequestCommand({
        title: pr.title.slice(0, 150),
        description: pr.description.slice(0, 10_240),
        targets: [{ repositoryName, sourceReference: src, destinationReference: dst }],
      }),
    );
    const id = res.pullRequest?.pullRequestId ?? '';
    if (!id) throw new HttpError(502, 'CodeCommit did not return a pull request id');
    return { number: Number(id), url: codeCommitPrUrl(region, repositoryName, id), existing: false };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    prError(e, pr.source, pr.destination);
  }
}

/**
 * Put one comment on a pull request (NEW-3: the summary of a review). CodeCommit comments are anchored to the two
 * commits the pull request compares, which are read first; the comment is not attached to a file or line.
 */
export async function postCodeCommitPullComment(region: string, credentials: AwsCredentials, repositoryName: string, id: number, content: string): Promise<void> {
  const client = ccClient(region, credentials);
  try {
    const got = await client.send(new GetPullRequestCommand({ pullRequestId: String(id) }));
    const t = got.pullRequest?.pullRequestTargets?.find((x) => x.repositoryName === repositoryName);
    if (!t?.sourceCommit || !t.destinationCommit) throw new HttpError(502, `CodeCommit did not return the commits of pull request #${id}`);
    await client.send(
      new PostCommentForPullRequestCommand({
        pullRequestId: String(id),
        repositoryName,
        beforeCommitId: t.destinationCommit,
        afterCommitId: t.sourceCommit,
        content: content.slice(0, 10_000),
      }),
    );
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const name = (e as any)?.name ?? '';
    if (name === 'AccessDeniedException' || name === 'AuthorizationException') {
      throw badRequest('The AWS identity may not comment on pull requests in this CodeCommit repository (it needs codecommit:PostCommentForPullRequest).');
    }
    if (name === 'PullRequestDoesNotExistException') throw badRequest(`CodeCommit has no pull request #${id}`);
    mapAwsError(e);
  }
}

// ---- Route registration ------------------------------------------

/** One pull request, in the shape the review picker uses. */
export interface CodeCommitPull {
  number: number;
  title: string;
  head: string;
  base: string;
  /** The source branch's commit the pull request points at. */
  sha: string;
}

const branchOf = (ref: string | undefined) => String(ref ?? '').replace(/^refs\/heads\//, '');

/** The ids of the newest open pull requests. CodeCommit lists them in no useful order, so all pages are read first. */
async function newestOpenIds(client: CodeCommitClient, repositoryName: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const open = await client.send(new ListPullRequestsCommand({ repositoryName, pullRequestStatus: 'OPEN', maxResults: 100, nextToken }));
    ids.push(...(open.pullRequestIds ?? []));
    nextToken = open.nextToken;
    if (!nextToken) break;
  }
  return ids.sort((a, b) => Number(b) - Number(a)).slice(0, n);
}

async function readPull(client: CodeCommitClient, repositoryName: string, id: string): Promise<CodeCommitPull | null> {
  const got = await client.send(new GetPullRequestCommand({ pullRequestId: id }));
  const t = got.pullRequest?.pullRequestTargets?.find((x) => x.repositoryName === repositoryName);
  if (!t) return null;
  return { number: Number(id), title: got.pullRequest?.title ?? '', head: branchOf(t.sourceReference), base: branchOf(t.destinationReference), sha: t.sourceCommit ?? '' };
}

/** The newest open pull requests of a repository (at most 30), newest first. */
export async function listCodeCommitPullRequests(region: string, credentials: AwsCredentials, repositoryName: string): Promise<CodeCommitPull[]> {
  const client = ccClient(region, credentials);
  try {
    const ids = await newestOpenIds(client, repositoryName, 30);
    const out: CodeCommitPull[] = [];
    // A busy repository has dozens open and CodeCommit throttles bursts, so read a few at a time and retry a
    // throttled read; one that still fails is left out instead of failing the whole list.
    const readSoft = async (id: string): Promise<CodeCommitPull | null> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await readPull(client, repositoryName, id);
        } catch (e) {
          const name = (e as any)?.name ?? '';
          const throttled = name === 'ThrottlingException' || /rate exceeded/i.test((e as any)?.message ?? '');
          if (!throttled) throw e;
          if (attempt >= 4) return null;
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
    };
    for (let i = 0; i < ids.length; i += 4) {
      for (const p of await Promise.all(ids.slice(i, i + 4).map(readSoft))) if (p) out.push(p);
    }
    return out.sort((a, b) => b.number - a.number);
  } catch (e) {
    const name = (e as any)?.name ?? '';
    if (name === 'AccessDeniedException' || name === 'AuthorizationException') {
      throw badRequest('The AWS identity may not read pull requests in this CodeCommit repository (it needs codecommit:ListPullRequests and codecommit:GetPullRequest).');
    }
    mapAwsError(e);
  }
}

/** One pull request (any status) of a repository. */
export async function getCodeCommitPullRequest(region: string, credentials: AwsCredentials, repositoryName: string, id: number): Promise<CodeCommitPull> {
  const client = ccClient(region, credentials);
  let p: CodeCommitPull | null = null;
  try {
    p = await readPull(client, repositoryName, String(id));
  } catch (e) {
    const name = (e as any)?.name ?? '';
    if (name === 'PullRequestDoesNotExistException') throw badRequest(`CodeCommit has no pull request #${id}`);
    if (name === 'AccessDeniedException' || name === 'AuthorizationException') throw badRequest('The AWS identity may not read pull requests in this CodeCommit repository (it needs codecommit:GetPullRequest).');
    mapAwsError(e);
  }
  if (!p) throw badRequest(`Pull request #${id} is not for ${repositoryName}`);
  return p;
}

export function registerCodeCommitRoutes(): void {
  /**
   * GET /api/projects/:pid/codecommit/repos?region=<optional>
   *
   * Returns { repos: CodeCommitRepo[], region: string }
   * Auth: project member (any access), bedrock-key → 400, not configured → 400
   */
  get('/api/projects/:pid/codecommit/repos', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);

    const rawRegion = ctx.query.get('region') ?? '';
    if (rawRegion && !REGION_RE.test(rawRegion)) {
      throw badRequest('Region format looks wrong (for example ap-southeast-1)');
    }

    const { region, credentials } = await resolveCodeCommitCredentials(project.id, rawRegion || undefined);
    const repos = await listCodeCommitRepos(region, credentials);
    return { repos, region };
  });
}
