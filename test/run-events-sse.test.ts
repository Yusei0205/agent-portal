/**
 * GET /api/runs/:id/events — live delivery.
 *
 * The session view (web/src/lib/useRunStream.js) only reads frames shaped
 * { type: 'event', event: { id, run_id, type, payload, created_at } }.
 * Events emitted while a client is connected must arrive in that shape,
 * not only in the history replayed on connect, and only for the requested run.
 */

import http from 'node:http';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { emitRunEvent } from '../server/agent/runner.ts';
import { insert } from '../server/db.ts';

type Frame = { type?: string; event?: { id?: number; run_id?: string; type?: string; payload?: Record<string, unknown> } };

function openSse(baseUrl: string, path: string, cookie: string) {
  const frames: Frame[] = [];
  let status = 0;
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => { resolveReady = r; });
  const { hostname, port } = new URL(baseUrl);
  const req = http.request(
    { hostname, port: Number(port), path, method: 'GET', headers: { Cookie: cookie } },
    (res) => {
      status = res.statusCode ?? 0;
      if (status !== 200) resolveReady();
      let buf = '';
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          if (part.startsWith(': connected')) { resolveReady(); continue; }
          for (const line of part.split('\n')) {
            if (line.startsWith('data: ')) {
              try { frames.push(JSON.parse(line.slice(6)) as Frame); } catch { /* ignore */ }
            }
          }
        }
      });
    },
  );
  req.on('error', () => { /* closed by test */ });
  req.end();
  return { frames, ready, status: () => status, close: () => req.destroy() };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('GET /api/runs/:id/events — live events', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let workflowId: string;
  let runId: string;

  before(async () => {
    ({ baseUrl } = await createTestServer());
    const setup = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: 'run-sse@example.com', name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    cookie = setup.cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Run SSE' }, cookie });
    projectId = ((p.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
    const w = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'run sse test', engine: 'demo' },
      cookie,
    });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    workflowId = ((w.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
    // A run row is enough; the stream reads p6_runs + p6_events only.
    runId = `run-sse-${Date.now()}`;
    insert('p6_runs', { id: runId, workflow_id: workflowId, status: 'running', created_at: new Date().toISOString() });
  });

  after(async () => cleanup());

  it('delivers an event emitted after connecting, in the replay frame shape with an id', async () => {
    const sse = openSse(baseUrl, `/api/runs/${runId}/events`, cookie);
    await sse.ready;
    assert.equal(sse.status(), 200);

    emitRunEvent(runId, projectId, workflowId, 'assistant-text', { text: 'live-marker', stream: true });
    await wait(150);
    sse.close();

    const live = sse.frames.find((f) => f.event?.payload?.text === 'live-marker');
    assert.ok(live, `live event not received; frames: ${JSON.stringify(sse.frames).slice(0, 500)}`);
    assert.equal(live.type, 'event');
    assert.equal(live.event?.type, 'assistant-text');
    assert.equal(live.event?.run_id, runId);
    assert.equal(typeof live.event?.id, 'number');
    assert.ok((live.event?.id ?? 0) > 0);
    assert.ok(!sse.frames.some((f) => f.type === 'run.event'), 'project-channel frames must not leak into the run stream');
  });

  it('replays the same event with the same id after reconnecting', async () => {
    const sse = openSse(baseUrl, `/api/runs/${runId}/events`, cookie);
    await sse.ready;
    await wait(100);
    sse.close();
    const matches = sse.frames.filter((f) => f.event?.payload?.text === 'live-marker');
    assert.equal(matches.length, 1);
  });

  it('does not deliver events from another run', async () => {
    const sse = openSse(baseUrl, `/api/runs/${runId}/events`, cookie);
    await sse.ready;
    const otherRun = `run-sse-other-${Date.now()}`;
    insert('p6_runs', { id: otherRun, workflow_id: workflowId, status: 'running', created_at: new Date().toISOString() });
    emitRunEvent(otherRun, projectId, workflowId, 'assistant-text', { text: 'other-run-marker' });
    await wait(150);
    sse.close();
    assert.ok(!sse.frames.some((f) => f.event?.payload?.text === 'other-run-marker'));
  });

  it('rejects requests without a session', async () => {
    const sse = openSse(baseUrl, `/api/runs/${runId}/events`, '');
    await sse.ready;
    sse.close();
    assert.equal(sse.status(), 401);
  });
});
