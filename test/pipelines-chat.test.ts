import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup } from './fixtures.ts';
import { getAuditRepository } from '../server/repositories/audit.ts';
import type { PipelineRun } from '../server/repositories/pipeline-runs.ts';
import {
  chatUrlProblem, getChatTarget, setChatUrl, chatUrlHint, chatStatus, buildChatMessage, sendChat,
  _setChatFetch, _setChatBackoff, _setChatTimeout,
} from '../server/pipelines/chat.ts';

const actor = { actorId: 'u1', ip: '10.0.0.1' };
const SLACK = 'https://hooks.slack.com/services/T000/B000/abcdWXYZ';
const TEAMS = 'https://contoso.webhook.office.com/webhookb2/abc/IncomingWebhook/def/wxyz';
const LOGIC = 'https://prod-1.westus.logic.azure.com/workflows/abc?sig=q1w2';

before(async () => { await createTestServer(); });
after(() => { _setChatFetch(null); _setChatBackoff(null); _setChatTimeout(null); return cleanup(); });
beforeEach(() => { _setChatBackoff([0, 0]); _setChatTimeout(null); });

type Call = { url: string; init: RequestInit };
function fake(responses: Array<number | Error>) {
  const calls: Call[] = [];
  let i = 0;
  _setChatFetch((async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return { status: r, ok: r >= 200 && r < 300 } as Response;
  }) as typeof fetch);
  return calls;
}

describe('chatUrlProblem', () => {
  it('allows Slack, Teams and Logic Apps URLs', () => {
    for (const u of [SLACK, TEAMS, LOGIC]) assert.equal(chatUrlProblem(u), null, u);
  });
  it('refuses everything else', () => {
    for (const u of [
      '', 'http://hooks.slack.com/services/x', 'https://hooks.slack.com.evil.com/x', 'https://user:pw@hooks.slack.com/x',
      'https://user@hooks.slack.com/x', 'https://example.com/x', 'https://hooks.slack.com:8443/x', 'https://webhook.office.com/x',
      'https://evilwebhook.office.com/x', 'https://.logic.azure.com/x', 'https://hooks.slack.com/a b', 'https://hooks.slack.com/a\nb',
      'https://hooks.slack.com/' + 'a'.repeat(2000), 'not a url', 'https://x.webhook.office.com.evil.com/x',
    ]) assert.notEqual(chatUrlProblem(u), null, JSON.stringify(u.slice(0, 60)));
    assert.equal(chatUrlProblem('https://hooks.slack.com:443/x'), null);
  });
});

describe('storage', () => {
  it('stores, hints (host and last 4 only), audits and clears', async () => {
    assert.equal(await getChatTarget('c1'), null);
    assert.equal(await chatUrlHint('c1'), null);
    await setChatUrl('c1', SLACK, actor);
    assert.deepEqual(await getChatTarget('c1'), { url: SLACK, kind: 'slack' });
    const hint = await chatUrlHint('c1');
    assert.deepEqual(hint, { host: 'hooks.slack.com', last4: 'WXYZ' });
    assert.ok(!JSON.stringify(hint).includes('services'));
    await setChatUrl('c2', TEAMS, actor);
    assert.equal((await getChatTarget('c2'))?.kind, 'teams');
    const audits = (await getAuditRepository().query({ limit: 100, action: 'pipelines.chat.update' })).entries;
    assert.ok(audits.some((e) => e.target === 'c1' && e.actor_id === 'u1'));
    assert.ok(!JSON.stringify(audits).includes('abcdWXYZ'));
    await setChatUrl('c1', null, actor);
    assert.equal(await getChatTarget('c1'), null);
    assert.equal(await chatUrlHint('c1'), null);
  });
  it('rejects a bad URL and stores nothing', async () => {
    await assert.rejects(setChatUrl('c3', 'https://example.com/x', actor));
    assert.equal(await getChatTarget('c3'), null);
  });
});

