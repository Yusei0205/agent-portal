/**
 * CodeCommit listing — unit / integration tests.
 *
 * Covered:
 *   1. ListRepositories pagination (>25 repos triggers BatchGetRepositories chunking)
 *   2. BatchGetRepositories chunking — two chunks when >25 repos
 *   3. Returned fields (name, description, cloneUrlHttp, defaultBranch, lastModified)
 *   4. No credentials in response — accessKeyId / secretAccessKey never sent to client
 *   5. Region param validation (invalid format → 400) and region default (uses settings.aws.region)
 *   6. bedrock-key auth returns 400 with a clear message
 *   7. AccessDeniedException / AuthorizationException → mapped to "Access denied" 400
 *   8. ExpiredTokenException / UnauthorizedException → mapped to "sign in again" 400
 *   9. Access rules: unauthenticated → 404, non-member / viewer → still allowed (viewer can list),
 *      missing CSRF header → 403
 *  10. Works with auth=sso (uses ssoCredentials)
 *  11. Works with auth=keys
 *  12. Empty repository list returns { repos: [], region }
 *  13. UI source: Repos.jsx CodeCommitPicker exists and uses role="listbox"/role="option"
 *  14. UI source: manual address fallback toggle exists in AddRepo
 *  15. UI source: RegionSelect used in CodeCommitPicker (region dropdown)
 *
 * All AWS SDK calls are intercepted via setCodeCommitClientFactory (same seam as sso.ts).
 * No real network calls are made.
 */

import { test, before, after, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bootServer, Client, type TestServer } from './client.ts';

// ─── AWS SDK command-name helpers ────────────────────────────────────────────

type AnyCmd = { constructor: { name: string }; input?: Record<string, unknown> };

/** Build a mock CodeCommit client from a handler function. */
function makeCcClient(handler: (cmd: AnyCmd) => Promise<any>) {
  return { send: handler } as any;
}

// ─── Lazily-resolved server modules ──────────────────────────────────────────

let ccMod: typeof import('../server/codecommit.ts');
let settingsMod: typeof import('../server/settings.ts');
let ssoMod: typeof import('../server/sso.ts');

// ─── Server bootstrap ─────────────────────────────────────────────────────────

let srv: TestServer;
let admin: Client;
let editor: Client;   // project editor (non-admin)
let viewer: Client;   // project viewer (non-admin)
let stranger: Client; // logged-in but NOT a project member
let pid: string;

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);
  editor = new Client(srv.base);
  viewer = new Client(srv.base);
  stranger = new Client(srv.base);

  // Load server modules after bootServer so DATA_DIR + DB are ready
  ccMod = await import('../server/codecommit.ts');
  settingsMod = await import('../server/settings.ts');
  ssoMod = await import('../server/sso.ts');

  // Create admin account
  await admin.post('/api/auth/setup', {
    email: 'cc-admin@example.com',
    name: 'CC Admin',
    password: 'a-very-long-test-password',
  });

  // Create editor, viewer, stranger users
  await admin.post('/api/users', { email: 'cc-editor@example.com', name: 'CC Editor', password: 'a-very-long-test-password-2' });
  await admin.post('/api/users', { email: 'cc-viewer@example.com', name: 'CC Viewer', password: 'a-very-long-test-password-3' });
  await admin.post('/api/users', { email: 'cc-stranger@example.com', name: 'CC Stranger', password: 'a-very-long-test-password-4' });

  await editor.post('/api/auth/login', { email: 'cc-editor@example.com', password: 'a-very-long-test-password-2' });
  await viewer.post('/api/auth/login', { email: 'cc-viewer@example.com', password: 'a-very-long-test-password-3' });
  await stranger.post('/api/auth/login', { email: 'cc-stranger@example.com', password: 'a-very-long-test-password-4' });

  // Create a project and add editor + viewer as members
  const { project } = await admin.post('/api/projects', { name: 'CC Test Project', description: 'For codecommit tests' });
  pid = project.id;
  await admin.post(`/api/projects/${pid}/members`, { email: 'cc-editor@example.com', access: 'editor', role: 'Backend developer' });
  await admin.post(`/api/projects/${pid}/members`, { email: 'cc-viewer@example.com', access: 'viewer', role: 'Business analyst' });

  // Use bedrock + keys auth as the default for most tests
  await admin.put('/api/settings', {
    provider: { mode: 'bedrock' },
    aws: { region: 'ap-southeast-1', auth: 'keys' },
  });
  // Store dummy keys so auth=keys doesn't throw "Add an AWS access key" error
  await admin.post('/api/settings/secrets/aws.access_key_id', { value: 'AKIAIOSFODNN7EXAMPLE' });
  await admin.post('/api/settings/secrets/aws.secret_access_key', { value: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' });
});

