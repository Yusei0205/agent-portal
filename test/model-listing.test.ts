/**
 * Tests for GET /api/settings/models and listModelsForProvider.
 *
 * Coverage:
 *   - Admin-only guard (401 unauthenticated, 403 non-admin)
 *   - demo provider returns source:"fallback", empty groups
 *   - kiro provider returns source:"fallback" with single fallback entry
 *   - Anthropic live listing, mocked fetch, grouped under "Anthropic"
 *   - Anthropic failure → fallback groups + error message
 *   - Bedrock foundation model grouping (non-text filtered out)
 *   - Bedrock inference profiles (SYSTEM_DEFINED only, labeled with region)
 *   - Bedrock failure → fallback groups + error message
 *   - LiteLLM live listing, grouped by prefix
 *   - Cache: second call returns cached result without re-fetching
 *   - ?refresh=1 bypasses cache
 *   - defaultModel round-trip via PUT /api/settings + GET /api/settings
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import {
  setSetting,
  setBedrockListingMock,
  _clearModelListCache,
  listModelsForProvider,
  regionToGeoPrefix,
  bedrockFallbackForRegion,
  type ModelListResponse,
  type ModelGroup,
} from '../server/settings.ts';
import { getDb } from '../server/db.ts';
import { encrypt } from '../server/secrets.ts';
import { config } from '../server/config.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loginAdmin(baseUrl: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: 'admin@ml.com', name: 'Admin', password: 'password1234' },
  });
  assert.equal(r.status, 200, `Setup failed: ${JSON.stringify(r.body)}`);
  return r.cookie ?? '';
}

async function loginNonAdmin(baseUrl: string, adminCookie: string): Promise<string> {
  const createR = await fetchJson(baseUrl, '/api/users', {
    method: 'POST',
    body: { email: 'user@ml.com', name: 'User', password: 'password1234', isAdmin: false },
    cookie: adminCookie,
  });
  assert.equal(createR.status, 201, `Create user failed: ${JSON.stringify(createR.body)}`);
  const loginR = await fetchJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'user@ml.com', password: 'password1234' },
  });
  return loginR.cookie ?? '';
}

// ── GET /api/settings/models — auth guard ─────────────────────────────────────

describe('GET /api/settings/models — auth guards', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
  });

  after(async () => {
    await cleanup();
    _clearModelListCache();
  });

  it('returns 401 when not authenticated', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/models?provider=demo');
    assert.equal(r.status, 401);
  });

  it('returns 403 for non-admin user', async () => {
    const userCookie = await loginNonAdmin(baseUrl, adminCookie);
    const r = await fetchJson(baseUrl, '/api/settings/models?provider=demo', { cookie: userCookie });
    assert.equal(r.status, 403);
  });

  it('returns 400 when provider param is missing', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/models', { cookie: adminCookie });
    assert.equal(r.status, 400);
  });

  it('returns 400 when provider param is unknown', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/models?provider=openai', { cookie: adminCookie });
    assert.equal(r.status, 400);
  });
});

// ── Provider: demo ────────────────────────────────────────────────────────────

describe('GET /api/settings/models — demo provider', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
  });

  after(async () => {
    await cleanup();
    _clearModelListCache();
  });

  it('returns fallback with empty groups for demo', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/models?provider=demo', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as ModelListResponse;
    assert.equal(body.provider, 'demo');
    assert.equal(body.source, 'fallback');
    assert.equal(body.error, null);
    assert.ok(Array.isArray(body.groups));
    assert.equal(body.groups.length, 0);
  });
});

// ── Provider: kiro ────────────────────────────────────────────────────────────

const FAKE_KIRO_PATH = path.resolve('test/fake-kiro.mjs');

describe('GET /api/settings/models — kiro provider', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
    _clearModelListCache();
  });

  afterEach(() => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    _clearModelListCache();
  });

  it('not-installed → fallback, error explains CLI must be installed', async () => {
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO_PATH;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'not-installed';
    const r = await fetchJson(baseUrl, '/api/settings/models?provider=kiro&refresh=1', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as ModelListResponse;
    assert.equal(body.provider, 'kiro');
    assert.equal(body.source, 'fallback');
    assert.ok(typeof body.error === 'string' && body.error.length > 0, 'must have error');
    assert.ok(
      body.error!.toLowerCase().includes('install') || body.error!.toLowerCase().includes('not installed'),
      `error must mention installation: "${body.error}"`,
    );
    assert.deepEqual(body.groups, [], 'groups must be empty');
  });

  it('signed-out → fallback, error explains CLI must be signed in', async () => {
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO_PATH;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'signed-out';
    const r = await fetchJson(baseUrl, '/api/settings/models?provider=kiro&refresh=1', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as ModelListResponse;
    assert.equal(body.provider, 'kiro');
    assert.equal(body.source, 'fallback');
    assert.ok(typeof body.error === 'string' && body.error.length > 0, 'must have error');
    assert.ok(
      body.error!.toLowerCase().includes('sign') || body.error!.toLowerCase().includes('signed'),
      `error must mention sign-in: "${body.error}"`,
    );
    assert.deepEqual(body.groups, [], 'groups must be empty');
  });

  it('signed-in → live source with auto first then vendor groups', async () => {
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO_PATH;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'builder-id';
    const r = await fetchJson(baseUrl, '/api/settings/models?provider=kiro&refresh=1', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as ModelListResponse;
    assert.equal(body.provider, 'kiro');
    assert.equal(body.source, 'live', `expected source:live, got ${body.source}`);
    assert.equal(body.error, null, `expected no error, got: ${body.error}`);
    assert.ok(body.groups.length >= 2, `expected ≥2 groups, got ${body.groups.length}`);

    // Auto must be first group with exactly one entry
    const firstGroup = body.groups[0];
    assert.equal(firstGroup.label, 'Auto', `first group must be Auto, got: ${firstGroup.label}`);
    assert.equal(firstGroup.models.length, 1, 'Auto group must have exactly one model');
    assert.equal(firstGroup.models[0].id, 'auto');
    assert.equal(firstGroup.models[0].label, 'Auto (Kiro picks per task)', `auto label: ${firstGroup.models[0].label}`);

    // Vendor groups: Anthropic with claude models
    const anthropicGroup = body.groups.find((g: ModelGroup) => g.label === 'Anthropic');
    assert.ok(anthropicGroup, 'should have Anthropic group');
    assert.ok(anthropicGroup!.models.some((m) => m.id === 'claude-sonnet-5.5'), 'Anthropic group must include claude-sonnet-5.5');
    const sonnetModel = anthropicGroup!.models.find((m) => m.id === 'claude-sonnet-5.5');
    assert.ok(sonnetModel!.label.includes('Claude Sonnet 5.5'), `human-readable name expected, got: ${sonnetModel!.label}`);
    assert.ok(sonnetModel!.label.includes('ctx'), `context window expected in label, got: ${sonnetModel!.label}`);
    assert.ok(sonnetModel!.label.includes('credits'), `credits expected in label, got: ${sonnetModel!.label}`);

    // OpenAI group with gpt models
    const openaiGroup = body.groups.find((g: ModelGroup) => g.label === 'OpenAI');
    assert.ok(openaiGroup, 'should have OpenAI group');
    assert.ok(openaiGroup!.models.some((m) => m.id === 'gpt-5.6-luna'), 'OpenAI group must include gpt-5.6-luna');

    // DeepSeek group
    const deepseekGroup = body.groups.find((g: ModelGroup) => g.label === 'DeepSeek');
    assert.ok(deepseekGroup, 'should have DeepSeek group');
    assert.ok(deepseekGroup!.models.some((m) => m.id === 'deepseek-3.2'), 'DeepSeek group must include deepseek-3.2');

    // Auto group must come before Anthropic in the groups array
    const autoIdx = body.groups.findIndex((g: ModelGroup) => g.label === 'Auto');
    const anthropicIdx = body.groups.findIndex((g: ModelGroup) => g.label === 'Anthropic');
    assert.ok(autoIdx < anthropicIdx, 'Auto group must come before Anthropic group');
  });

  it('list-models-json-fallback scenario → live source from plain-text fallback parser', async () => {
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO_PATH;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'list-models-json-fallback';
    const r = await fetchJson(baseUrl, '/api/settings/models?provider=kiro&refresh=1', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as ModelListResponse;
    assert.equal(body.provider, 'kiro');
    assert.equal(body.source, 'live', `expected source:live (from plain-text fallback), got ${body.source}`);
    assert.equal(body.error, null);
    assert.ok(body.groups.length > 0, 'should have at least one group from plain-text parse');
    const allIds = body.groups.flatMap((g: ModelGroup) => g.models.map((m) => m.id));
    assert.ok(allIds.includes('auto'), 'auto model must be present from plain-text fallback');
  });
});

// ── Provider: anthropic ───────────────────────────────────────────────────────

describe('GET /api/settings/models — anthropic provider', () => {
  let baseUrl: string;
  let adminCookie: string;
  let origFetch: typeof globalThis.fetch;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    origFetch = globalThis.fetch;
    // Store the Anthropic API key in settings
    const db = getDb();
    const enc = encrypt('sk-ant-fake', config.secretKey);
    setSetting(db, 'anthropic.key.enc', enc);
  });

  after(async () => {
    globalThis.fetch = origFetch;
    await cleanup();
    _clearModelListCache();
    setBedrockListingMock(null);
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    _clearModelListCache();
  });

  it('live Anthropic call returns models grouped under "Anthropic"', async () => {
    globalThis.fetch = async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).includes('anthropic.com/v1/models')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5', type: 'model' },
              { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', type: 'model' },
              { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', type: 'model' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return origFetch(url, _init);
    };

    const r = await fetchJson(baseUrl, '/api/settings/models?provider=anthropic', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as ModelListResponse;
    assert.equal(body.provider, 'anthropic');
    assert.equal(body.source, 'live');
    assert.equal(body.error, null);
    assert.ok(body.groups.length >= 1);
    const anthropicGroup = body.groups.find((g: ModelGroup) => g.label === 'Anthropic');
    assert.ok(anthropicGroup, 'should have an Anthropic group');
    const ids = anthropicGroup!.models.map((m) => m.id);
    assert.ok(ids.includes('claude-opus-4-5'));
    assert.ok(ids.includes('claude-sonnet-4-5'));
    assert.ok(ids.includes('claude-haiku-4-5'));
  });

  it('Anthropic API error → fallback groups with error field', async () => {
    globalThis.fetch = async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).includes('anthropic.com/v1/models')) {
        return new Response(
          JSON.stringify({ error: { message: 'invalid_api_key' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      return origFetch(url, _init);
    };

    const r = await fetchJson(baseUrl, '/api/settings/models?provider=anthropic', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as ModelListResponse;
    assert.equal(body.source, 'fallback');
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
    // Must still return fallback model list
    assert.ok(body.groups.length >= 1);
    const allIds = body.groups.flatMap((g: ModelGroup) => g.models.map((m) => m.id));
    assert.ok(allIds.some((id: string) => id.includes('claude')));
  });

  it('Network error → fallback groups with error field', async () => {
    globalThis.fetch = async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).includes('anthropic.com')) {
        throw new Error('ECONNREFUSED');
      }
      return origFetch(url, _init);
    };

    const r = await fetchJson(baseUrl, '/api/settings/models?provider=anthropic', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as ModelListResponse;
    assert.equal(body.source, 'fallback');
    assert.ok(typeof body.error === 'string' && body.error.includes('ECONNREFUSED'));
  });
});

// ── Provider: bedrock ─────────────────────────────────────────────────────────

describe('GET /api/settings/models — bedrock provider', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    setSetting(getDb(), 'provider.mode', 'bedrock');
    setSetting(getDb(), 'bedrock.region', 'us-east-1');
    setSetting(getDb(), 'bedrock.auth', 'ambient');
  });

  after(async () => {
    setBedrockListingMock(null);
    await cleanup();
    _clearModelListCache();
  });

  afterEach(() => {
    setBedrockListingMock(null);
    _clearModelListCache();
  });

  it('groups foundation models by providerName', async () => {
    setBedrockListingMock({
      foundationModels: [
        { modelId: 'anthropic.claude-3-5-sonnet-20241022-v1:0', modelName: 'Claude 3.5 Sonnet', providerName: 'Anthropic', outputModalities: ['TEXT'] },
        { modelId: 'anthropic.claude-3-haiku-20240307-v1:0', modelName: 'Claude 3 Haiku', providerName: 'Anthropic', outputModalities: ['TEXT'] },
        { modelId: 'amazon.nova-pro-v1:0', modelName: 'Nova Pro', providerName: 'Amazon', outputModalities: ['TEXT'] },
        { modelId: 'meta.llama3-70b-instruct-v1:0', modelName: 'Llama 3 70B', providerName: 'Meta', outputModalities: ['TEXT'] },
      ],
      inferenceProfiles: [],
    });

    const r = await fetchJson(baseUrl, '/api/settings/models?provider=bedrock&refresh=1', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as ModelListResponse;
    assert.equal(body.source, 'live');
    assert.equal(body.error, null);

    const groupLabels = body.groups.map((g: ModelGroup) => g.label);
    assert.ok(groupLabels.includes('Anthropic'), 'must have Anthropic group');
    assert.ok(groupLabels.includes('Amazon'), 'must have Amazon group');
    assert.ok(groupLabels.includes('Meta'), 'must have Meta group');

    // Anthropic group must come first
    assert.equal(body.groups[0].label, 'Anthropic');
  });

  it('filters out non-TEXT models (IMAGE, EMBEDDING)', async () => {
    setBedrockListingMock({
      foundationModels: [
        { modelId: 'anthropic.claude-3-5-sonnet-20241022-v1:0', modelName: 'Claude 3.5 Sonnet', providerName: 'Anthropic', outputModalities: ['TEXT'] },
        { modelId: 'amazon.titan-image-generator-v2:0', modelName: 'Titan Image Gen', providerName: 'Amazon', outputModalities: ['IMAGE'] },
        { modelId: 'amazon.titan-embed-text-v2:0', modelName: 'Titan Embed', providerName: 'Amazon', outputModalities: ['EMBEDDING'] },
        { modelId: 'amazon.nova-pro-v1:0', modelName: 'Nova Pro', providerName: 'Amazon', outputModalities: ['TEXT', 'IMAGE'] },
      ],
      inferenceProfiles: [],
    });

    const r = await fetchJson(baseUrl, '/api/settings/models?provider=bedrock&refresh=1', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as ModelListResponse;
    const allIds = body.groups.flatMap((g: ModelGroup) => g.models.map((m) => m.id));

    assert.ok(allIds.includes('anthropic.claude-3-5-sonnet-20241022-v1:0'), 'TEXT model must be included');
    assert.ok(allIds.includes('amazon.nova-pro-v1:0'), 'TEXT+IMAGE model must be included (has TEXT)');
    assert.ok(!allIds.includes('amazon.titan-image-generator-v2:0'), 'IMAGE-only model must be excluded');
    assert.ok(!allIds.includes('amazon.titan-embed-text-v2:0'), 'EMBEDDING-only model must be excluded');
  });

  it('includes SYSTEM_DEFINED inference profiles with cross-region labels', async () => {
    setBedrockListingMock({
      foundationModels: [
        { modelId: 'anthropic.claude-3-5-sonnet-20241022-v1:0', modelName: 'Claude 3.5 Sonnet', providerName: 'Anthropic', outputModalities: ['TEXT'] },
      ],
      inferenceProfiles: [
        {
          inferenceProfileId: 'us.anthropic.claude-3-5-sonnet-20241022-v1:0',
          inferenceProfileName: 'Claude 3.5 Sonnet Cross-Region',
          type: 'SYSTEM_DEFINED',
          status: 'ACTIVE',
        },
        {
          inferenceProfileId: 'global.anthropic.claude-3-5-sonnet-20241022-v1:0',
          inferenceProfileName: 'Claude 3.5 Sonnet Global',
          type: 'SYSTEM_DEFINED',
          status: 'ACTIVE',
        },
      ],
    });

    const r = await fetchJson(baseUrl, '/api/settings/models?provider=bedrock&refresh=1', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as ModelListResponse;
    const allIds = body.groups.flatMap((g: ModelGroup) => g.models.map((m) => m.id));

    assert.ok(allIds.includes('us.anthropic.claude-3-5-sonnet-20241022-v1:0'), 'US inference profile must be included');
    assert.ok(allIds.includes('global.anthropic.claude-3-5-sonnet-20241022-v1:0'), 'Global inference profile must be included');

    // Check label contains cross-region indicator
    const allModels = body.groups.flatMap((g: ModelGroup) => g.models);
    const usProfile = allModels.find((m) => m.id === 'us.anthropic.claude-3-5-sonnet-20241022-v1:0');
    assert.ok(usProfile, 'must find US profile model');
    assert.equal(usProfile!.label, 'Claude 3.5 Sonnet Cross-Region', 'must use inferenceProfileName when provided');
  });

  it('excludes non-SYSTEM_DEFINED and non-ACTIVE inference profiles', async () => {
    setBedrockListingMock({
      foundationModels: [],
      inferenceProfiles: [
        { inferenceProfileId: 'us.anthropic.claude-3-5-sonnet-20241022-v1:0', type: 'SYSTEM_DEFINED', status: 'ACTIVE' },
        { inferenceProfileId: 'custom.profile', type: 'APPLICATION', status: 'ACTIVE' },
        { inferenceProfileId: 'us.anthropic.claude-inactive', type: 'SYSTEM_DEFINED', status: 'INACTIVE' },
      ],
    });

    const r = await fetchJson(baseUrl, '/api/settings/models?provider=bedrock&refresh=1', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as ModelListResponse;
    const allIds = body.groups.flatMap((g: ModelGroup) => g.models.map((m) => m.id));

    assert.ok(allIds.includes('us.anthropic.claude-3-5-sonnet-20241022-v1:0'), 'active SYSTEM_DEFINED must be included');
    assert.ok(!allIds.includes('custom.profile'), 'APPLICATION type must be excluded');
    assert.ok(!allIds.includes('us.anthropic.claude-inactive'), 'INACTIVE profile must be excluded');
  });

  it('Bedrock connection error → fallback groups with error message', async () => {
    setBedrockListingMock({ throwError: 'UnauthorizedException' });

    const r = await fetchJson(baseUrl, '/api/settings/models?provider=bedrock&refresh=1', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as ModelListResponse;
    assert.equal(body.source, 'fallback');
    assert.ok(typeof body.error === 'string' && body.error.includes('UnauthorizedException'));
    assert.ok(body.groups.length >= 1, 'must return fallback model list');
    const allIds = body.groups.flatMap((g: ModelGroup) => g.models.map((m) => m.id));
    assert.ok(allIds.some((id: string) => id.includes('claude')));
  });
});

// ── Cache behaviour ───────────────────────────────────────────────────────────

describe('GET /api/settings/models — caching', () => {
  let baseUrl: string;
  let adminCookie: string;
  let fetchCallCount = 0;
  let origFetch: typeof globalThis.fetch;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    origFetch = globalThis.fetch;

    // Store an Anthropic key
    const enc = encrypt('sk-ant-fake2', config.secretKey);
    setSetting(getDb(), 'anthropic.key.enc', enc);

    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('anthropic.com/v1/models')) {
        fetchCallCount++;
        return new Response(
          JSON.stringify({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', type: 'model' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return origFetch(url, init);
    };
  });

  after(async () => {
    globalThis.fetch = origFetch;
    await cleanup();
    _clearModelListCache();
  });

  it('caches result so second call does not re-fetch', async () => {
    _clearModelListCache();
    fetchCallCount = 0;

    const r1 = await fetchJson(baseUrl, '/api/settings/models?provider=anthropic', { cookie: adminCookie });
    assert.equal(r1.status, 200);
    assert.equal(fetchCallCount, 1, 'first call must hit the API');

    const r2 = await fetchJson(baseUrl, '/api/settings/models?provider=anthropic', { cookie: adminCookie });
    assert.equal(r2.status, 200);
    assert.equal(fetchCallCount, 1, 'second call must use cache, not re-fetch');
  });

  it('?refresh=1 bypasses cache and re-fetches', async () => {
    fetchCallCount = 0;

    const r1 = await fetchJson(baseUrl, '/api/settings/models?provider=anthropic', { cookie: adminCookie });
    assert.equal(r1.status, 200);
    const countAfterFirst = fetchCallCount;

    const r2 = await fetchJson(baseUrl, '/api/settings/models?provider=anthropic&refresh=1', { cookie: adminCookie });
    assert.equal(r2.status, 200);
    assert.ok(fetchCallCount > countAfterFirst, '?refresh=1 must bypass cache and re-fetch');
  });
});

// ── listModelsForProvider direct unit tests ───────────────────────────────────

describe('listModelsForProvider — unit tests (no HTTP)', () => {
  let origFetch: typeof globalThis.fetch;

  before(async () => {
    await createTestServer(); // opens in-memory DB
    origFetch = globalThis.fetch;
  });

  after(async () => {
    globalThis.fetch = origFetch;
    setBedrockListingMock(null);
    _clearModelListCache();
    await cleanup();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    setBedrockListingMock(null);
    _clearModelListCache();
  });

  it('demo returns source:"fallback", empty groups', async () => {
    const result = await listModelsForProvider('demo');
    assert.equal(result.source, 'fallback');
    assert.equal(result.error, null);
    assert.deepEqual(result.groups, []);
  });

  it('bedrock sorts models within group (descending by id)', async () => {
    setBedrockListingMock({
      foundationModels: [
        { modelId: 'anthropic.claude-v2', modelName: 'Claude v2', providerName: 'Anthropic', outputModalities: ['TEXT'] },
        { modelId: 'anthropic.claude-v3', modelName: 'Claude v3', providerName: 'Anthropic', outputModalities: ['TEXT'] },
      ],
      inferenceProfiles: [],
    });

    const result = await listModelsForProvider('bedrock', undefined, true);
    assert.equal(result.source, 'live');
    const anthGroup = result.groups.find((g) => g.label === 'Anthropic');
    assert.ok(anthGroup, 'must have Anthropic group');
    assert.equal(anthGroup!.models.length, 2);
    // Descending by ID: "claude-v3" > "claude-v2"
    assert.equal(anthGroup!.models[0].id, 'anthropic.claude-v3', 'higher-string-value id must sort first');
    assert.equal(anthGroup!.models[1].id, 'anthropic.claude-v2');
  });

  it('bedrock inference profile label is generated from ID when no profileName given', async () => {
    setBedrockListingMock({
      foundationModels: [],
      inferenceProfiles: [
        { inferenceProfileId: 'us.anthropic.claude-3-5-sonnet-20241022-v1:0', type: 'SYSTEM_DEFINED', status: 'ACTIVE' },
      ],
    });

    const result = await listModelsForProvider('bedrock', undefined, true);
    const allModels = result.groups.flatMap((g) => g.models);
    const profile = allModels.find((m) => m.id === 'us.anthropic.claude-3-5-sonnet-20241022-v1:0');
    assert.ok(profile, 'must include profile');
    assert.ok(
      profile!.label.includes('US') || profile!.label.toLowerCase().includes('cross-region'),
      `label "${profile!.label}" must indicate US cross-region`,
    );
  });
});

// ── Region-aware fallback ─────────────────────────────────────────────────────

describe('regionToGeoPrefix', () => {
  it('us-east-1 → us', () => assert.equal(regionToGeoPrefix('us-east-1'), 'us'));
  it('us-west-2 → us', () => assert.equal(regionToGeoPrefix('us-west-2'), 'us'));
  it('ca-central-1 → us', () => assert.equal(regionToGeoPrefix('ca-central-1'), 'us'));
  it('eu-west-1 → eu', () => assert.equal(regionToGeoPrefix('eu-west-1'), 'eu'));
  it('eu-central-1 → eu', () => assert.equal(regionToGeoPrefix('eu-central-1'), 'eu'));
  it('ap-southeast-2 → au', () => assert.equal(regionToGeoPrefix('ap-southeast-2'), 'au'));
  it('ap-southeast-4 → au', () => assert.equal(regionToGeoPrefix('ap-southeast-4'), 'au'));
  it('ap-northeast-1 → jp', () => assert.equal(regionToGeoPrefix('ap-northeast-1'), 'jp'));
  it('ap-northeast-3 → jp', () => assert.equal(regionToGeoPrefix('ap-northeast-3'), 'jp'));
  it('ap-south-1 → in', () => assert.equal(regionToGeoPrefix('ap-south-1'), 'in'));
  it('ap-south-2 → in', () => assert.equal(regionToGeoPrefix('ap-south-2'), 'in'));
  it('ap-southeast-1 → global (no APAC geo for Singapore)', () => assert.equal(regionToGeoPrefix('ap-southeast-1'), 'global'));
  it('ap-northeast-2 → global (Seoul has no dedicated geo)', () => assert.equal(regionToGeoPrefix('ap-northeast-2'), 'global'));
  it('me-south-1 → global', () => assert.equal(regionToGeoPrefix('me-south-1'), 'global'));
  it('af-south-1 → global', () => assert.equal(regionToGeoPrefix('af-south-1'), 'global'));
  it('sa-east-1 → global', () => assert.equal(regionToGeoPrefix('sa-east-1'), 'global'));
});

describe('bedrockFallbackForRegion', () => {
  it('ap-southeast-1 (Singapore) → all models use global prefix', () => {
    const groups = bedrockFallbackForRegion('ap-southeast-1');
    assert.equal(groups.length, 1);
    assert.equal(groups[0].label, 'Anthropic');
    const ids = groups[0].models.map((m) => m.id);
    assert.ok(ids.every((id) => id.startsWith('global.')), `Expected all global.* IDs, got: ${ids.join(', ')}`);
    assert.ok(ids.some((id) => id.includes('claude')));
    const labels = groups[0].models.map((m) => m.label);
    assert.ok(labels.every((l) => l.includes('global cross-region')), `Expected all "(global cross-region)" labels`);
  });

  it('eu-west-1 → all models use eu prefix', () => {
    const groups = bedrockFallbackForRegion('eu-west-1');
    assert.equal(groups.length, 1);
    const ids = groups[0].models.map((m) => m.id);
    assert.ok(ids.every((id) => id.startsWith('eu.')), `Expected all eu.* IDs, got: ${ids.join(', ')}`);
    const labels = groups[0].models.map((m) => m.label);
    assert.ok(labels.every((l) => l.includes('EU cross-region')));
  });

  it('us-east-1 → all models use us prefix', () => {
    const groups = bedrockFallbackForRegion('us-east-1');
    assert.equal(groups.length, 1);
    const ids = groups[0].models.map((m) => m.id);
    assert.ok(ids.every((id) => id.startsWith('us.')), `Expected all us.* IDs, got: ${ids.join(', ')}`);
  });

  it('ap-southeast-2 (Sydney) → Sonnet/Haiku use au prefix, Opus uses global (no AU geo)', () => {
    const groups = bedrockFallbackForRegion('ap-southeast-2');
    const ids = groups[0].models.map((m) => m.id);
    const sonnetId = ids.find((id) => id.includes('sonnet'));
    const haikuId = ids.find((id) => id.includes('haiku'));
    const opusId = ids.find((id) => id.includes('opus'));
    assert.ok(sonnetId?.startsWith('au.'), `Sonnet should use au. prefix, got: ${sonnetId}`);
    assert.ok(haikuId?.startsWith('au.'), `Haiku should use au. prefix, got: ${haikuId}`);
    // Claude Opus 4.5 only has us/eu geo profiles → falls back to global
    assert.ok(opusId?.startsWith('global.'), `Opus should use global. prefix (no AU geo), got: ${opusId}`);
  });

  it('ap-northeast-1 (Tokyo) → Sonnet/Haiku use jp prefix, Opus uses global', () => {
    const groups = bedrockFallbackForRegion('ap-northeast-1');
    const ids = groups[0].models.map((m) => m.id);
    const sonnetId = ids.find((id) => id.includes('sonnet'));
    const haikuId = ids.find((id) => id.includes('haiku'));
    const opusId = ids.find((id) => id.includes('opus'));
    assert.ok(sonnetId?.startsWith('jp.'), `Sonnet should use jp. prefix, got: ${sonnetId}`);
    assert.ok(haikuId?.startsWith('jp.'), `Haiku should use jp. prefix, got: ${haikuId}`);
    assert.ok(opusId?.startsWith('global.'), `Opus should use global. prefix (no JP geo), got: ${opusId}`);
  });

  it('ap-south-1 (Mumbai) → Haiku uses in prefix, Sonnet/Opus use global', () => {
    const groups = bedrockFallbackForRegion('ap-south-1');
    const ids = groups[0].models.map((m) => m.id);
    const haikuId = ids.find((id) => id.includes('haiku'));
    const sonnetId = ids.find((id) => id.includes('sonnet'));
    const opusId = ids.find((id) => id.includes('opus'));
    assert.ok(haikuId?.startsWith('in.'), `Haiku should use in. prefix, got: ${haikuId}`);
    assert.ok(sonnetId?.startsWith('global.'), `Sonnet should use global. (no IN geo), got: ${sonnetId}`);
    assert.ok(opusId?.startsWith('global.'), `Opus should use global. (no IN geo), got: ${opusId}`);
  });

  it('includes defaultModel with "(other region)" when it differs from regional prefix', () => {
    const usDefault = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    const groups = bedrockFallbackForRegion('ap-southeast-1', usDefault);
    const allIds = groups.flatMap((g) => g.models.map((m) => m.id));
    // ap-southeast-1 uses global.* for all models, so the us. default is "other region"
    assert.ok(allIds.includes(usDefault), 'defaultModel should be included in the list');
    const otherGroup = groups.find((g) => g.label.toLowerCase().includes('other region'));
    assert.ok(otherGroup, 'should have an "other region" group');
    const otherModel = otherGroup!.models.find((m) => m.id === usDefault);
    assert.ok(otherModel, 'US-prefixed default should be in the other-region group');
    assert.ok(otherModel!.label.includes('other region'), `label should say "other region": ${otherModel!.label}`);
  });

  it('does NOT add defaultModel with "other region" if it already matches the fallback', () => {
    const globalDefault = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0';
    const groups = bedrockFallbackForRegion('ap-southeast-1', globalDefault);
    // global.* models are already in the fallback for ap-southeast-1
    const otherGroups = groups.filter((g) => g.label.toLowerCase().includes('other region'));
    assert.equal(otherGroups.length, 0, 'no other-region group when defaultModel is already in the list');
  });
});

describe('listModelsForProvider — Bedrock fallback is region-aware', () => {
  before(async () => {
    await createTestServer();
    const db = getDb();
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.auth', 'ambient');
    _clearModelListCache();
  });

  after(async () => {
    setBedrockListingMock(null);
    _clearModelListCache();
    await cleanup();
  });

  afterEach(() => {
    setBedrockListingMock(null);
    _clearModelListCache();
  });

  it('ap-southeast-1 fallback uses global.* profile IDs, not us.*', async () => {
    setSetting(getDb(), 'bedrock.region', 'ap-southeast-1');
    setBedrockListingMock({ throwError: 'UnauthorizedException' });
    const result = await listModelsForProvider('bedrock', undefined, true);
    assert.equal(result.source, 'fallback');
    const allIds = result.groups.flatMap((g) => g.models.map((m) => m.id));
    const hasGlobalIds = allIds.some((id) => id.startsWith('global.'));
    const hasUsIds = allIds.filter((id) => id.startsWith('us.')).some((id) => id.includes('claude'));
    assert.ok(hasGlobalIds, `Expected at least one global.* ID in fallback for ap-southeast-1, got: ${allIds.join(', ')}`);
    assert.ok(!hasUsIds, `Should not have us.* claude IDs for ap-southeast-1 fallback, got: ${allIds.join(', ')}`);
  });

  it('eu-west-1 fallback uses eu.* profile IDs, not us.*', async () => {
    setSetting(getDb(), 'bedrock.region', 'eu-west-1');
    setBedrockListingMock({ throwError: 'AccessDeniedException' });
    const result = await listModelsForProvider('bedrock', undefined, true);
    assert.equal(result.source, 'fallback');
    const allIds = result.groups.flatMap((g) => g.models.map((m) => m.id));
    const hasEuIds = allIds.some((id) => id.startsWith('eu.'));
    const hasUsIds = allIds.filter((id) => id.startsWith('us.')).some((id) => id.includes('claude'));
    assert.ok(hasEuIds, `Expected at least one eu.* ID, got: ${allIds.join(', ')}`);
    assert.ok(!hasUsIds, `Should not have us.* claude IDs for eu-west-1 fallback, got: ${allIds.join(', ')}`);
  });

  it('us-east-1 fallback uses us.* profile IDs', async () => {
    setSetting(getDb(), 'bedrock.region', 'us-east-1');
    setBedrockListingMock({ throwError: 'CredentialsError' });
    const result = await listModelsForProvider('bedrock', undefined, true);
    assert.equal(result.source, 'fallback');
    const allIds = result.groups.flatMap((g) => g.models.map((m) => m.id));
    const hasUsIds = allIds.some((id) => id.startsWith('us.'));
    assert.ok(hasUsIds, `Expected at least one us.* ID, got: ${allIds.join(', ')}`);
  });
});

describe('listModelsForProvider — Bedrock live listing merges FMs and profiles', () => {
  before(async () => {
    await createTestServer();
    const db = getDb();
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.region', 'ap-southeast-1');
    setSetting(db, 'bedrock.auth', 'ambient');
    _clearModelListCache();
  });

  after(async () => {
    setBedrockListingMock(null);
    _clearModelListCache();
    await cleanup();
  });

  afterEach(() => {
    setBedrockListingMock(null);
    _clearModelListCache();
  });

  it('live result includes both foundation models and inference profiles', async () => {
    setBedrockListingMock({
      foundationModels: [
        {
          modelId: 'anthropic.claude-3-5-sonnet-20241022-v1:0',
          modelName: 'Claude 3.5 Sonnet',
          providerName: 'Anthropic',
          outputModalities: ['TEXT'],
        },
      ],
      inferenceProfiles: [
        {
          inferenceProfileId: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
          inferenceProfileName: 'Claude Sonnet 4.5 Global',
          type: 'SYSTEM_DEFINED',
          status: 'ACTIVE',
        },
        {
          inferenceProfileId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
          inferenceProfileName: 'Claude Haiku 4.5 Global',
          type: 'SYSTEM_DEFINED',
          status: 'ACTIVE',
        },
      ],
    });

    const result = await listModelsForProvider('bedrock', undefined, true);
    assert.equal(result.source, 'live');
    assert.equal(result.error, null);

    const allIds = result.groups.flatMap((g) => g.models.map((m) => m.id));
    assert.ok(
      allIds.includes('anthropic.claude-3-5-sonnet-20241022-v1:0'),
      'foundation model must be in live result',
    );
    assert.ok(
      allIds.includes('global.anthropic.claude-sonnet-4-5-20250929-v1:0'),
      'inference profile must be in live result',
    );
    assert.ok(
      allIds.includes('global.anthropic.claude-haiku-4-5-20251001-v1:0'),
      'second inference profile must be in live result',
    );
  });
});
