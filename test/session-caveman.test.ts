/**
 * Terse (caveman) replies for a Claude session, chosen when it is started.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { cavemanMode, setCavemanMode, cavemanInstructions, withCavemanGuidance, CAVEMAN_REMINDER } from '../server/agent/caveman-guidance.ts';

describe('caveman guidance text', () => {
  it('uses the bundled skill without its front matter', () => {
    const text = cavemanInstructions();
    assert.doesNotMatch(text, /^---/);
    assert.match(text, /Respond terse like smart caveman/);
    assert.match(text, /stop caveman/);
  });

  it('leaves the prompt alone when the option is off', () => {
    assert.equal(withCavemanGuidance('Fix the bug', false, true), 'Fix the bug');
    assert.equal(withCavemanGuidance('Fix the bug', false, false), 'Fix the bug');
  });

  it('adds the full instructions on the first turn and a one-line reminder after', () => {
    const first = withCavemanGuidance('Fix the bug', true, true);
    assert.ok(first.startsWith('Fix the bug\n\n'));
    assert.match(first, /Respond terse like smart caveman/);
    const later = withCavemanGuidance('And the tests', true, false);
    assert.equal(later, `And the tests\n\n${CAVEMAN_REMINDER}`);
    assert.ok(later.length < first.length / 4, 'the reminder is short');
  });
});

describe('starting a session with terse replies', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    const r = await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: `cv-${Date.now()}@example.com`, name: 'A', password: 'password1234', provider: 'demo' } });
    cookie = r.cookie ?? '';
    const pr = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: `Caveman ${Date.now()}` }, cookie });
    projectId = ((pr.body as any).project as any).id;
  });
  after(async () => { await cleanup(); });

  const start = async (body: Record<string, unknown>) => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', body: { goal: '', trustTools: false, ...body }, cookie });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return String(((r.body as any).workflow as any).id);
  };

  it('turns the mode on for a Claude session that asks for it', async () => {
    const id = await start({ engine: 'claude-code', caveman: true });
    assert.equal(cavemanMode(id), true);
  });

  it('does nothing for a Claude session that does not ask, or for another engine', async () => {
    assert.equal(cavemanMode(await start({ engine: 'claude-code' })), false);
    assert.equal(cavemanMode(await start({ engine: 'demo', caveman: true })), false);
  });

  it('can be switched off again', async () => {
    const id = await start({ engine: 'claude-code', caveman: true });
    await setCavemanMode(id, false);
    assert.equal(cavemanMode(id), false);
  });
});
