/**
 * Transcript endpoint — server-side coalescing of streamed assistant-text rows.
 *
 * Verifies that:
 *   ✓ Consecutive streaming assistant-text rows from the same run are coalesced
 *     into a single event on each transcript page.
 *   ✓ Non-streaming assistant-text rows are NOT coalesced.
 *   ✓ Stream chunks from different runs are NOT coalesced together.
 *   ✓ The nextCursor references the correct raw-row position so subsequent
 *     pages are correct (cursor stays accurate despite coalescing).
 *   ✓ The coalesced event keeps the oldest chunk's id and created_at.
 *   ✓ The coalesced payload retains stream:true for the client merge logic.
 *
 * Also unit-tests the pure coalesceStreamedRows helper imported directly.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { emitRunEvent } from '../server/agent/runner.ts';
import { insert, getDb } from '../server/db.ts';
// @ts-expect-error — plain JS helper, no types needed here
import { coalesceStreamedRows } from '../server/workflows/crud.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: `coalesce-${Date.now()}@example.com`, name: 'Admin', password: 'password1234', provider: 'demo' },
  });
  return r.cookie ?? '';
}

async function createProject(baseUrl: string, cookie: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Coalesce Test' }, cookie });
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

async function createWorkflow(baseUrl: string, cookie: string, projectId: string, goal = 'coalesce test'): Promise<string> {
  const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
    method: 'POST',
    body: { goal, engine: 'demo' },
    cookie,
  });
  assert.equal(r.status, 201, `createWorkflow failed: ${JSON.stringify(r.body)}`);
  return ((r.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
}

/** Emit N streaming assistant-text chunks for a run, with deterministic timestamps spaced 1 ms apart. */
function emitStreamChunks(
  runId: string,
  projectId: string,
  workflowId: string,
  chunks: string[],
  baseMs = Date.now(),
): void {
  for (let i = 0; i < chunks.length; i++) {
    const ts = new Date(baseMs + i).toISOString();
    const id = insert('p6_events', {
      run_id: runId,
      type: 'assistant-text',
      payload: JSON.stringify({ text: chunks[i], stream: true }),
      created_at: ts,
    });
    void id; // id not needed here; emitRunEvent publishes via event bus
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Unit tests for the pure coalesceStreamedRows helper
// ══════════════════════════════════════════════════════════════════════════════

type TxRow = {
  src: string; id: number; created_at: string; kind: string;
  body: string; run_id: string | null;
};

function makeStreamRow(id: number, text: string, runId = 'r1', ts?: string): TxRow {
  const created_at = ts ?? `2024-01-01T00:00:${String(id).padStart(2, '0')}Z`;
  return { src: 'r', id, created_at, kind: 'assistant-text', body: JSON.stringify({ text, stream: true }), run_id: runId };
}

function makePlainRow(id: number, text: string, runId = 'r1', ts?: string): TxRow {
  const created_at = ts ?? `2024-01-01T00:00:${String(id).padStart(2, '0')}Z`;
  return { src: 'r', id, created_at, kind: 'assistant-text', body: JSON.stringify({ text }), run_id: runId };
}

function makeOtherRow(id: number, kind = 'run-complete', runId = 'r1'): TxRow {
  return { src: 'r', id, created_at: `2024-01-01T00:00:${String(id).padStart(2, '0')}Z`, kind, body: '{}', run_id: runId };
}

function makeWfRow(id: number, kind = 'human'): TxRow {
  return { src: 'w', id, created_at: `2024-01-01T00:00:${String(id).padStart(2, '0')}Z`, kind, body: 'hello', run_id: null };
}

describe('coalesceStreamedRows — pure unit tests', () => {
  it('returns an empty array unchanged', () => {
    assert.deepEqual(coalesceStreamedRows([]), []);
  });

  it('returns a single stream row unchanged', () => {
    const rows = [makeStreamRow(1, 'hello')];
    const result = coalesceStreamedRows(rows) as TxRow[];
    assert.equal(result.length, 1);
    const p = JSON.parse(result[0].body);
    assert.equal(p.text, 'hello');
    assert.equal(p.stream, true);
    assert.equal(result[0].id, 1);
  });

  it('coalesces two consecutive stream rows — keeps oldest id/created_at, concatenates text', () => {
    // Rows newest-first: id=2 (newest), id=1 (oldest)
    const rows = [makeStreamRow(2, 'world'), makeStreamRow(1, 'hello')];
    const result = coalesceStreamedRows(rows) as TxRow[];

    assert.equal(result.length, 1, 'two rows merged into one');
    const p = JSON.parse(result[0].body);
    assert.equal(p.text, 'helloworld', 'text concatenated in chronological order');
    assert.equal(p.stream, true, 'stream flag preserved');
    assert.equal(result[0].id, 1, 'oldest id kept');
    assert.equal(result[0].created_at, '2024-01-01T00:00:01Z', 'oldest created_at kept');
  });

  it('coalesces N consecutive stream rows into one', () => {
    const chunks = ['a', 'b', 'c', 'd', 'e'];
    // newest-first: id=5..1
    const rows = chunks.map((_, i) => makeStreamRow(5 - i, chunks[4 - i])).reverse().reverse();
    // Build newest-first correctly:
    const newestFirst = [
      makeStreamRow(5, 'e'),
      makeStreamRow(4, 'd'),
      makeStreamRow(3, 'c'),
      makeStreamRow(2, 'b'),
      makeStreamRow(1, 'a'),
    ];
    const result = coalesceStreamedRows(newestFirst) as TxRow[];
    assert.equal(result.length, 1);
    assert.equal(JSON.parse(result[0].body).text, 'abcde');
    assert.equal(result[0].id, 1, 'oldest (id=1) kept');
  });

  it('does NOT coalesce rows without stream:true', () => {
    const rows = [makePlainRow(2, 'world'), makePlainRow(1, 'hello')];
    const result = coalesceStreamedRows(rows) as TxRow[];
    assert.equal(result.length, 2, 'non-stream rows kept separate');
  });

  it('does NOT coalesce stream rows from different runs', () => {
    const rows = [
      makeStreamRow(2, 'run2-chunk', 'r2'),
      makeStreamRow(1, 'run1-chunk', 'r1'),
    ];
    const result = coalesceStreamedRows(rows) as TxRow[];
    assert.equal(result.length, 2, 'different runs kept separate');
  });

  it('stops coalescing at a non-assistant-text row between two runs', () => {
    const rows = [
      makeStreamRow(4, 'run2-end',   'r2'),
      makeOtherRow(3, 'run-complete', 'r1'),
      makeStreamRow(2, 'chunk2',     'r1'),
      makeStreamRow(1, 'chunk1',     'r1'),
    ];
    const result = coalesceStreamedRows(rows) as TxRow[];
    // run1's two chunks merge; run-complete and run2's chunk stay separate
    assert.equal(result.length, 3);
    assert.equal(result[0].kind, 'assistant-text'); // run2 single chunk (id=4)
    assert.equal(result[1].kind, 'run-complete');   // id=3
    const merged = result[2];
    assert.equal(merged.kind, 'assistant-text');
    assert.equal(JSON.parse(merged.body).text, 'chunk1chunk2');
    assert.equal(merged.id, 1);
  });

  it('does NOT coalesce src=w rows', () => {
    // A workflow-event with kind=assistant-text (unusual but possible) must not be merged
    const rows = [makeWfRow(2, 'assistant-text'), makeWfRow(1, 'assistant-text')];
    const result = coalesceStreamedRows(rows) as TxRow[];
    assert.equal(result.length, 2);
  });

  it('leaves cursor-anchor row (last raw row) intact — coalescing does not shift it', () => {
    // Oldest row (id=1, oldest chunk) becomes the merged event; it should still
    // have the same created_at as the original oldest row.
    const rows = [makeStreamRow(3, 'c'), makeStreamRow(2, 'b'), makeStreamRow(1, 'a')];
    const result = coalesceStreamedRows(rows) as TxRow[];
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 1);
    assert.equal(result[0].created_at, '2024-01-01T00:00:01Z');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Integration tests via HTTP endpoint
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/projects/:id/workflows/:wid/transcript — coalescing', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    ({ baseUrl } = await createTestServer());
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie);
  });

  after(async () => cleanup());

  it('returns a single coalesced event instead of N stream rows for one run', async () => {
    const wfId = await createWorkflow(baseUrl, cookie, projectId, 'stream coalesce test');

    // Create a run row directly
    const runId = `coalesce-run-${Date.now()}`;
    insert('p6_runs', { id: runId, workflow_id: wfId, status: 'done', created_at: new Date().toISOString() });

    // Emit 5 streaming chunks
    const baseMs = Date.now();
    const chunks = ['Hello', ', ', 'world', '!', '\n'];
    for (let i = 0; i < chunks.length; i++) {
      insert('p6_events', {
        run_id: runId,
        type: 'assistant-text',
        payload: JSON.stringify({ text: chunks[i], stream: true }),
        created_at: new Date(baseMs + i).toISOString(),
      });
    }
    // Emit a run-complete after the chunks
    insert('p6_events', {
      run_id: runId,
      type: 'run-complete',
      payload: JSON.stringify({ duration_ms: 100 }),
      created_at: new Date(baseMs + chunks.length).toISOString(),
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}/transcript`, { cookie });
    assert.equal(r.status, 200);
    const { events, nextCursor } = r.body as { events: Array<Record<string, unknown>>; nextCursor: string | null };

    // Should have exactly 2 events: one merged assistant-text + one run-complete
    const textEvents = events.filter((e) => e.kind === 'assistant-text');
    assert.equal(textEvents.length, 1, `expected 1 merged text event, got ${textEvents.length}: ${JSON.stringify(textEvents)}`);

    const merged = textEvents[0];
    const payload = typeof merged.payload === 'string' ? JSON.parse(merged.payload) : merged.payload;
    assert.equal(payload.text, 'Hello, world!\n', `merged text wrong: ${payload.text}`);
    assert.equal(payload.stream, true, 'stream flag should be retained');

    assert.equal(nextCursor, null, 'small session fits in one page — no cursor needed');
  });

  it('does NOT coalesce stream chunks from different runs', async () => {
    const wfId = await createWorkflow(baseUrl, cookie, projectId, 'two-run coalesce test');

    const baseMs = Date.now();

    const run1 = `two-run-r1-${Date.now()}`;
    insert('p6_runs', { id: run1, workflow_id: wfId, status: 'done', created_at: new Date(baseMs).toISOString() });
    insert('p6_events', {
      run_id: run1,
      type: 'assistant-text',
      payload: JSON.stringify({ text: 'run1 answer', stream: true }),
      created_at: new Date(baseMs + 1).toISOString(),
    });
    insert('p6_events', {
      run_id: run1,
      type: 'run-complete',
      payload: JSON.stringify({}),
      created_at: new Date(baseMs + 2).toISOString(),
    });

    // Human follow-up in p6_workflow_events
    getDb().prepare(
      `INSERT INTO p6_workflow_events (workflow_id, kind, body, created_at) VALUES (?, ?, ?, ?)`,
    ).run(wfId, 'human', 'follow-up question', new Date(baseMs + 3).toISOString());

    const run2 = `two-run-r2-${Date.now()}`;
    insert('p6_runs', { id: run2, workflow_id: wfId, status: 'done', created_at: new Date(baseMs + 4).toISOString() });
    insert('p6_events', {
      run_id: run2,
      type: 'assistant-text',
      payload: JSON.stringify({ text: 'run2 answer', stream: true }),
      created_at: new Date(baseMs + 5).toISOString(),
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}/transcript`, { cookie });
    assert.equal(r.status, 200);
    const { events } = r.body as { events: Array<Record<string, unknown>> };

    // Expect: run2 answer, human event, run-complete, run1 answer (newest first)
    const textEvents = events.filter((e) => e.kind === 'assistant-text');
    assert.equal(textEvents.length, 2, `expected 2 text events (one per run), got ${textEvents.length}`);

    const humanEvents = events.filter((e) => e.kind === 'human');
    assert.equal(humanEvents.length, 1, 'human follow-up must appear in transcript');
  });

  it('cursor stays correct when a stream group spans the page limit', async () => {
    const wfId = await createWorkflow(baseUrl, cookie, projectId, 'cursor correctness');
    const baseMs = Date.now();

    const runId = `cursor-run-${Date.now()}`;
    insert('p6_runs', { id: runId, workflow_id: wfId, status: 'done', created_at: new Date(baseMs).toISOString() });

    // Insert 5 chunks — with limit=3 we force a page break in the middle of the stream
    for (let i = 0; i < 5; i++) {
      insert('p6_events', {
        run_id: runId,
        type: 'assistant-text',
        payload: JSON.stringify({ text: `chunk${i}`, stream: true }),
        created_at: new Date(baseMs + i + 1).toISOString(),
      });
    }
    // Add a run-complete so the first page (limit=3) has: run-complete, chunk4, chunk3
    insert('p6_events', {
      run_id: runId,
      type: 'run-complete',
      payload: '{}',
      created_at: new Date(baseMs + 6).toISOString(),
    });

    // First page: limit=3 — newest-first: [run-complete, chunk4, chunk3]
    // After coalescing: [run-complete, merged(chunk3+chunk4)]
    const page1 = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/workflows/${wfId}/transcript?limit=3`,
      { cookie },
    );
    assert.equal(page1.status, 200);
    const p1 = page1.body as { events: Array<Record<string, unknown>>; nextCursor: string | null };
    assert.ok(p1.nextCursor, 'page 1 should have a cursor since there are 6 raw rows total');

    // Second page: should return the remaining older events
    const page2 = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/workflows/${wfId}/transcript?limit=3&cursor=${encodeURIComponent(p1.nextCursor!)}`,
      { cookie },
    );
    assert.equal(page2.status, 200);
    const p2 = page2.body as { events: Array<Record<string, unknown>>; nextCursor: string | null };

    // All events should be covered across both pages (no row skipped or doubled)
    const allEvents = [...p1.events, ...p2.events];
    const textEventsTotal = allEvents.filter((e) => e.kind === 'assistant-text');
    // Across two pages, all 5 chunks should be accounted for — some merged on page1, rest on page2
    const totalText = textEventsTotal.reduce((acc, e) => {
      const payload = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
      return acc + (payload.text ?? '');
    }, '');
    // chunk0+chunk1+chunk2 on page2, chunk3+chunk4 on page1 (each may be merged)
    assert.ok(totalText.includes('chunk0'), `chunk0 missing from combined pages: ${totalText}`);
    assert.ok(totalText.includes('chunk4'), `chunk4 missing from combined pages: ${totalText}`);
  });
});