describe('sendChat', () => {
  it('posts a Slack body', async () => {
    await setChatUrl('s1', SLACK, actor);
    const calls = fake([200]);
    assert.equal(await sendChat('s1', 'hello'), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, SLACK);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.redirect, 'manual');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { text: 'hello' });
  });
  it('posts a Teams Adaptive Card with the same text', async () => {
    await setChatUrl('s2', TEAMS, actor);
    const calls = fake([202]);
    assert.equal(await sendChat('s2', 'hello'), true);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: {
        type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: 'hello', wrap: true }] } }],
    });
  });
  it('retries a 500 and succeeds on the second try', async () => {
    await setChatUrl('s3', SLACK, actor);
    const calls = fake([500, 200]);
    assert.equal(await sendChat('s3', 'x'), true);
    assert.equal(calls.length, 2);
    assert.equal((await chatStatus('s3')).lastFailureAt, null);
  });
  it('records a failure after three tries without the URL', async () => {
    await setChatUrl('s4', SLACK, actor);
    const calls = fake([500]);
    assert.equal(await sendChat('s4', 'x'), false);
    assert.equal(calls.length, 3);
    const st = await chatStatus('s4');
    assert.ok(st.lastFailureAt);
    assert.equal(st.lastError, 'HTTP 500');
  });
  it('error text never contains the URL, even when fetch throws one', async () => {
    await setChatUrl('s5', SLACK, actor);
    fake([new Error(`connect failed ${SLACK}`)]);
    assert.equal(await sendChat('s5', 'x'), false);
    const st = await chatStatus('s5');
    assert.ok(st.lastError);
    assert.ok(!st.lastError.includes('hooks.slack.com') && !st.lastError.includes('abcdWXYZ'));
  });
  it('does not retry a 404 but retries a 429', async () => {
    await setChatUrl('s9', SLACK, actor);
    let calls = fake([404]);
    assert.equal(await sendChat('s9', 'x'), false);
    assert.equal(calls.length, 1);
    assert.equal((await chatStatus('s9')).lastError, 'HTTP 404');
    calls = fake([429, 200]);
    assert.equal(await sendChat('s9', 'x'), true);
    assert.equal(calls.length, 2);
  });
  it('aborts a hung try and records a timeout', async () => {
    await setChatUrl('s10', SLACK, actor);
    _setChatTimeout(20);
    let n = 0;
    _setChatFetch(((_u: string, init: RequestInit) => { n++; return new Promise((_res, rej) => {
      init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }); }) as typeof fetch);
    assert.equal(await sendChat('s10', 'x'), false);
    assert.equal(n, 3);
    assert.equal((await chatStatus('s10')).lastError, 'timeout');
  });
  it('treats a 302 as failure and does not follow it', async () => {
    await setChatUrl('s6', SLACK, actor);
    const calls = fake([302]);
    assert.equal(await sendChat('s6', 'x'), false);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.url === SLACK));
    assert.equal((await chatStatus('s6')).lastError, 'redirect refused');
  });
  it('returns false without throwing when no URL is set, and success clears the failure', async () => {
    const calls = fake([200]);
    assert.equal(await sendChat('none', 'x'), false);
    assert.equal(calls.length, 0);
    await setChatUrl('s7', SLACK, actor);
    fake([500]);
    await sendChat('s7', 'x');
    assert.ok((await chatStatus('s7')).lastFailureAt);
    fake([200]);
    assert.equal(await sendChat('s7', 'x'), true);
    assert.deepEqual(await chatStatus('s7'), { lastFailureAt: null, lastError: null });
  });
  it('clearing the URL clears the status', async () => {
    await setChatUrl('s8', SLACK, actor);
    fake([500]);
    await sendChat('s8', 'x');
    await setChatUrl('s8', null, actor);
    assert.deepEqual(await chatStatus('s8'), { lastFailureAt: null, lastError: null });
  });
});

describe('buildChatMessage', () => {
  const run = {
    workflow_name: 'Deploy prod', repo_full_name: 'acme/app', branch: 'main', head_sha: 'abcdef1234567890', actor: 'jo',
    html_url: 'https://github.com/acme/app/actions/runs/9',
  } as PipelineRun;
  it('matches the copy', () => {
    assert.equal(buildChatMessage('failed', run), 'Deploy failed: Deploy prod on acme/app@main (abcdef1) by jo. https://github.com/acme/app/actions/runs/9');
    assert.equal(buildChatMessage('recovered', run), 'Deploy recovered: Deploy prod on acme/app@main (abcdef1) by jo. https://github.com/acme/app/actions/runs/9');
  });
  it('escapes dynamic fields for Slack and neutralises markdown for Teams, URL unchanged', () => {
    const evil = { ...run, workflow_name: '<!channel> <https://evil|click>', branch: 'a&b<c>', actor: '<@U123>' } as PipelineRun;
    const slack = buildChatMessage('failed', evil, 'slack');
    assert.equal(slack, 'Deploy failed: &lt;!channel&gt; &lt;https://evil|click&gt; on acme/app@a&amp;b&lt;c&gt; (abcdef1) by &lt;@U123&gt;. https://github.com/acme/app/actions/runs/9');
    const md = { ...run, workflow_name: '[x](https://evil) *b* _i_ `c`' } as PipelineRun;
    const teams = buildChatMessage('failed', md, 'teams');
    assert.ok(teams.startsWith('Deploy failed: \\[x\\]\\(https://evil\\) \\*b\\* \\_i\\_ \\`c\\` on '));
    assert.ok(teams.endsWith('. https://github.com/acme/app/actions/runs/9'));
  });
});
