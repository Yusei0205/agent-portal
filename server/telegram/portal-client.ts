/**
 * The bridge talks to the portal through its own HTTP API with an API token, the same way any
 * script would. Every permission check (project membership, the write scope, "API tokens cannot
 * approve tool calls") therefore applies to Telegram too.
 */

export interface PortalProject { id: string; name: string; archived?: number | boolean }
export interface PortalWorkflow {
  id: string;
  project_id: string;
  title: string;
  goal: string;
  status: string;
  stop_reason: string;
  engine: string;
  model?: string;
  repo_ids?: string[];
  updated_at: string;
}
export interface PortalRun { id: string; status: string }
export interface TranscriptEvent { src: string; kind: string; payload: unknown; run_id: string | null; created_at: string }
export interface InboxItem {
  id: string;
  type: string;
  project_name: string | null;
  workflow_id: string | null;
  workflow_goal: string | null;
  payload: Record<string, unknown>;
}

export class PortalError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface PortalClient {
  listProjects(): Promise<PortalProject[]>;
  listWorkflows(projectId: string, limit?: number): Promise<PortalWorkflow[]>;
  getWorkflow(projectId: string, workflowId: string): Promise<{ workflow: PortalWorkflow; latestRun: PortalRun | null }>;
  createWorkflow(projectId: string, body: Record<string, unknown>): Promise<PortalWorkflow>;
  start(projectId: string, workflowId: string): Promise<void>;
  message(projectId: string, workflowId: string, text: string): Promise<{ kind: string; resumed: boolean; handled?: boolean }>;
  cancel(projectId: string, workflowId: string): Promise<void>;
  transcript(projectId: string, workflowId: string, limit?: number): Promise<TranscriptEvent[]>;
  inbox(): Promise<InboxItem[]>;
}

export function createPortalClient(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): PortalClient {
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        // The portal's CSRF guard: state-changing calls must carry this header.
        'x-requested-with': 'agent-portal',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data: Record<string, unknown> = {};
    try { data = await res.json() as Record<string, unknown>; } catch { /* empty body */ }
    if (!res.ok) throw new PortalError(String(data.error ?? `The portal answered HTTP ${res.status}`), res.status);
    return data as T;
  }
  const p = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
  const w = (pid: string, wid: string) => `${p(pid)}/workflows/${encodeURIComponent(wid)}`;

  return {
    listProjects: async () => (await req<{ projects: PortalProject[] }>('GET', '/api/projects')).projects ?? [],
    listWorkflows: async (pid, limit = 10) =>
      (await req<{ workflows: PortalWorkflow[] }>('GET', `${p(pid)}/workflows?limit=${limit}`)).workflows ?? [],
    getWorkflow: async (pid, wid) => {
      const r = await req<{ workflow: PortalWorkflow; latestRun?: PortalRun | null }>('GET', w(pid, wid));
      return { workflow: r.workflow, latestRun: r.latestRun ?? null };
    },
    createWorkflow: async (pid, body) => (await req<{ workflow: PortalWorkflow }>('POST', `${p(pid)}/workflows`, body)).workflow,
    start: async (pid, wid) => { await req('POST', `${w(pid, wid)}/start`, {}); },
    message: (pid, wid, text) => req('POST', `${w(pid, wid)}/message`, { message: text }),
    cancel: async (pid, wid) => { await req('POST', `${w(pid, wid)}/cancel`, { source: 'telegram' }); },
    transcript: async (pid, wid, limit = 60) =>
      (await req<{ events: TranscriptEvent[] }>('GET', `${w(pid, wid)}/transcript?limit=${limit}`)).events ?? [],
    inbox: async () => (await req<{ items: InboxItem[] }>('GET', '/api/inbox?limit=20')).items ?? [],
  };
}
