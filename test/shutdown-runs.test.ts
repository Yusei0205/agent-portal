/**
 * Graceful shutdown with a standalone run still going (a code review, a Knowledge question, a one-off run): the run
 * is stopped and recorded before the database closes, instead of writing to a closed database and staying "running"
 * until the next start. A file of its own, because shutting down closes this server for good.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { bootServer, Client, waitFor } from './client.ts';

process.env.PORTAL_SDK_MODULE = pathToFileURL(path.join(import.meta.dirname, 'fake-sdk.mjs')).href;

test('shutdown stops a standalone run and records it before closing the database', { timeout: 60_000 }, async () => {
  const srv = await bootServer();
  const c = new Client(srv.base);
  await c.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: 'a-long-password-1' });
  const pid = (await c.post('/api/projects', { name: 'Shutdown' })).project.id;
  await c.put('/api/settings', { provider: { mode: 'anthropic' }, budget: { monthlyUsd: null } });
  await c.post('/api/settings/secrets/anthropic.api_key', { value: 'sk-ant-test-key-0000000000' });
  await c.put(`/api/projects/${pid}/config/file`, { path: '.claude/agents/helper.md', content: '---\nname: helper\ndescription: Helps\n---\nHelp.\n' });

  // A run outside any session, which keeps going until it is stopped.
  const { run } = await c.post(`/api/projects/${pid}/builder/test`, { name: 'helper', type: 'agent', prompt: 'Keep going. [hang]' });
  await waitFor(async () => ((globalThis as any).__fakeSdkCalls ?? []).some((x: any) => x.hanging), 'the run to start');

  const { shutdown } = await import('../server/index.ts');
  await shutdown(srv.server, 500);

  const db = new DatabaseSync(path.join(srv.dataDir, 'portal.db'));
  try {
    const row = db.prepare('SELECT status, error, finished_at FROM agent_runs WHERE id = ?').get(run.id) as any;
    assert.equal(row.status, 'stopped');
    assert.equal(row.error, 'Stopped because the server shut down');
    assert.ok(row.finished_at);
  } finally {
    db.close();
  }
});