after(() => srv.close());

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Build a minimal repos list of `count` entries with distinct names. */
function buildRepoNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `repo-${String(i + 1).padStart(3, '0')}`);
}

/** Build BatchGetRepositories response from a list of names. */
function buildBatchResponse(names: string[]) {
  return {
    repositories: names.map((name) => ({
      repositoryName: name,
      repositoryDescription: `Description of ${name}`,
      cloneUrlHttp: `https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/${name}`,
      defaultBranch: 'main',
      lastModifiedDate: new Date('2025-06-01T00:00:00Z'),
    })),
    errors: [],
  };
}

/** No-CSRF raw fetch helper (matching sso.test.ts pattern). */
async function noCsrf(base: string, method: string, url: string) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json' },
  });
  return { status: res.status, data: await res.json() };
}

const URL_BASE = () => `/api/projects/${pid}/codecommit/repos`;

// ─────────────────────────────────────────────────────────────────────────────
// 1 & 2. Pagination + BatchGetRepositories chunking (>25 repos)
// ─────────────────────────────────────────────────────────────────────────────

describe('ListRepositories pagination + BatchGetRepositories chunking', () => {
  test('single-page response with ≤25 repos uses one BatchGetRepositories call', async () => {
    const names = buildRepoNames(3);
    let listCalls = 0;
    let batchCalls = 0;

    ccMod.setCodeCommitClientFactory((_region: string, _creds: any) =>
      makeCcClient(async (cmd: AnyCmd) => {
        const name = cmd.constructor.name;
        if (name === 'ListRepositoriesCommand') {
          listCalls++;
          return {
            repositories: names.map((n) => ({ repositoryId: n, repositoryName: n })),
            nextToken: undefined,
          };
        }
        if (name === 'BatchGetRepositoriesCommand') {
          batchCalls++;
          const requestedNames: string[] = (cmd.input?.repositoryNames as string[]) ?? [];
          return buildBatchResponse(requestedNames);
        }
        throw new Error(`Unexpected CodeCommit command: ${name}`);
      }),
    );

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
    assert.equal(listCalls, 1, 'ListRepositories must be called once for single page');
    assert.equal(batchCalls, 1, 'BatchGetRepositories must be called once for ≤25 repos');
    assert.equal(r.data.repos.length, 3);
  });

  test('multi-page ListRepositories follows nextToken across pages', async () => {
    const page1Names = buildRepoNames(15);
    const page2Names = buildRepoNames(10).map((n) => n.replace('repo-', 'repo-b-'));
    const allNames = [...page1Names, ...page2Names];
    let listPagesSeen = 0;

    ccMod.setCodeCommitClientFactory((_region: string, _creds: any) =>
      makeCcClient(async (cmd: AnyCmd) => {
        const n = cmd.constructor.name;
        if (n === 'ListRepositoriesCommand') {
          const nt = (cmd.input as any)?.nextToken;
          listPagesSeen++;
          if (!nt) {
            return {
              repositories: page1Names.map((name) => ({ repositoryName: name })),
              nextToken: 'page-2-token',
            };
          }
          return {
            repositories: page2Names.map((name) => ({ repositoryName: name })),
            nextToken: undefined,
          };
        }
        if (n === 'BatchGetRepositoriesCommand') {
          const requested: string[] = (cmd.input?.repositoryNames as string[]) ?? [];
          return buildBatchResponse(requested);
        }
        throw new Error(`Unexpected command: ${n}`);
      }),
    );

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 200);
    assert.equal(listPagesSeen, 2, 'ListRepositories must follow nextToken across 2 pages');
    assert.equal(r.data.repos.length, allNames.length, `Expected ${allNames.length} repos`);
  });

  test('>25 repos triggers two BatchGetRepositories calls (chunked at 25)', async () => {
    // 30 repos → chunk 1: 25, chunk 2: 5
    const names = buildRepoNames(30);
    let batchCalls = 0;
    const batchSizes: number[] = [];

    ccMod.setCodeCommitClientFactory((_region: string, _creds: any) =>
      makeCcClient(async (cmd: AnyCmd) => {
        const n = cmd.constructor.name;
        if (n === 'ListRepositoriesCommand') {
          return {
            repositories: names.map((name) => ({ repositoryName: name })),
            nextToken: undefined,
          };
        }
        if (n === 'BatchGetRepositoriesCommand') {
          batchCalls++;
          const requested: string[] = (cmd.input?.repositoryNames as string[]) ?? [];
          batchSizes.push(requested.length);
          return buildBatchResponse(requested);
        }
        throw new Error(`Unexpected command: ${n}`);
      }),
    );

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 200);
    assert.equal(batchCalls, 2, 'Expected exactly 2 BatchGetRepositories calls for 30 repos');
    assert.equal(batchSizes[0], 25, 'First batch must contain 25 repos');
    assert.equal(batchSizes[1], 5, 'Second batch must contain remaining 5 repos');
    assert.equal(r.data.repos.length, 30);
  });

  test('exactly 25 repos uses a single BatchGetRepositories call', async () => {
    const names = buildRepoNames(25);
    let batchCalls = 0;

    ccMod.setCodeCommitClientFactory((_region: string, _creds: any) =>
      makeCcClient(async (cmd: AnyCmd) => {
        const n = cmd.constructor.name;
        if (n === 'ListRepositoriesCommand') {
          return { repositories: names.map((name) => ({ repositoryName: name })), nextToken: undefined };
        }
        if (n === 'BatchGetRepositoriesCommand') {
          batchCalls++;
          const requested: string[] = (cmd.input?.repositoryNames as string[]) ?? [];
          return buildBatchResponse(requested);
        }
        throw new Error(`Unexpected command: ${n}`);
      }),
    );

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 200);
    assert.equal(batchCalls, 1, '25 repos must use exactly 1 batch call');
    assert.equal(r.data.repos.length, 25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Returned fields
// ─────────────────────────────────────────────────────────────────────────────

describe('Returned fields', () => {
  test('each repo has name, description, cloneUrlHttp, defaultBranch, lastModified', async () => {
    const now = new Date('2025-06-15T12:00:00Z');
    ccMod.setCodeCommitClientFactory((_region: string, _creds: any) =>
      makeCcClient(async (cmd: AnyCmd) => {
        const n = cmd.constructor.name;
        if (n === 'ListRepositoriesCommand') {
          return { repositories: [{ repositoryName: 'my-repo' }], nextToken: undefined };
        }
        if (n === 'BatchGetRepositoriesCommand') {
          return {
            repositories: [{
              repositoryName: 'my-repo',
              repositoryDescription: 'A test repository',
              cloneUrlHttp: 'https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/my-repo',
              defaultBranch: 'develop',
              lastModifiedDate: now,
            }],
            errors: [],
          };
        }
        throw new Error(`Unexpected command: ${n}`);
      }),
    );

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 200);
    assert.equal(r.data.repos.length, 1);

    const repo = r.data.repos[0];
    assert.equal(repo.name, 'my-repo');
    assert.equal(repo.description, 'A test repository');
    assert.equal(repo.cloneUrlHttp, 'https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/my-repo');
    assert.equal(repo.defaultBranch, 'develop');
    assert.equal(repo.lastModified, now.toISOString());
  });

  test('missing optional fields are returned as empty string / null', async () => {
    ccMod.setCodeCommitClientFactory((_region: string, _creds: any) =>
      makeCcClient(async (cmd: AnyCmd) => {
        const n = cmd.constructor.name;
        if (n === 'ListRepositoriesCommand') {
          return { repositories: [{ repositoryName: 'bare-repo' }], nextToken: undefined };
        }
        if (n === 'BatchGetRepositoriesCommand') {
          return {
            repositories: [{
              repositoryName: 'bare-repo',
              // No description, no cloneUrlHttp, no defaultBranch, no lastModifiedDate
            }],
            errors: [],
          };
        }
        throw new Error(`Unexpected command: ${n}`);
      }),
    );

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 200);
    const repo = r.data.repos[0];
    assert.equal(repo.name, 'bare-repo');
    assert.equal(repo.description, '');
    assert.equal(repo.cloneUrlHttp, '');
    assert.equal(repo.defaultBranch, '');
    assert.equal(repo.lastModified, null);
  });

  test('response also includes region string at the top level', async () => {
    ccMod.setCodeCommitClientFactory((_region: string, _creds: any) =>
      makeCcClient(async (cmd: AnyCmd) => {
        const n = cmd.constructor.name;
        if (n === 'ListRepositoriesCommand') return { repositories: [], nextToken: undefined };
        throw new Error(`Unexpected command: ${n}`);
      }),
    );

    const r = await admin.req('GET', `${URL_BASE()}?region=us-west-2`);
    assert.equal(r.status, 200);
    assert.equal(r.data.region, 'us-west-2', 'response.region must echo back the requested region');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. No credentials in response
// ─────────────────────────────────────────────────────────────────────────────

describe('No credentials in response', () => {
  test('accessKeyId, secretAccessKey, sessionToken never appear in the API response', async () => {
    ccMod.setCodeCommitClientFactory((_region: string, _creds: any) =>
      makeCcClient(async (cmd: AnyCmd) => {
        const n = cmd.constructor.name;
        if (n === 'ListRepositoriesCommand') {
          return { repositories: [{ repositoryName: 'safe-repo' }], nextToken: undefined };
        }
        if (n === 'BatchGetRepositoriesCommand') {
          return {
            repositories: [{
              repositoryName: 'safe-repo',
              cloneUrlHttp: 'https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/safe-repo',
            }],
            errors: [],
          };
        }
        throw new Error(`Unexpected command: ${n}`);
      }),
    );

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 200);

    const body = JSON.stringify(r.data);
    assert.ok(!body.includes('accessKeyId'), 'accessKeyId must not appear in the response body');
    assert.ok(!body.includes('secretAccessKey'), 'secretAccessKey must not appear in the response body');
    assert.ok(!body.includes('sessionToken'), 'sessionToken must not appear in the response body');
    assert.ok(!body.includes('AKIAIOSFODNN7EXAMPLE'), 'raw access key ID must not appear in the response');
    assert.ok(!body.includes('wJalrXUtnFEMI'), 'raw secret key prefix must not appear in the response');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Region param validation and default
// ─────────────────────────────────────────────────────────────────────────────

describe('Region param validation and default', () => {
  test('invalid region format returns 400', async () => {
    const r = await admin.req('GET', `${URL_BASE()}?region=mars`);
    assert.equal(r.status, 400, 'Invalid region must return 400');
    assert.match(r.data.error, /region/i);
  });

  test('another invalid region format returns 400', async () => {
    const r = await admin.req('GET', `${URL_BASE()}?region=ap_southeast_1`);
    assert.equal(r.status, 400, 'Underscore region must return 400');
  });

  test('valid region format is accepted (ap-southeast-1)', async () => {
    ccMod.setCodeCommitClientFactory((_region: string, _creds: any) =>
      makeCcClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'ListRepositoriesCommand') return { repositories: [], nextToken: undefined };
        throw new Error(`Unexpected: ${cmd.constructor.name}`);
      }),
    );

    const r = await admin.req('GET', `${URL_BASE()}?region=ap-southeast-1`);
    assert.equal(r.status, 200, 'Valid region must not be rejected');
    assert.equal(r.data.region, 'ap-southeast-1');
  });

  test('valid region format is accepted (us-east-1)', async () => {
    ccMod.setCodeCommitClientFactory((_region: string, _creds: any) =>
      makeCcClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'ListRepositoriesCommand') return { repositories: [], nextToken: undefined };
        throw new Error(`Unexpected: ${cmd.constructor.name}`);
      }),
    );

    const r = await admin.req('GET', `${URL_BASE()}?region=us-east-1`);
    assert.equal(r.status, 200);
    assert.equal(r.data.region, 'us-east-1');
  });

  test('when no region param is given, settings.aws.region is used as default', async () => {
    let capturedRegion = '';
    ccMod.setCodeCommitClientFactory((region: string, _creds: any) => {
      capturedRegion = region;
      return makeCcClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'ListRepositoriesCommand') return { repositories: [], nextToken: undefined };
        throw new Error(`Unexpected: ${cmd.constructor.name}`);
      });
    });

    // settings.aws.region is ap-southeast-1 (set in before())
    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 200);
    assert.equal(capturedRegion, 'ap-southeast-1', 'Must use settings.aws.region when no query param');
    assert.equal(r.data.region, 'ap-southeast-1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. bedrock-key auth returns 400
// ─────────────────────────────────────────────────────────────────────────────

describe('bedrock-key auth returns 400', () => {
  before(async () => {
    await admin.put('/api/settings', {
      provider: { mode: 'bedrock' },
      aws: { region: 'ap-southeast-1', auth: 'bedrock-key' },
    });
  });

  after(async () => {
    // Restore keys auth for subsequent suites
    await admin.put('/api/settings', {
      provider: { mode: 'bedrock' },
      aws: { region: 'ap-southeast-1', auth: 'keys' },
    });
  });

  test('GET codecommit/repos returns 400 when auth=bedrock-key', async () => {
    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 400, 'bedrock-key must return 400 for CodeCommit');
    assert.ok(
      r.data.error?.includes('bedrock-key') ||
        r.data.error?.includes('Bedrock API key') ||
        r.data.error?.toLowerCase().includes('bedrock'),
      `Expected bedrock-key error, got: "${r.data.error}"`,
    );
  });

  test('400 message includes a hint to switch sign-in method in Settings', async () => {
    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 400);
    assert.ok(
      r.data.error?.toLowerCase().includes('setting') ||
        r.data.error?.toLowerCase().includes('sign-in'),
      `Error must hint at Settings, got: "${r.data.error}"`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 & 8. AWS errors mapped to clear messages
// ─────────────────────────────────────────────────────────────────────────────

describe('AWS error mapping', () => {
  function makeErrorClient(errorName: string, errorMessage: string) {
    return makeCcClient(async (cmd: AnyCmd) => {
      if (cmd.constructor.name === 'ListRepositoriesCommand') {
        throw Object.assign(new Error(errorMessage), { name: errorName });
      }
      throw new Error(`Unexpected command: ${cmd.constructor.name}`);
    });
  }

  test('AccessDeniedException → 400 "Access denied"', async () => {
    ccMod.setCodeCommitClientFactory(() => makeErrorClient('AccessDeniedException', 'User is not authorized'));

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 400);
    assert.match(r.data.error, /access denied/i);
  });

  test('AuthorizationException → 400 "Access denied"', async () => {
    ccMod.setCodeCommitClientFactory(() => makeErrorClient('AuthorizationException', 'Not authorized'));

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 400);
    assert.match(r.data.error, /access denied/i);
  });

  test('ExpiredTokenException → 400 with "sign in" / "expired" message', async () => {
    ccMod.setCodeCommitClientFactory(() => makeErrorClient('ExpiredTokenException', 'Token expired'));

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 400);
    assert.ok(
      r.data.error?.toLowerCase().includes('expired') ||
        r.data.error?.toLowerCase().includes('sign in'),
      `Expected expired-token message, got: "${r.data.error}"`,
    );
  });

  test('TokenRefreshRequired → 400 with "expired" / "sign in" message', async () => {
    ccMod.setCodeCommitClientFactory(() => makeErrorClient('TokenRefreshRequired', 'Token refresh required'));

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 400);
    assert.ok(
      r.data.error?.toLowerCase().includes('expired') ||
        r.data.error?.toLowerCase().includes('sign in'),
      `Expected expired-token message, got: "${r.data.error}"`,
    );
  });

  test('UnauthorizedException → 400 with "expired" / "sign in" message', async () => {
    ccMod.setCodeCommitClientFactory(() => makeErrorClient('UnauthorizedException', 'Unauthorized'));

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 400);
    assert.ok(
      r.data.error?.toLowerCase().includes('expired') ||
        r.data.error?.toLowerCase().includes('sign in'),
      `Expected expired-token message, got: "${r.data.error}"`,
    );
  });

  test('unknown AWS error → 502 (not a 200 or 400)', async () => {
    ccMod.setCodeCommitClientFactory(() =>
      makeCcClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'ListRepositoriesCommand') {
          throw Object.assign(new Error('Internal service error'), { name: 'ServiceException' });
        }
        throw new Error(`Unexpected: ${cmd.constructor.name}`);
      }),
    );

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 502, 'Unknown AWS errors must be reported as 502');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Access rules
// ─────────────────────────────────────────────────────────────────────────────

