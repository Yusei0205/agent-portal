/**
 * Project memory on AgentCore Memory.
 *
 * What the agents learn about a project (how its tests run, its conventions) is kept across sessions, with a person in the loop:
 *
 *   write    after a session goes quiet, its last exchange is sent to AgentCore Memory as an event (actor = project, session = the
 *            portal session). AgentCore extracts facts (`/project/<id>/facts`) and a summary (`/project/<id>/summaries/<session>`).
 *   review   extracted records start as PENDING. A project owner (or a portal admin) approves or rejects each one, or deletes it.
 *   use      only APPROVED facts are put in front of the agent, at the start of a session (buildProjectMemoryBlock, called from the
 *            conversation recap). Nothing unreviewed ever reaches a prompt: that is why Claude's own auto-memory stays off.
 *
 * Off by default, per project. Secrets are masked before anything is sent. The memory resource is created by the stack; without
 * PORTAL_MEMORY_ID (a local run) everything here is a no-op.
 *
 *   GET    /api/projects/:id/memory                 { available, enabled, canManage, records[] }          (project members)
 *   PUT    /api/projects/:id/memory                 { enabled }                                           (owner / admin)
 *   PUT    /api/projects/:id/memory/records/:rid    { status: approved | rejected | pending }             (owner / admin)
 *   PUT    /api/projects/:id/memory/records/:rid    { text } corrects a fact; it becomes approved            (owner / admin)
 *   POST   /api/projects/:id/memory/records         { text } adds a fact, approved                           (owner / admin)
 *   DELETE /api/projects/:id/memory/records/:rid                                                          (owner / admin)
 */

import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getDb } from './db.ts';
import { getSetting, setSetting } from './settings.ts';
import { getSessionsRepository } from './repositories/sessions.ts';
import { getProjectRepository } from './repositories/projects.ts';
import { groupTurns, loadTranscriptRows } from './agentcore-eval.ts';

const QUIET_MIN = 2;
const MAX_WRITES_PER_PASS = 3;
const MAX_EVENT_TEXT = 3000;
const MAX_BLOCK_CHARS = 2500;
const TOP_K = 8;
export type RecordStatus = 'approved' | 'rejected' | 'pending';

export const memoryId = (): string | null => process.env.PORTAL_MEMORY_ID || null;
const enabledKey = (projectId: string): string => `agentcore.memory.enabled.${projectId}`;
const sentKey = (workflowId: string): string => `agentcore.memory.sent.${workflowId}`;
const statusKey = (recordId: string): string => `agentcore.memory.status.${recordId}`;
const byKey = (recordId: string): string => `agentcore.memory.by.${recordId}`;
const MAX_NOTE_TEXT = 1000;
export const factsNamespace = (projectId: string): string => `/project/${projectId}/facts`;
const projectPrefix = (projectId: string): string => `/project/${projectId}/`;

export const isProjectMemoryOn = (projectId: string): boolean => getSetting(getDb(), enabledKey(projectId)) === '1';
export function recordStatus(recordId: string): RecordStatus {
  const v = getSetting(getDb(), statusKey(recordId));
  return v === 'approved' || v === 'rejected' ? v : 'pending';
}

