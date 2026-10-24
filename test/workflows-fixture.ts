import { bootServer, Client, type TestServer } from './client.ts';

export interface WorkflowFixture {
  srv: TestServer;
  admin: Client;
  viewer: Client;
  outsider: Client;
  pid: string;
  recoverWorkflows: typeof import('../server/workflows.ts').recoverWorkflows;
  exec: typeof import('../server/db.ts').run;
}

/** Boots a server with an admin, a viewer (read-only member) and an outsider, and one project to run sessions in. */
export async function bootWorkflowFixture(): Promise<WorkflowFixture> {
  const srv = await bootServer();
  const { recoverWorkflows } = await import('../server/workflows.ts');
  const { run: exec } = await import('../server/db.ts');
  const admin = new Client(srv.base);
  const viewer = new Client(srv.base);
  const outsider = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'a@example.com', name: 'Ann', password: 'a-long-password-1' });
  await admin.post('/api/users', { email: 'v@example.com', name: 'Vic', password: 'a-long-password-2' });
  await admin.post('/api/users', { email: 'o@example.com', name: 'Otto', password: 'a-long-password-3' });
  await viewer.post('/api/auth/login', { email: 'v@example.com', password: 'a-long-password-2' });
  await outsider.post('/api/auth/login', { email: 'o@example.com', password: 'a-long-password-3' });
  const pid = (await admin.post('/api/projects', { name: 'Auto', description: 'd' })).project.id;
  await admin.post(`/api/projects/${pid}/members`, { email: 'v@example.com', access: 'viewer', role: 'Reader' });
  return { srv, admin, viewer, outsider, pid, recoverWorkflows, exec };
}

/** Waits until a session has stopped driving and reached one of the wanted statuses. */
export async function settleSession(admin: Client, id: string, wanted: string[] = ['done', 'blocked', 'failed', 'paused', 'stopped']) {
  const end = Date.now() + 40_000;
  for (;;) {
    const d = await admin.get(`/api/workflows/${id}`);
    if (wanted.includes(d.workflow.status) && !d.driving) return d;
    if (Date.now() > end) throw new Error(`session ${id} stayed ${d.workflow.status}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
