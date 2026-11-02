/**
 * MCP core tools on the repositories: sessions, transcripts, reviews, scans.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getReviewsRepository } from '../server/repositories/reviews.ts';
import { getGitReposRepository } from '../server/repositories/git-repos.ts';
import { now, generateId } from '../server/util.ts';

const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

async function tool(baseUrl: string, token: string, name: string, args: object): Promise<{ data: any; isError: boolean }> {
  const resp = await fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await resp.text();
  const m = text.match(/^data:\s*(.+)$/m);
  const envelope = JSON.parse(m ? m[1] : text) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
  const first = envelope.result?.content?.[0]?.text ?? '{}';
  let data: any;
  try { data = JSON.parse(first); } catch { data = { message: first }; }
  return { data, isError: Boolean(envelope.result?.isError) };
}

describe('MCP core tools', () => {
  let baseUrl = '';
  let token = '';
  let projectId = '';

  before(async () => {
    const srv = await createTestServer();
    baseUrl = srv.baseUrl;
    const setup = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST', body: { email: `mcp-core-${Date.now()}@example.com`, name: 'Admin', password: 'password1234' },
    });
    const cookie = setup.cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'MCP Core' }, cookie });
    projectId = ((p.body as any).project as any).id as string;
    const t = await fetchJson(baseUrl, '/api/api-tokens', {
      method: 'POST', body: { name: 'core', scopes: ['read', 'write', 'review'] }, cookie,
    });
    token = (t.body as { token: string }).token;
  });
  after(cleanup);

  it('starts a session, lists it, prompts it and reads its transcript', async () => {
    const started = await tool(baseUrl, token, 'start_session', { projectId, goal: 'say hello', engine: 'demo' });
    assert.equal(started.isError, false, JSON.stringify(started.data));
    const workflowId = started.data.workflowId as string;
    assert.ok(workflowId);

    const list = await tool(baseUrl, token, 'list_sessions', { projectId });
    assert.ok(list.data.sessions.some((s: any) => s.id === workflowId));
    assert.ok(list.data.total >= 1);

    const prompted = await tool(baseUrl, token, 'prompt_session', { projectId, workflowId, message: 'also be brief' });
    assert.equal(prompted.data.ok, true);
    assert.equal(prompted.data.kind, 'human');

    // the demo run finishes quickly; wait for events to appear
    let events: any[] = [];
    for (let i = 0; i < 40 && events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 150));
      events = (await tool(baseUrl, token, 'get_transcript', { projectId, workflowId })).data.events ?? [];
    }
    assert.ok(events.length > 0, 'transcript has events');

    const wrongProject = await tool(baseUrl, token, 'get_transcript', { projectId, workflowId: 'does-not-exist' });
    assert.equal(wrongProject.isError, true);
  });

  it('starts a review, waits for it, lists it and reads its findings', async () => {
    const repoId = generateId();
    await getGitReposRepository().create({
      id: repoId, project_id: projectId, name: 'app', url: 'https://github.com/o/app', provider: 'github', status: 'ready',
      default_branch: 'main', identity: null, last_synced_at: null, last_error: null, created_at: now(), connection_id: null,
    });
    const started = await tool(baseUrl, token, 'start_review', { projectId, repoId, baseRef: 'main', headRef: 'feature' });
    const reviewId = (started.data.reviewId ?? started.data.id) as string;
    assert.ok(reviewId, JSON.stringify(started.data));

    await getReviewsRepository().createFinding({
      id: generateId(), review_id: reviewId, file_path: 'a.ts', line_number: 3, severity: 'high', title: 'Bug',
      body: 'details', confidence: 0.9, accepted: 0, posted_at: null, created_at: now(),
    });
    await getReviewsRepository().update(reviewId, { status: 'done' });

    const waited = await tool(baseUrl, token, 'wait_for_review', { projectId, reviewId, timeoutMs: 2000 });
    assert.equal(waited.data.review.status, 'done');
    assert.equal(waited.data.findingsCount, 1);

    const got = await tool(baseUrl, token, 'get_review', { projectId, reviewId });
    assert.equal(got.data.findings.length, 1);
    assert.equal(got.data.findings[0].title, 'Bug');

    const list = await tool(baseUrl, token, 'list_reviews', { projectId, status: 'done' });
    assert.ok(list.data.reviews.some((r: any) => r.id === reviewId));

    const other = await tool(baseUrl, token, 'get_review', { projectId, reviewId: 'nope' });
    assert.equal(other.isError, true);
  });
});
