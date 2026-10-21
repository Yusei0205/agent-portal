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

interface AwsCredentials {
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

// ---- Route registration ------------------------------------------

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
