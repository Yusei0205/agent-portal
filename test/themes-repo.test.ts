/**
 * Contract tests for ThemesRepository.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './fixtures.ts';
import { closeDb } from '../server/db.ts';
import type { ThemesRepository } from '../server/repositories/themes.ts';
import { clearThemesRepository } from '../server/repositories/themes.ts';
import { generateId, now } from '../server/util.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

function themeId() { return `theme-${RUN_TAG}-${generateId().slice(0, 8)}`; }

const SAMPLE_TPL = JSON.stringify({
  id: 'sample', name: 'Sample', version: 1, brand: { productName: 'Portal' },
  modes: { dark: { canvas: '#000', panel: '#111', ink: '#fff', line: '#222', 'ink-2': '#aaa', 'ink-3': '#777', accent: '#08f', 'accent-2': '#0af', 'accent-3': '#0cf', 'accent-ink': '#fff', 'accent-wash': 'rgba(0,136,255,0.1)', link: '#08f', 'line-2': '#333', raised: '#222', rail: '#1a1a1a', ok: '#0c4', 'ok-wash': 'rgba(0,204,68,0.1)', warn: '#fa0', 'warn-wash': 'rgba(255,170,0,0.1)', danger: '#f44', 'danger-wash': 'rgba(255,68,68,0.1)', info: '#09f', 'info-wash': 'rgba(0,153,255,0.1)', focus: '#08f', glow: '0 0 8px rgba(0,136,255,0.4)', 'code-bg': '#1a1a1a', shadow: '0 2px 8px rgba(0,0,0,0.5)' } },
  fonts: { display: 'Inter', body: 'Inter', mono: 'JetBrains Mono' },
  effects: { glow: false, gridBackground: false, gradientAccents: false, motion: 'full' },
  radius: { sm: 4, md: 8, lg: 12 },
});

function runSuite(label: string, setup: () => Promise<ThemesRepository>, isSqlite: boolean): void {
  describe(label, () => {
    let repo: ThemesRepository;

    before(async () => {
      if (isSqlite) createTestDb();
      repo = await setup();
    });

    after(() => {
      clearThemesRepository();
      if (isSqlite) closeDb();
    });

    test('create and getById round trip', async () => {
      const id = themeId();
      const created = await repo.create({ id, name: 'Test Theme', template_json: SAMPLE_TPL, builtin_override: 0, created_by: null, updated_by: null, created_at: now(), updated_at: now() });
      assert.equal(created.id, id);
      const fetched = await repo.getById(id);
      assert.ok(fetched);
      assert.equal(fetched.id, id);
    });

    test('getCustomById returns custom theme', async () => {
      const id = themeId();
      await repo.create({ id, name: 'Custom', template_json: SAMPLE_TPL, builtin_override: 0, created_by: null, updated_by: null, created_at: now(), updated_at: now() });
      assert.ok(await repo.getCustomById(id));
    });

    test('getCustomById returns null for override', async () => {
      const id = themeId();
      await repo.create({ id, name: 'Override', template_json: SAMPLE_TPL, builtin_override: 1, created_by: null, updated_by: null, created_at: now(), updated_at: now() });
      assert.equal(await repo.getCustomById(id), null);
    });

    test('getOverrideById returns builtin override', async () => {
      const id = themeId();
      await repo.create({ id, name: 'Override', template_json: SAMPLE_TPL, builtin_override: 1, created_by: null, updated_by: null, created_at: now(), updated_at: now() });
      const result = await repo.getOverrideById(id);
      assert.ok(result);
      assert.equal(result.builtin_override, 1);
    });

    test('hasOverride returns true for override, false otherwise', async () => {
      const id1 = themeId(); const id2 = themeId();
      await repo.create({ id: id1, name: 'O', template_json: SAMPLE_TPL, builtin_override: 1, created_by: null, updated_by: null, created_at: now(), updated_at: now() });
      await repo.create({ id: id2, name: 'C', template_json: SAMPLE_TPL, builtin_override: 0, created_by: null, updated_by: null, created_at: now(), updated_at: now() });
      assert.equal(await repo.hasOverride(id1), true);
      assert.equal(await repo.hasOverride(id2), false);
    });

    test('listCustom excludes overrides', async () => {
      const id1 = themeId(); const id2 = themeId();
      await repo.create({ id: id1, name: 'Custom A', template_json: SAMPLE_TPL, builtin_override: 0, created_by: null, updated_by: null, created_at: now(), updated_at: now() });
      await repo.create({ id: id2, name: 'Override B', template_json: SAMPLE_TPL, builtin_override: 1, created_by: null, updated_by: null, created_at: now(), updated_at: now() });
      const customs = await repo.listCustom();
      assert.ok(customs.some((t) => t.id === id1));
      assert.ok(!customs.some((t) => t.id === id2));
    });

    test('update modifies name', async () => {
      const id = themeId();
      await repo.create({ id, name: 'Original', template_json: SAMPLE_TPL, builtin_override: 0, created_by: null, updated_by: null, created_at: now(), updated_at: now() });
      const updated = await repo.update(id, { name: 'Renamed', updated_at: now() });
      assert.ok(updated);
      assert.equal(updated.name, 'Renamed');
    });

    test('delete removes theme', async () => {
      const id = themeId();
      await repo.create({ id, name: 'ToDelete', template_json: SAMPLE_TPL, builtin_override: 0, created_by: null, updated_by: null, created_at: now(), updated_at: now() });
      await repo.delete(id);
      assert.equal(await repo.getById(id), null);
    });
  });
}

runSuite('SQLite', async () => {
  const { SqliteThemesRepository } = await import('../server/repositories/themes-sqlite.ts');
  return new SqliteThemesRepository();
}, true);

(async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const require2 = process.env.REQUIRE_DYNAMODB === '1';
  if (!endpoint) {
    if (require2) throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT not set');
    describe('DynamoDB Local suite', () => { test('SKIP — DynamoDB Local not reachable', () => {}); });
    return;
  }

  process.env.DYNAMODB_TABLE_PORTAL_CONFIG = `portal-config-themes-test-${RUN_TAG}`;
  const { clearDynamoDbClient, getDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');
  clearDynamoDbClient();
  const { DynamoDbThemesRepository, ensureThemesTableExists } =
    await import('../server/repositories/themes-dynamodb.ts');
  await ensureThemesTableExists(getDynamoDbClient());

  runSuite('DynamoDB Local suite', async () => new DynamoDbThemesRepository(), false);
})();
