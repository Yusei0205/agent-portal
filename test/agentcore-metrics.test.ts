/**
 * AgentCore page: the runtime figures are grouped by runtime name (a recreated runtime is one row), costed from the published
 * rates, and the route is for admins only.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { buildSnapshot, runtimeName, RATE_GB_HOUR, RATE_VCPU_HOUR } from '../server/agentcore-metrics.ts';
import type { Series } from '../server/agentcore-metrics.ts';

const day = (n: number) => Date.UTC(2026, 10, n);
const s = (metric: string, name: string, resource: string, values: number[]): Series => ({
  metric, name, resource, points: values.map((v, i) => ({ t: day(10 + i), v })),
});

describe('runtimeName', () => {
  test('drops the ::DEFAULT endpoint suffix', () => {
    assert.equal(runtimeName('agentPortalJobRunner::DEFAULT', 'arn:x:runtime/agentPortalJobRunner-efN9t16x1P'), 'agentPortalJobRunner');
  });
  test('falls back to the runtime id without its random suffix', () => {
    assert.equal(runtimeName('', 'arn:aws:bedrock-agentcore:r:1:runtime/agentPortalCodexRunner-zv1jk79Zxs'), 'agentPortalCodexRunner');
  });
});

describe('buildSnapshot', () => {
  const series = [
    // Two incarnations of the job runner are one row.
    s('MemoryUsed-GBHours', 'agentPortalJobRunner::DEFAULT', 'arn:x:runtime/agentPortalJobRunner-aaaaaaaaaa', [100, 0]),
    s('MemoryUsed-GBHours', 'agentPortalJobRunner::DEFAULT', 'arn:x:runtime/agentPortalJobRunner-bbbbbbbbbb', [0, 300]),
    s('CPUUsed-vCPUHours', 'agentPortalJobRunner::DEFAULT', 'arn:x:runtime/agentPortalJobRunner-bbbbbbbbbb', [1, 1]),
    s('MemoryUsed-GBHours', 'agentPortalClaudeHarness::DEFAULT', 'arn:x:runtime/agentPortalClaudeHarness-cccccccccc', [10, 0]),
    s('Errors', 'agentPortalClaudeHarness::DEFAULT', 'arn:x:runtime/agentPortalClaudeHarness-cccccccccc', [2, 0]),
    s('MemoryUsed-GBHours', 'agentPortalIdle::DEFAULT', 'arn:x:runtime/agentPortalIdle-dddddddddd', [0, 0]),
  ];
  const snap = buildSnapshot('7d', series, 3, new Date(day(12)));

  test('groups runtimes by name and sorts by estimated cost', () => {
    assert.deepEqual(snap.runtimes.map((r) => r.name), ['agentPortalJobRunner', 'agentPortalClaudeHarness']);
    const job = snap.runtimes[0];
    assert.equal(job.gbHours, 400);
    assert.equal(job.vcpuHours, 2);
  });

  test('costs from the published rates and reports the memory share', () => {
    const job = snap.runtimes[0];
    assert.ok(Math.abs(job.estCostUsd - (400 * RATE_GB_HOUR + 2 * RATE_VCPU_HOUR)) < 1e-9);
    assert.ok(job.memoryShare > 0.9 && job.memoryShare < 1);
  });

  test('leaves out a runtime that reported nothing, and keeps totals and active sessions', () => {
    assert.ok(!snap.runtimes.some((r) => r.name === 'agentPortalIdle'));
    assert.equal(snap.activeSessions, 3);
    assert.equal(snap.totals.errors, 2);
    assert.equal(snap.totals.gbHours, 410);
  });

  test('builds a timeline across runtimes, oldest first', () => {
    assert.equal(snap.timeline.length, 2);
    assert.equal(snap.timeline[0].gbHours, 110);
    assert.equal(snap.timeline[1].gbHours, 300);
    assert.ok(snap.timeline[0].t < snap.timeline[1].t);
  });
});

describe('GET /api/agentcore/metrics', () => {
  let baseUrl: string;
  let adminCookie = '';
  let memberCookie = '';
  before(async () => {
    ({ baseUrl } = await createTestServer());
    await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'admin@agentcore.test', password: 'adminpass1', name: 'Admin' } });
    adminCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'admin@agentcore.test', password: 'adminpass1' } })).cookie ?? '';
    const { getDb } = await import('../server/db.ts');
    const { hashPassword } = await import('../server/auth.ts');
    const { now } = await import('../server/util.ts');
    getDb().prepare('INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
      .run('user-agentcore-member', 'member@agentcore.test', 'Member', hashPassword('memberpass1'), now());
    memberCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'member@agentcore.test', password: 'memberpass1' } })).cookie ?? '';
  });
  after(cleanup);

  test('is for admins only', async () => {
    const r = await fetchJson(baseUrl, '/api/agentcore/metrics', { cookie: memberCookie });
    assert.equal(r.status, 403);
  });

  test('rejects an unknown period', async () => {
    const r = await fetchJson(baseUrl, '/api/agentcore/metrics?period=1y', { cookie: adminCookie });
    assert.equal(r.status, 400);
  });
});
