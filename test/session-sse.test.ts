/**
 * Session SSE live-update tests.
 *
 * Verifies that creating, deleting, and status-changing a session emits the
 * correct SSE events on the project channel, and that a subscriber on a
 * different project receives none of those events.
 *
 * Acceptance criteria:
 *   ✓ POST /api/projects/:id/workflows emits workflow.created with workflowId
 *   ✓ DELETE /api/projects/:id/workflows/:wid emits workflow.deleted with workflowId
 *   ✓ POST /api/projects/:id/workflows/:wid/cancel emits workflow.updated with status='paused'
 *   ✓ A subscriber on a different project receives none of the above
 */

import http from 'node:http';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

// ── SSE helper ────────────────────────────────────────────────────────────────

/**
 * Open an SSE connection using the low-level http module.
 *
 * Returns:
 *   ready  — resolves once the server sends ": connected"
 *   events — accumulates parsed event payloads
 *   close  — destroys the socket (ECONNRESET is swallowed)
 */
function openSseHttp(
  baseUrl: string,
  path: string,
  cookie: string,
): { ready: Promise<void>; events: object[]; close: () => void } {
  const events: object[] = [];
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  let readyDone = false;

  const { hostname, port } = new URL(baseUrl);
  const req = http.request(
    {
      hostname,
      port: port ? parseInt(port, 10) : 80,
      path,
      method: 'GET',
      headers: { Cookie: cookie, 'X-Requested-With': 'agent-portal' },
    },
    (res) => {
      let buf = '';
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          if (part.trimStart().startsWith(':')) {
            if (!readyDone) { readyDone = true; resolveReady(); }
            continue;
          }
          for (const line of part.split('\n')) {
            if (line.startsWith('data: ')) {
              try { events.push(JSON.parse(line.slice(6))); } catch { /* ignore */ }
            }
          }
        }
      });
    },
  );

  req.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'ECONNRESET' && !readyDone) rejectReady(err as Error);
  });

  req.setTimeout(6000, () => {
    if (!readyDone) rejectReady(new Error('SSE connection timed out'));
    req.destroy();
  });

  req.end();

  return { events, ready, close: () => req.destroy() };
}

// ── Setup helpers ─────────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string, email: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email, name: 'Admin', password: 'password1234', provider: 'demo' },
  });
  if (r.cookie) return r.cookie;
  const login = await fetchJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password: 'password1234' },
  });
  return login.cookie ?? '';
}

async function createProject(baseUrl: string, cookie: string, name: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name },
    cookie,
  });
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

async function createWorkflow(
  baseUrl: string,
  cookie: string,
  projectId: string,
  goal = 'SSE test session',
): Promise<string> {
  const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
    method: 'POST',
    body: { goal, engine: 'demo' },
    cookie,
  });
  assert.equal(r.status, 201, `createWorkflow failed: ${JSON.stringify(r.body)}`);
  return ((r.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
}

async function deleteWorkflow(
  baseUrl: string,
  cookie: string,
  projectId: string,
  workflowId: string,
): Promise<void> {
  const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${workflowId}`, {
    method: 'DELETE',
    cookie,
  });
  assert.equal(r.status, 200, `deleteWorkflow failed: ${JSON.stringify(r.body)}`);
}

async function cancelWorkflow(
  baseUrl: string,
  cookie: string,
  projectId: string,
  workflowId: string,
): Promise<void> {
  const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${workflowId}/cancel`, {
    method: 'POST',
    body: {},
    cookie,
  });
  assert.equal(r.status, 200, `cancelWorkflow failed: ${JSON.stringify(r.body)}`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Session SSE live-updates', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let otherProjectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'sse-admin@example.com');
    projectId = await createProject(baseUrl, adminCookie, 'SSE Test Project');
    otherProjectId = await createProject(baseUrl, adminCookie, 'Other Project');
  });

  after(async () => cleanup());

  it('creating a session emits workflow.created with the new workflowId', async () => {
    const sse = openSseHttp(baseUrl, `/api/projects/${projectId}/events`, adminCookie);
    await sse.ready;

    const wfId = await createWorkflow(baseUrl, adminCookie, projectId);

    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    sse.close();

    const created = (sse.events as Array<Record<string, unknown>>).filter(
      (e) => e.type === 'workflow.created',
    );
    assert.ok(
      created.length >= 1,
      `Expected at least 1 workflow.created event; got: ${JSON.stringify(sse.events)}`,
    );
    assert.equal(
      created[0].workflowId,
      wfId,
      `workflow.created workflowId should be ${wfId}`,
    );

    // Cleanup
    await deleteWorkflow(baseUrl, adminCookie, projectId, wfId);
  });

  it('deleting a session emits workflow.deleted with the workflowId', async () => {
    const wfId = await createWorkflow(baseUrl, adminCookie, projectId);

    const sse = openSseHttp(baseUrl, `/api/projects/${projectId}/events`, adminCookie);
    await sse.ready;

    await deleteWorkflow(baseUrl, adminCookie, projectId, wfId);

    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    sse.close();

    const deleted = (sse.events as Array<Record<string, unknown>>).filter(
      (e) => e.type === 'workflow.deleted',
    );
    assert.ok(
      deleted.length >= 1,
      `Expected at least 1 workflow.deleted event; got: ${JSON.stringify(sse.events)}`,
    );
    assert.equal(
      deleted[0].workflowId,
      wfId,
      `workflow.deleted workflowId should be ${wfId}`,
    );
  });

  it('cancelling a session emits workflow.updated with status=paused', async () => {
    const wfId = await createWorkflow(baseUrl, adminCookie, projectId);

    const sse = openSseHttp(baseUrl, `/api/projects/${projectId}/events`, adminCookie);
    await sse.ready;

    await cancelWorkflow(baseUrl, adminCookie, projectId, wfId);

    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    sse.close();

    const updated = (sse.events as Array<Record<string, unknown>>).filter(
      (e) => e.type === 'workflow.updated',
    );
    assert.ok(
      updated.length >= 1,
      `Expected at least 1 workflow.updated event; got: ${JSON.stringify(sse.events)}`,
    );
    const cancelEvent = updated.find((e) => e.workflowId === wfId);
    assert.ok(cancelEvent, `workflow.updated for ${wfId} not found in: ${JSON.stringify(updated)}`);
    assert.equal(cancelEvent.status, 'paused', `Expected status=paused, got: ${cancelEvent.status}`);

    // Cleanup
    await deleteWorkflow(baseUrl, adminCookie, projectId, wfId);
  });

  it('subscriber on a different project receives none of the session events', async () => {
    // Subscribe to the OTHER project's channel
    const sse = openSseHttp(baseUrl, `/api/projects/${otherProjectId}/events`, adminCookie);
    await sse.ready;

    // Perform mutations on projectId (not otherProjectId)
    const wfId = await createWorkflow(baseUrl, adminCookie, projectId);
    await cancelWorkflow(baseUrl, adminCookie, projectId, wfId);
    await deleteWorkflow(baseUrl, adminCookie, projectId, wfId);

    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    sse.close();

    const sessionEvents = (sse.events as Array<Record<string, unknown>>).filter(
      (e) =>
        e.type === 'workflow.created' ||
        e.type === 'workflow.deleted' ||
        e.type === 'workflow.updated',
    );
    assert.equal(
      sessionEvents.length,
      0,
      `Expected 0 session events on other project, got: ${JSON.stringify(sse.events)}`,
    );
  });
});
