import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup } from './fixtures.ts';
import { getAuditRepository } from '../server/repositories/audit.ts';
import {
  DEFAULT_PIPELINE_SETTINGS, getPipelineSettings, savePipelineSettings, isDeployWorkflow, isAlertingBranch,
} from '../server/pipelines/settings.ts';

const actor = { actorId: 'u1', ip: '10.0.0.1' };

before(async () => { await createTestServer(); });
after(cleanup);

describe('pipeline settings', () => {
  it('defaults when nothing is stored', async () => {
    assert.deepEqual(await getPipelineSettings('p-none'), DEFAULT_PIPELINE_SETTINGS);
  });
  it('saves trimmed values, merges patches and audits', async () => {
    const s = await savePipelineSettings('p1', { deploy_workflows: [' Ship it ', ''] }, actor);
    assert.deepEqual(s, { deploy_workflows: ['Ship it'], alert_branches: [] });
    const s2 = await savePipelineSettings('p1', { alert_branches: ['release'] }, actor);
    assert.deepEqual(s2, { deploy_workflows: ['Ship it'], alert_branches: ['release'] });
    assert.deepEqual(await getPipelineSettings('p1'), s2);
    const entries = (await getAuditRepository().query({ limit: 100, action: 'pipelines.settings.update' })).entries;
    assert.ok(entries.some((e) => e.target === 'p1' && e.actor_id === 'u1' && (e as { ip?: string }).ip === '10.0.0.1'));
  });
  it('rejects bad input and stores nothing', async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `w${i}`);
    await assert.rejects(savePipelineSettings('p2', { deploy_workflows: tooMany }, actor));
    await assert.rejects(savePipelineSettings('p2', { alert_branches: ['x'.repeat(101)] }, actor));
    await assert.rejects(savePipelineSettings('p2', { deploy_workflows: [1 as unknown as string] }, actor));
    await assert.rejects(savePipelineSettings('p2', { deploy_workflows: 'a' as unknown as string[] }, actor));
    assert.deepEqual(await getPipelineSettings('p2'), DEFAULT_PIPELINE_SETTINGS);
    await savePipelineSettings('p2', { deploy_workflows: Array.from({ length: 50 }, (_, i) => `w${i}`), alert_branches: ['x'.repeat(100)] }, actor);
  });
});

describe('settings hardening', () => {
  it('rejects a null or non-object patch', async () => {
    for (const bad of [null, 'x', [1], 5]) await assert.rejects(savePipelineSettings('p3', bad as never, actor), /object/);
  });
  it('strips control, bidi and zero-width characters from entries', async () => {
    const s = await savePipelineSettings('p3', { alert_branches: ['re\u202Elease\u200B', '\u200B'] }, actor);
    assert.deepEqual(s.alert_branches, ['release']);
  });
});

describe('isDeployWorkflow', () => {
  it('defaults to a name containing deploy', () => {
    assert.equal(isDeployWorkflow(DEFAULT_PIPELINE_SETTINGS, 'Deploy portal'), true);
    assert.equal(isDeployWorkflow(DEFAULT_PIPELINE_SETTINGS, 'prod-DEPLOYMENT'), true);
    assert.equal(isDeployWorkflow(DEFAULT_PIPELINE_SETTINGS, 'CI'), false);
  });
  it('uses an explicit list as exact case-insensitive match', () => {
    const s = { deploy_workflows: ['Ship It'], alert_branches: [] };
    assert.equal(isDeployWorkflow(s, 'ship it'), true);
    assert.equal(isDeployWorkflow(s, 'Deploy portal'), false);
  });
});

describe('isAlertingBranch', () => {
  it('alerts on the default branch only by default', () => {
    assert.equal(isAlertingBranch(DEFAULT_PIPELINE_SETTINGS, 'main', 'main'), true);
    assert.equal(isAlertingBranch(DEFAULT_PIPELINE_SETTINGS, 'dev', 'main'), false);
    assert.equal(isAlertingBranch(DEFAULT_PIPELINE_SETTINGS, 'main', null), false);
  });
  it('adds the extra branches', () => {
    const s = { deploy_workflows: [], alert_branches: ['release'] };
    assert.equal(isAlertingBranch(s, 'release', 'main'), true);
    assert.equal(isAlertingBranch(s, 'release', null), true);
    assert.equal(isAlertingBranch(s, 'dev', 'main'), false);
  });
});