/** Masks what looks like a secret before text leaves the portal. Best effort: the per-project opt-in is the real control. */
export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key removed]')
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[aws key removed]')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[key removed]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[token removed]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt removed]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [token removed]')
    .replace(/\b((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[removed]');
}

// ── AgentCore client ──────────────────────────────────────────────────────────

type MemClient = { send(cmd: unknown): Promise<any> };
let override: { client: MemClient; cmds: Record<string, new (input: any) => unknown> } | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Tests supply a fake client and command classes (keyed by command name). */
export function _setMemoryClient(o: typeof override): void { override = o; }

async function sdk(): Promise<{ client: MemClient; cmds: Record<string, new (input: any) => unknown> }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (override) return override;
  const m = await import('@aws-sdk/client-bedrock-agentcore');
  return {
    client: new m.BedrockAgentCoreClient({ region: process.env.AWS_REGION || 'ap-southeast-1' }),
    cmds: {
      CreateEvent: m.CreateEventCommand, RetrieveMemoryRecords: m.RetrieveMemoryRecordsCommand, ListMemoryRecords: m.ListMemoryRecordsCommand,
      GetMemoryRecord: m.GetMemoryRecordCommand, DeleteMemoryRecord: m.DeleteMemoryRecordCommand,
      BatchUpdateMemoryRecords: m.BatchUpdateMemoryRecordsCommand, BatchCreateMemoryRecords: m.BatchCreateMemoryRecordsCommand,
    } as unknown as Record<string, new (input: unknown) => unknown>,
  };
}

// ── Write ─────────────────────────────────────────────────────────────────────

/** Sends one exchange as an event. */
export async function writeExchange(projectId: string, workflowId: string, user: string, answer: string): Promise<void> {
  const id = memoryId();
  if (!id) return;
  const { client, cmds } = await sdk();
  const payload = [
    { conversational: { role: 'USER', content: { text: redactSecrets(user).slice(0, MAX_EVENT_TEXT) } } },
    { conversational: { role: 'ASSISTANT', content: { text: redactSecrets(answer).slice(0, MAX_EVENT_TEXT) } } },
  ];
  await client.send(new cmds.CreateEvent({ memoryId: id, actorId: projectId, sessionId: workflowId, eventTimestamp: new Date(), payload }));
}

/** One pass from the per-minute job: send the last exchange of quiet sessions of projects that turned memory on. */
export async function sweepMemoryWrites(nowMs = Date.now()): Promise<number> {
  if (!memoryId()) return 0;
  const idle = await getSessionsRepository().listIdleWorkflows(new Date(nowMs - QUIET_MIN * 60_000).toISOString());
  let sent = 0;
  for (const w of idle) {
    if (sent >= MAX_WRITES_PER_PASS) break;
    const projectId = w.project_id ? String(w.project_id) : '';
    const wid = String(w.id);
    const last = String(w.last_turn_at ?? '');
    if (!projectId || !last || !isProjectMemoryOn(projectId) || getSetting(getDb(), sentKey(wid)) === last) continue;
    try {
      const turns = groupTurns(await loadTranscriptRows(wid));
      const t = turns[turns.length - 1];
      const answer = t?.result ?? t?.text ?? '';
      if (t && t.user && answer) await writeExchange(projectId, wid, t.user, answer);
      // Marked even when there was nothing to send, so an empty session is not looked at every minute.
      await setSetting(getDb(), sentKey(wid), last);
      sent++;
    } catch (e) {
      console.error(`[agentcore-memory] could not write ${wid}:`, e instanceof Error ? e.message : e);
    }
  }
  return sent;
}

// ── Read ──────────────────────────────────────────────────────────────────────

export interface MemoryRecord { id: string; text: string; kind: 'fact' | 'summary' | 'other'; status: RecordStatus; createdAt: string | null; edited?: boolean }

const kindOf = (namespaces: string[] | undefined): MemoryRecord['kind'] => {
  const ns = (namespaces ?? []).join(' ');
  return ns.includes('/facts') ? 'fact' : ns.includes('/summaries') ? 'summary' : 'other';
};

export async function listProjectRecords(projectId: string): Promise<MemoryRecord[]> {
  const id = memoryId();
  if (!id) return [];
  const { client, cmds } = await sdk();
  const out: MemoryRecord[] = [];
  let token: string | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await client.send(new cmds.ListMemoryRecords({ memoryId: id, namespacePath: projectPrefix(projectId), maxResults: 100, nextToken: token }));
    for (const s of r.memoryRecordSummaries ?? []) {
      const text = String(s.content?.text ?? '');
      if (!text) continue;
      out.push({ id: String(s.memoryRecordId), text, kind: kindOf(s.namespaces), status: recordStatus(String(s.memoryRecordId)), createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : null,
        ...(getSetting(getDb(), byKey(String(s.memoryRecordId))) ? { edited: true } : {}) });
    }
    token = r.nextToken;
    if (!token) break;
  }
  return out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/**
 * The approved facts of a project that are relevant to `query`, newest-relevance first, at most 2,500 characters in all; [] when memory
 * is unavailable or off for the project, or AgentCore is slow (3 s) or failing: a caller must never wait on memory or fail because of it.
 * Only facts a project owner approved are returned; pending and rejected ones never reach a prompt.
 */
export async function projectMemoryNotes(projectId: string, query: string): Promise<string[]> {
  const id = memoryId();
  if (!id || !projectId || !isProjectMemoryOn(projectId)) return [];
  try {
    const { client, cmds } = await sdk();
    const q = String(query ?? '').slice(0, 400) || 'project conventions';
    const r = await Promise.race([
      client.send(new cmds.RetrieveMemoryRecords({ memoryId: id, namespace: factsNamespace(projectId), searchCriteria: { searchQuery: q, topK: TOP_K }, maxResults: TOP_K })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    if (!r) return [];
    const notes: string[] = [];
    let size = 0;
    for (const s of r.memoryRecordSummaries ?? []) {
      const text = String(s.content?.text ?? '').trim();
      if (!text || recordStatus(String(s.memoryRecordId)) !== 'approved') continue;
      if (size + text.length > MAX_BLOCK_CHARS) break;
      notes.push(text);
      size += text.length;
    }
    return notes;
  } catch {
    return [];
  }
}

/**
 * The approved notes for a project as a block to put in front of the agent, or '' (memory off, none approved, or AgentCore slow or
 * down: a session must never wait on memory, so a failure just means no block).
 */
export async function buildProjectMemoryBlock(workflowId: string): Promise<string> {
  if (!memoryId()) return '';
  try {
    const w = await getSessionsRepository().getWorkflowById(workflowId);
    const projectId = w?.project_id ? String(w.project_id) : '';
    const notes = await projectMemoryNotes(projectId, String(w?.goal ?? ''));
    return notes.length ? `[Project notes, approved by this project's owners]\n${notes.map((n) => `- ${n}`).join('\n')}\n\n` : '';
  } catch {
    return '';
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** Signed in, the project exists, and the caller belongs to it (or is a portal admin). Kept here, not imported from the dashboard, so the agents' recap can load this file without pulling in the routes. */
async function requireMember(req: PortalRequest, res: PortalResponse, projectId: string): Promise<boolean> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  const repo = getProjectRepository();
  const project = await repo.getProjectById(projectId);
  if (!project || project.archived) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  if (!(await repo.isMember(projectId, req.user.id))) { sendJson(res, 403, { error: 'Access denied' }); return false; }
  return true;
}

async function canManage(req: PortalRequest, projectId: string): Promise<boolean> {
  if (req.user?.is_admin) return true;
  const m = await getProjectRepository().getMember(projectId, req.user!.id);
  return m?.role === 'owner';
}

export function registerAgentCoreMemoryRoutes(): void {
  router.get('/api/projects/:id/memory', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const projectId = String(req.params.id);
    if (!(await requireMember(req, res, projectId))) return;
    const available = memoryId() !== null;
    let records: MemoryRecord[] = [];
    let error: string | null = null;
    if (available) { try { records = await listProjectRecords(projectId); } catch (e) { error = e instanceof Error ? e.message : 'Memory could not be read'; } }
    sendJson(res, 200, { available, enabled: isProjectMemoryOn(projectId), canManage: await canManage(req, projectId), records, error });
  }));

  router.put('/api/projects/:id/memory', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const projectId = String(req.params.id);
    if (!(await requireMember(req, res, projectId))) return;
    if (!(await canManage(req, projectId))) { sendJson(res, 403, { error: 'Only a project owner can change this' }); return; }
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean') { sendJson(res, 400, { error: 'enabled must be true or false' }); return; }
    await setSetting(getDb(), enabledKey(projectId), enabled ? '1' : '0');
    sendJson(res, 200, { enabled });
  }));

  router.post('/api/projects/:id/memory/records', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const projectId = String(req.params.id);
    if (!(await requireMember(req, res, projectId))) return;
    if (!(await canManage(req, projectId))) { sendJson(res, 403, { error: 'Only a project owner can add notes' }); return; }
    if (!memoryId()) { sendJson(res, 400, { error: 'Project memory is not available here' }); return; }
    const text = noteText((req.body as { text?: unknown } | undefined)?.text);
    if (typeof text !== 'string') { sendJson(res, 400, { error: text.error }); return; }
    const { client, cmds } = await sdk();
    const requestIdentifier = `add-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const r = await client.send(new cmds.BatchCreateMemoryRecords({
        memoryId: memoryId()!,
        records: [{ requestIdentifier, namespaces: [factsNamespace(projectId)], content: { text }, timestamp: new Date() }],
      }));
      const ok = (r.successfulRecords ?? [])[0];
      if (!ok?.memoryRecordId) { sendJson(res, 502, { error: 'Memory did not save the note. Try again.' }); return; }
      const id = String(ok.memoryRecordId);
      await setSetting(getDb(), statusKey(id), 'approved');
      await setSetting(getDb(), byKey(id), req.user!.id);
      sendJson(res, 200, { id, text, status: 'approved' });
    } catch {
      sendJson(res, 502, { error: 'Memory did not save the note. Try again.' });
    }
  }));

  router.put('/api/projects/:id/memory/records/:rid', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const projectId = String(req.params.id);
    if (!(await requireMember(req, res, projectId))) return;
    if (!(await canManage(req, projectId))) { sendJson(res, 403, { error: 'Only a project owner can review notes' }); return; }
    const body = (req.body ?? {}) as { status?: unknown; text?: unknown };
    if (body.text !== undefined) {
      if (body.status !== undefined) { sendJson(res, 400, { error: 'Send either text or status, not both' }); return; }
      const text = noteText(body.text);
      if (typeof text !== 'string') { sendJson(res, 400, { error: text.error }); return; }
      const rid = String(req.params.rid);
      const where = await recordNamespaces(rid);
      if (!where.some((n) => n.startsWith(projectPrefix(projectId)))) { sendJson(res, 404, { error: 'Note not found in this project' }); return; }
      if (!where.includes(factsNamespace(projectId))) { sendJson(res, 400, { error: 'Only facts can be edited' }); return; }
      const { client, cmds } = await sdk();
      try {
        const r = await client.send(new cmds.BatchUpdateMemoryRecords({ memoryId: memoryId()!, records: [{ memoryRecordId: rid, content: { text }, timestamp: new Date() }] }));
        if ((r.failedRecords ?? []).length || !(r.successfulRecords ?? []).length) { sendJson(res, 502, { error: 'Memory did not save the change. Try again.' }); return; }
      } catch {
        sendJson(res, 502, { error: 'Memory did not save the change. Try again.' });
        return;
      }
      await setSetting(getDb(), statusKey(rid), 'approved');
      await setSetting(getDb(), byKey(rid), req.user!.id);
      sendJson(res, 200, { id: rid, text, status: 'approved' });
      return;
    }
    const status = body.status;
    if (status !== 'approved' && status !== 'rejected' && status !== 'pending') { sendJson(res, 400, { error: 'status must be approved, rejected or pending' }); return; }
    const rid = String(req.params.rid);
    // The record must belong to this project: an owner of one project must not approve another project's notes.
    if (!(await recordInProject(projectId, rid))) { sendJson(res, 404, { error: 'Note not found in this project' }); return; }
    await setSetting(getDb(), statusKey(rid), status);
    sendJson(res, 200, { id: rid, status });
  }));

  router.delete('/api/projects/:id/memory/records/:rid', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    const projectId = String(req.params.id);
    if (!(await requireMember(req, res, projectId))) return;
    if (!(await canManage(req, projectId))) { sendJson(res, 403, { error: 'Only a project owner can delete notes' }); return; }
    const rid = String(req.params.rid);
    if (!(await recordInProject(projectId, rid))) { sendJson(res, 404, { error: 'Note not found in this project' }); return; }
    const { client, cmds } = await sdk();
    await client.send(new cmds.DeleteMemoryRecord({ memoryId: memoryId()!, memoryRecordId: rid }));
    await setSetting(getDb(), statusKey(rid), '');
    sendJson(res, 200, { id: rid, deleted: true });
  }));
}

async function recordNamespaces(recordId: string): Promise<string[]> {
  if (!memoryId()) return [];
  try {
    const { client, cmds } = await sdk();
    const r = await client.send(new cmds.GetMemoryRecord({ memoryId: memoryId()!, memoryRecordId: recordId }));
    return r.memoryRecord?.namespaces ?? [];
  } catch { return []; }
}

async function recordInProject(projectId: string, recordId: string): Promise<boolean> {
  return (await recordNamespaces(recordId)).some((n) => n.startsWith(projectPrefix(projectId)));
}

/** A note an owner typed: trimmed, 1-1,000 characters, secrets masked. */
function noteText(raw: unknown): string | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'Write the note first' };
  const text = raw.trim();
  if (text.length > MAX_NOTE_TEXT) return { error: `A note can be at most ${MAX_NOTE_TEXT} characters` };
  return redactSecrets(text);
}