describe('Access rules', () => {
  before(() => {
    // Install a benign mock so the endpoint would succeed if auth passes
    ccMod.setCodeCommitClientFactory((_region: string, _creds: any) =>
      makeCcClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'ListRepositoriesCommand') return { repositories: [], nextToken: undefined };
        throw new Error(`Unexpected: ${cmd.constructor.name}`);
      }),
    );
  });

  test('unauthenticated request → 401 or 404 (not 200)', async () => {
    const anon = new Client(srv.base);
    // No login — anon has no session cookie
    const r = await anon.req('GET', URL_BASE());
    assert.ok(
      r.status === 401 || r.status === 404,
      `Unauthenticated must be 401 or 404, got ${r.status}`,
    );
  });

  test('GET endpoint does not require CSRF header (only state-changing methods do)', async () => {
    // The server's CSRF guard is: method !== GET && method !== HEAD &&
    // x-requested-with !== 'agent-portal'. GET is deliberately exempt.
    // An anon request without the CSRF header still gets 401 (no session),
    // not 403 — confirming GET is not gated by the CSRF check.
    const r = await noCsrf(srv.base, 'GET', URL_BASE());
    // 401 = auth check fires first (no session) — CSRF was not the blocker
    assert.equal(r.status, 401, 'Unauthenticated GET without CSRF header must be 401, not 403 (GET is CSRF-exempt)');
  });

  test('project non-member (logged in, not in project) → 404', async () => {
    const r = await stranger.req('GET', URL_BASE());
    assert.equal(r.status, 404, 'Non-member must not see the project (404, not 403)');
  });

  test('project viewer can call the endpoint (viewer is allowed to list)', async () => {
    const r = await viewer.req('GET', URL_BASE());
    assert.equal(r.status, 200, `Project viewer must be able to list CodeCommit repos, got ${r.status}`);
  });

  test('project editor can call the endpoint', async () => {
    const r = await editor.req('GET', URL_BASE());
    assert.equal(r.status, 200, `Project editor must be able to list CodeCommit repos, got ${r.status}`);
  });

  test('project admin can call the endpoint', async () => {
    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 200, `Admin must be able to list CodeCommit repos, got ${r.status}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Works with auth=sso (uses ssoCredentials)
// ─────────────────────────────────────────────────────────────────────────────

describe('auth=sso uses ssoCredentials', () => {
  let dbMod: typeof import('../server/db.ts');
  let secretsMod: typeof import('../server/secrets.ts');

  before(async () => {
    dbMod = await import('../server/db.ts');
    secretsMod = await import('../server/secrets.ts');

    await admin.put('/api/settings', {
      provider: { mode: 'bedrock' },
      aws: {
        region: 'ap-southeast-1',
        auth: 'sso',
        ssoRegion: 'us-east-1',
        ssoAccountId: '123456789012',
        ssoRoleName: 'ReadOnlyAccess',
      },
    });
  });

  after(async () => {
    // Clear sso tokens and restore keys auth
    dbMod.run("DELETE FROM settings WHERE key = 'sso_tokens'");
    ssoMod.resetSsoState();
    await admin.put('/api/settings', {
      provider: { mode: 'bedrock' },
      aws: { region: 'ap-southeast-1', auth: 'keys' },
    });
  });

  test('auth=sso fetches role credentials and passes them to the CodeCommit client', async () => {
    // Store a valid (non-expired) SSO access token in the DB
    dbMod.run(
      "INSERT INTO settings (key, value) VALUES ('sso_tokens', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      secretsMod.encrypt(JSON.stringify({
        accessToken: 'sso-access-token-for-cc-test',
        refreshToken: null,
        expiresAt: Date.now() + 3600_000,
      })),
    );
    ssoMod.resetSsoState();

    // Mock the SSO SDK to return known role credentials
    ssoMod.setSsoClientFactory((_region: string) => ({
      send: async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'GetRoleCredentialsCommand') {
          return {
            roleCredentials: {
              accessKeyId: 'SSO_AKID_FOR_CC',
              secretAccessKey: 'SSO_SECRET_FOR_CC',
              sessionToken: 'SSO_SESSION_FOR_CC',
              expiration: Date.now() + 3600_000,
            },
          };
        }
        throw new Error(`Unexpected SSO command: ${cmd.constructor.name}`);
      },
    }) as any);

    // The CC client factory captures the credentials it receives
    let receivedCreds: any = null;
    ccMod.setCodeCommitClientFactory((region: string, creds: any) => {
      receivedCreds = { region, creds };
      return makeCcClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'ListRepositoriesCommand') {
          return { repositories: [{ repositoryName: 'sso-repo' }], nextToken: undefined };
        }
        if (cmd.constructor.name === 'BatchGetRepositoriesCommand') {
          return buildBatchResponse(['sso-repo']);
        }
        throw new Error(`Unexpected: ${cmd.constructor.name}`);
      });
    });

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
    assert.ok(receivedCreds, 'CodeCommit client factory must have been called');
    assert.equal(
      receivedCreds.creds.accessKeyId, 'SSO_AKID_FOR_CC',
      'SSO access key ID must be forwarded to the CC client',
    );
    assert.equal(
      receivedCreds.creds.secretAccessKey, 'SSO_SECRET_FOR_CC',
      'SSO secret key must be forwarded to the CC client',
    );
    assert.equal(
      receivedCreds.creds.sessionToken, 'SSO_SESSION_FOR_CC',
      'SSO session token must be forwarded to the CC client',
    );
    assert.equal(r.data.repos.length, 1);
    assert.equal(r.data.repos[0].name, 'sso-repo');

    // Verify credentials never leak to the client
    const body = JSON.stringify(r.data);
    assert.ok(!body.includes('SSO_AKID_FOR_CC'), 'SSO access key must not appear in response');
    assert.ok(!body.includes('SSO_SECRET_FOR_CC'), 'SSO secret must not appear in response');
    assert.ok(!body.includes('SSO_SESSION_FOR_CC'), 'SSO session token must not appear in response');
  });

  test('auth=sso with expired tokens → 400 with sign-in message', async () => {
    // Store near-expired token with no refresh token so ssoCredentials throws
    dbMod.run(
      "INSERT INTO settings (key, value) VALUES ('sso_tokens', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      secretsMod.encrypt(JSON.stringify({
        accessToken: 'expired-sso-token',
        refreshToken: null,
        expiresAt: Date.now() + 200_000, // within 5-min buffer → triggers re-fetch
      })),
    );
    ssoMod.resetSsoState();

    // OIDC factory: no refresh token path should be called, but if it is, fail loudly
    ssoMod.setOidcClientFactory((_region: string) => ({
      send: async (_cmd: AnyCmd) => {
        throw new Error('Should not call OIDC when refreshToken is null');
      },
    }) as any);

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 400, 'Expired SSO session must return 400');
    assert.ok(
      r.data.error?.toLowerCase().includes('expired') ||
        r.data.error?.toLowerCase().includes('sign in'),
      `Expected expired-session error, got: "${r.data.error}"`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Works with auth=keys
// ─────────────────────────────────────────────────────────────────────────────

describe('auth=keys passes stored access keys to CodeCommit client', () => {
  before(async () => {
    await admin.put('/api/settings', {
      provider: { mode: 'bedrock' },
      aws: { region: 'ap-southeast-1', auth: 'keys' },
    });
    // Keys are already stored from the before() at the top level
  });

  test('CC client factory receives the stored access key ID and secret', async () => {
    let receivedCreds: any = null;
    ccMod.setCodeCommitClientFactory((region: string, creds: any) => {
      receivedCreds = { region, creds };
      return makeCcClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'ListRepositoriesCommand') {
          return { repositories: [{ repositoryName: 'keys-repo' }], nextToken: undefined };
        }
        if (cmd.constructor.name === 'BatchGetRepositoriesCommand') {
          return buildBatchResponse(['keys-repo']);
        }
        throw new Error(`Unexpected: ${cmd.constructor.name}`);
      });
    });

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
    assert.ok(receivedCreds, 'Client factory must be called');
    assert.equal(receivedCreds.creds.accessKeyId, 'AKIAIOSFODNN7EXAMPLE', 'Must use stored access key ID');
    assert.equal(receivedCreds.creds.secretAccessKey, 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'Must use stored secret key');
  });

  test('keys auth with missing credentials → 400 (not 500)', async () => {
    // Remove the stored keys temporarily
    const { deleteSecret } = await import('../server/secrets.ts');
    deleteSecret('aws.access_key_id');
    deleteSecret('aws.secret_access_key');

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 400, 'Missing keys must return 400, not 500');
    assert.ok(
      r.data.error?.toLowerCase().includes('key') ||
        r.data.error?.toLowerCase().includes('setting'),
      `Error must mention missing keys, got: "${r.data.error}"`,
    );

    // Restore keys for subsequent tests
    await admin.post('/api/settings/secrets/aws.access_key_id', { value: 'AKIAIOSFODNN7EXAMPLE' });
    await admin.post('/api/settings/secrets/aws.secret_access_key', { value: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Empty repository list
// ─────────────────────────────────────────────────────────────────────────────

describe('Empty repository list', () => {
  test('returns { repos: [], region } when no repositories exist', async () => {
    ccMod.setCodeCommitClientFactory((_region: string, _creds: any) =>
      makeCcClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'ListRepositoriesCommand') return { repositories: [], nextToken: undefined };
        // BatchGetRepositories should NOT be called for an empty list
        throw new Error(`BatchGetRepositories called unexpectedly for empty list: ${cmd.constructor.name}`);
      }),
    );

    const r = await admin.req('GET', `${URL_BASE()}?region=eu-west-1`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.repos, [], 'repos must be an empty array');
    assert.equal(r.data.region, 'eu-west-1', 'region must be echoed back');
  });

  test('returns { repos: [], region } when ListRepositories returns undefined/null repos', async () => {
    ccMod.setCodeCommitClientFactory((_region: string, _creds: any) =>
      makeCcClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'ListRepositoriesCommand') {
          return { repositories: undefined, nextToken: undefined };
        }
        throw new Error(`BatchGetRepositories called unexpectedly: ${cmd.constructor.name}`);
      }),
    );

    const r = await admin.req('GET', URL_BASE());
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.repos, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13–15. UI source checks (structural, no DOM rendering needed)
// ─────────────────────────────────────────────────────────────────────────────

describe('UI source: Repos.jsx CodeCommit feature', () => {
  let src: string;

  before(() => {
    const url = new URL('../web/src/pages/Repos.jsx', import.meta.url);
    const filePath = fileURLToPath(url);
    src = fs.readFileSync(filePath, 'utf8');
  });

  test('CodeCommitPicker component exists', () => {
    assert.ok(
      src.includes('function CodeCommitPicker('),
      'Repos.jsx must export a CodeCommitPicker component',
    );
  });

  test('CodeCommitPicker uses role="listbox" for the repository list', () => {
    const startIdx = src.indexOf('function CodeCommitPicker(');
    const endIdx = src.indexOf('\nfunction ', startIdx + 1);
    const fn = src.slice(startIdx, endIdx > startIdx ? endIdx : undefined);
    assert.ok(
      fn.includes('role="listbox"'),
      'CodeCommitPicker must use role="listbox" for accessibility',
    );
  });

  test('CodeCommitPicker uses role="option" for individual repository items', () => {
    const startIdx = src.indexOf('function CodeCommitPicker(');
    const endIdx = src.indexOf('\nfunction ', startIdx + 1);
    const fn = src.slice(startIdx, endIdx > startIdx ? endIdx : undefined);
    assert.ok(
      fn.includes('role="option"'),
      'CodeCommitPicker must use role="option" for each repo item',
    );
  });

  test('CodeCommitPicker uses RegionSelect for the region dropdown', () => {
    const startIdx = src.indexOf('function CodeCommitPicker(');
    const endIdx = src.indexOf('\nfunction ', startIdx + 1);
    const fn = src.slice(startIdx, endIdx > startIdx ? endIdx : undefined);
    assert.ok(
      fn.includes('RegionSelect'),
      'CodeCommitPicker must use RegionSelect for the region dropdown',
    );
  });

  test('RegionSelect is imported from Settings.jsx', () => {
    assert.ok(
      src.includes("from './Settings.jsx'") && src.includes('RegionSelect'),
      'Repos.jsx must import RegionSelect from ./Settings.jsx',
    );
  });

  test('manual address fallback toggle exists ("Enter address manually")', () => {
    assert.ok(
      src.includes('Enter address manually'),
      'Repos.jsx must have a manual address fallback toggle',
    );
  });

  test('manual fallback shows the standard URL input field (ccManualMode)', () => {
    // When ccManualMode = true, AddRepo falls back to a plain URL <input>
    const addRepoStart = src.indexOf('function AddRepo(');
    const addRepoEnd = src.indexOf('\nfunction ', addRepoStart + 1);
    const fn = src.slice(addRepoStart, addRepoEnd > addRepoStart ? addRepoEnd : undefined);
    assert.ok(
      fn.includes('ccManualMode'),
      'AddRepo must track ccManualMode state for the manual URL fallback',
    );
    // The URL input must be shown when ccManualMode is true
    assert.ok(
      fn.includes('ccManualMode') && fn.includes('form.url'),
      'AddRepo must show the URL input when ccManualMode is active',
    );
  });

  test('AddRepo uses CodeCommitPicker when provider is codecommit', () => {
    const addRepoStart = src.indexOf('function AddRepo(');
    const addRepoEnd = src.indexOf('\nfunction ', addRepoStart + 1);
    const fn = src.slice(addRepoStart, addRepoEnd > addRepoStart ? addRepoEnd : undefined);
    assert.ok(
      fn.includes('CodeCommitPicker'),
      'AddRepo must render CodeCommitPicker when provider is codecommit',
    );
    assert.ok(
      fn.includes("form.provider === 'codecommit'"),
      'AddRepo must conditionally show CodeCommitPicker when provider is codecommit',
    );
  });

  test('AWS_REGIONS is imported from Settings.jsx', () => {
    assert.ok(
      src.includes('AWS_REGIONS'),
      'Repos.jsx must import AWS_REGIONS from Settings.jsx',
    );
  });

  test('isAwsNotConfigured helper handles bedrock-key error messages', () => {
    const startIdx = src.indexOf('function isAwsNotConfigured(');
    const endIdx = src.indexOf('\nfunction ', startIdx + 1);
    const fn = src.slice(startIdx, endIdx > startIdx ? endIdx : undefined);
    assert.ok(fn.includes('bedrock-key') || fn.includes('Bedrock API key'), 'isAwsNotConfigured must handle bedrock-key error');
    assert.ok(fn.includes('not configured') || fn.includes('Set an AWS') || fn.includes('Add an AWS'), 'isAwsNotConfigured must handle not-configured error');
  });

  test('CodeCommitPicker shows loading state (Spinner)', () => {
    const startIdx = src.indexOf('function CodeCommitPicker(');
    const endIdx = src.indexOf('\nfunction ', startIdx + 1);
    const fn = src.slice(startIdx, endIdx > startIdx ? endIdx : undefined);
    assert.ok(fn.includes('Spinner'), 'CodeCommitPicker must show a loading spinner');
  });

  test('CodeCommitPicker shows error state (ErrorNote or note-info)', () => {
    const startIdx = src.indexOf('function CodeCommitPicker(');
    const endIdx = src.indexOf('\nfunction ', startIdx + 1);
    const fn = src.slice(startIdx, endIdx > startIdx ? endIdx : undefined);
    assert.ok(
      fn.includes('ErrorNote') || fn.includes('note-info'),
      'CodeCommitPicker must handle the error state',
    );
  });

  test('CodeCommitPicker shows empty state when no repos found', () => {
    const startIdx = src.indexOf('function CodeCommitPicker(');
    const endIdx = src.indexOf('\nfunction ', startIdx + 1);
    const fn = src.slice(startIdx, endIdx > startIdx ? endIdx : undefined);
    assert.ok(
      fn.includes('No CodeCommit repositories') || fn.includes('length === 0'),
      'CodeCommitPicker must handle the empty state',
    );
  });

  test('selected repo fills the form URL (onSelect callback)', () => {
    const addRepoStart = src.indexOf('function AddRepo(');
    const addRepoEnd = src.indexOf('\nfunction ', addRepoStart + 1);
    const fn = src.slice(addRepoStart, addRepoEnd > addRepoStart ? addRepoEnd : undefined);
    assert.ok(
      fn.includes('onSelect') && fn.includes('url'),
      'AddRepo must pass an onSelect handler that updates form.url',
    );
  });
});
