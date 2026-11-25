/**
 * Terse (caveman) replies for a Claude session, chosen when it is started.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { cavemanMode, setCavemanMode, cavemanInstructions, withCavemanGuidance, CAVEMAN_REMINDER, ponytailMode, setPonytailMode, ponytailInstructions, withSessionGuidance, withPonytailGuidance, PONYTAIL_REMINDER } from '../server/agent/caveman-guidance.ts';

describe('caveman guidance text', () => {
  it('uses the bundled ruleset, first in the prompt', () => {
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

describe('ponytail guidance text', () => {
  it('uses the bundled skill without its front matter', () => {
    const text = ponytailInstructions();
    assert.doesNotMatch(text, /^---/);
    assert.match(text, /lazy senior developer/i);
    const first = withPonytailGuidance('Fix it', true, true);
    assert.ok(first.startsWith('Coding rules for this whole session'), 'the rules come first');
    assert.ok(first.endsWith('\n\nFix it'), 'the task stays last and unchanged');
    assert.match(first, /stop ponytail/);
    assert.equal(withPonytailGuidance('Next', true, false), `${PONYTAIL_REMINDER}\n\nNext`);
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

  it('also works for Kiro and Codex sessions', async () => {
    assert.equal(cavemanMode(await start({ engine: 'kiro', caveman: true })), true);
    assert.equal(cavemanMode(await start({ engine: 'codex', caveman: true })), true);
  });

  it('does nothing for a session that does not ask, or for the demo engine', async () => {
    assert.equal(cavemanMode(await start({ engine: 'claude-code' })), false);
    assert.equal(cavemanMode(await start({ engine: 'kiro' })), false);
    assert.equal(cavemanMode(await start({ engine: 'demo', caveman: true })), false);
  });

  it('turns ponytail on for a real engine that asks, and not for the demo engine or a session that does not ask', async () => {
    assert.equal(ponytailMode(await start({ engine: 'claude-code', ponytail: true })), true);
    assert.equal(ponytailMode(await start({ engine: 'kiro', ponytail: true })), true);
    assert.equal(ponytailMode(await start({ engine: 'claude-code' })), false);
    assert.equal(ponytailMode(await start({ engine: 'demo', ponytail: true })), false);
    const both = await start({ engine: 'codex', caveman: true, ponytail: true });
    assert.equal(cavemanMode(both) && ponytailMode(both), true);
  });

  it('guidance: nothing when both styles are off, each style on its own, or both together', async () => {
    const a = await start({ engine: 'claude-code' });
    assert.equal(withSessionGuidance('Fix it', a, true), 'Fix it');
    await setPonytailMode(a, true);
    const first = withSessionGuidance('Fix it', a, true);
    assert.match(first, /lazy senior developer/i);
    assert.doesNotMatch(first, /Respond terse like smart caveman/);
    assert.equal(withSessionGuidance('Next', a, false), `${PONYTAIL_REMINDER}\n\nNext`);
    const b = await start({ engine: 'claude-code', caveman: true, ponytail: true });
    const both = withSessionGuidance('Fix it', b, true);
    assert.match(both, /Respond terse like smart caveman/);
    assert.match(both, /lazy senior developer/i);
    assert.equal(withSessionGuidance('Next', b, false), `${PONYTAIL_REMINDER}\n\nNext\n\n${CAVEMAN_REMINDER}`);
  });

  it('can be switched off again', async () => {
    const id = await start({ engine: 'claude-code', caveman: true });
    await setCavemanMode(id, false);
    assert.equal(cavemanMode(id), false);
  });
});
