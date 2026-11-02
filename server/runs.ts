/**
 * Run detail routes.
 *
 * Routes:
 *   GET /api/runs/:id           — run details
 *   GET /api/runs/:id/events    — SSE stream of run events (replay past + live new)
 *   GET /api/runs/:id/files     — list files changed in this run's work dir
 *   GET /api/runs/:id/file/preview — preview a file from the work dir
 */

import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one } from './db.ts';
import type { Row } from './db.ts';
import { config } from './config.ts';
import { subscribeRun } from './events.ts';
import type { RunEventRow } from './events.ts';
import { getSessionsRepository } from './repositories/sessions.ts';
import type { EventRecord, RunRecord } from './repositories/sessions.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function runView(r: Row | RunRecord) {
  return {
    id: r.id,
    workflow_id: r.workflow_id,
    status: r.status,
    started_at: r.started_at ?? null,
    finished_at: r.finished_at ?? null,
    cost_usd: r.cost_usd ?? 0,
    input_tokens: r.input_tokens ?? 0,
    output_tokens: r.output_tokens ?? 0,
    stop_reason: (r as RunRecord).stop_reason ?? null,
    time_limit_at: (r as RunRecord).time_limit_at ?? null,
    created_at: r.created_at,
  };
}

function eventView(e: EventRecord | Row) {
  let payload: unknown = {};
  try {
    payload = JSON.parse(typeof e.payload === 'string' ? e.payload : String(e.payload ?? '{}'));
  } catch {
    // keep empty object
  }
  return {
    id: typeof e.id === 'number' ? e.id : Number(e.id),
    run_id: typeof e.run_id === 'string' ? e.run_id : String(e.run_id),
    type: typeof e.type === 'string' ? e.type : String(e.type ?? ''),
    payload,
    created_at: typeof e.created_at === 'string' ? e.created_at : String(e.created_at),
  };
}

/**
 * Check that the authenticated user has access to the run (via its workflow's project).
 * Returns the workflow row or null if access is denied (response already sent).
 */
function requireRunAccess(req: PortalRequest, res: PortalResponse, runId: string): Row | null {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const r = one<Row>('SELECT * FROM p6_runs WHERE id = ?', runId);
  if (!r) {
    sendJson(res, 404, { error: 'Run not found' });
    return null;
  }
  const workflow = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', r.workflow_id as string);
  if (!workflow) {
    sendJson(res, 404, { error: 'Workflow not found' });
    return null;
  }
  if (req.user.is_admin) return workflow;
  if (!workflow.project_id) return workflow;
  const member = one<Row>(
    'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
    workflow.project_id as string,
    req.user.id as string,
  );
  if (!member) {
    sendJson(res, 403, { error: 'Not a project member' });
    return null;
  }
  return workflow;
}

// ── File helpers ───────────────────────────────────────────────────────────────

function resolveWorkDir(workflow: Row, runId: string): string | null {
  if (!workflow.project_id) return null;
  const project = one<Row>('SELECT slug FROM projects WHERE id = ?', workflow.project_id as string);
  if (!project) return null;
  return path.join(config.dataDir, 'projects', String(project.slug), 'work', runId);
}

function listWorkDirFiles(workDir: string, base = ''): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workDir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // Skip repos and .git
      if (entry.name === 'repos' || entry.name === '.git' || entry.name === 'node_modules') continue;
      results.push(...listWorkDirFiles(path.join(workDir, entry.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}

const TEXT_EXTS = new Set(['.md', '.txt', '.ts', '.js', '.mjs', '.json', '.yaml', '.yml', '.sh', '.py', '.rb', '.go', '.rs', '.html', '.css', '.xml', '.csv', '.env', '.toml']);

function filePreviewType(ext: string): 'text' | 'binary' | 'image' {
  if (TEXT_EXTS.has(ext)) return 'text';
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)) return 'image';
  return 'binary';
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerRunRoutes(): void {

  // GET /api/runs/:id
  router.get('/api/runs/:id', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const workflow = requireRunAccess(req, res, req.params.id);
    if (!workflow) return;
    const repo = getSessionsRepository();
    const r = await repo.getRunById(req.params.id);
    if (!r) { sendJson(res, 404, { error: 'Run not found' }); return; }
    sendJson(res, 200, { run: runView(r) });
  });

  // GET /api/inputs/:id — poll input status (used by AgentCore containers and tests)
  // S1-TODO(sessions): This route uses db.ts directly for the input lookup because
  // the DynamoDB implementation of getInputById requires knowing the run_id.
  // Full conversion is deferred until the GSI-InputId is added to portal-runs.
  router.get('/api/inputs/:id', (req: PortalRequest, res: PortalResponse): void => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    const row = one<Row>('SELECT * FROM p6_inputs WHERE id = ?', req.params.id);
    if (!row) { sendJson(res, 404, { error: 'Input not found' }); return; }
    // Access check: must be a member of the input's project (or admin)
    if (!req.user.is_admin && row.project_id) {
      const member = one<Row>(
        'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
        row.project_id as string,
        req.user.id as string,
      );
      if (!member) { sendJson(res, 403, { error: 'Not a project member' }); return; }
    }
    let payload: unknown = {};
    let response: unknown = null;
    try { payload = JSON.parse(row.payload as string); } catch { /* keep empty */ }
    try { if (row.response) response = JSON.parse(row.response as string); } catch { /* keep null */ }
    sendJson(res, 200, {
      input: {
        id: row.id,
        run_id: row.run_id,
        type: row.type ?? 'approval',
        status: row.status ?? 'pending',
        tool_name: row.tool_name,
        payload,
        response,
        expires_at: row.expires_at ?? null,
        answered_at: row.answered_at ?? null,
        created_at: row.created_at,
      },
    });
  });

  // GET /api/runs/:id/events (SSE stream)
  router.sse('/api/runs/:id/events', (req: PortalRequest, res: PortalResponse): void => {
    // Same project-membership check as the other run routes.
    const workflow = requireRunAccess(req, res, req.params.id);
    if (!workflow) return;
    const runId = req.params.id;

    // Listen before reading history so an event stored in between isn't lost.
    // Events seen in the replay are skipped by id.
    const queued: RunEventRow[] = [];
    let replayed = false;
    let lastId = 0;
    const send = (ev: { id: unknown }): void => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ type: 'event', event: ev })}\n\n`);
    };
    const unsubscribeRun = subscribeRun(runId, (ev) => {
      if (!replayed) { queued.push(ev); return; }
      if (ev.id <= lastId) return;
      lastId = ev.id;
      send(ev);
    });

    // Write SSE headers first
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    // Replay historical events from repository (async, but headers already sent)
    const repo = getSessionsRepository();
    repo.listRunEvents(runId).then((past) => {
      for (const e of past) {
        lastId = Math.max(lastId, e.id);
        if (!res.writableEnded) send(eventView(e));
      }
      replayed = true;
      for (const ev of queued) {
        if (ev.id > lastId) { lastId = ev.id; send(ev); }
      }
    }).catch(() => {
      // If replay fails, at least the live stream continues
      replayed = true;
      for (const ev of queued) {
        if (ev.id > lastId) { lastId = ev.id; send(ev); }
      }
    });

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 25_000);
    heartbeat.unref();
    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribeRun();
    });
  });

  // GET /api/runs/:id/files
  router.get('/api/runs/:id/files', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const workflow = requireRunAccess(req, res, req.params.id);
    if (!workflow) return;
    const workDir = resolveWorkDir(workflow, req.params.id);
    if (!workDir || !fs.existsSync(workDir)) {
      sendJson(res, 200, { files: [] });
      return;
    }
    const files = listWorkDirFiles(workDir);
    sendJson(res, 200, { files, workDir });
  });

  // GET /api/runs/:id/file/preview
  router.get('/api/runs/:id/file/preview', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const workflow = requireRunAccess(req, res, req.params.id);
    if (!workflow) return;

    const filePath = req.query.get('path') ?? '';
    if (!filePath) {
      sendJson(res, 400, { error: 'path query parameter required' });
      return;
    }

    const workDir = resolveWorkDir(workflow, req.params.id);
    if (!workDir) {
      sendJson(res, 404, { error: 'Work directory not found' });
      return;
    }

    // Resolve and verify the path is inside workDir (path traversal guard)
    const resolved = path.resolve(workDir, filePath);
    if (!resolved.startsWith(path.resolve(workDir))) {
      sendJson(res, 403, { error: 'Path is outside the run work directory' });
      return;
    }

    if (!fs.existsSync(resolved)) {
      sendJson(res, 404, { error: 'File not found' });
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const previewType = filePreviewType(ext);

    if (previewType === 'text') {
      const content = fs.readFileSync(resolved, 'utf8');
      sendJson(res, 200, { type: 'text', content, ext });
    } else if (previewType === 'image') {
      const buffer = fs.readFileSync(resolved);
      const base64 = buffer.toString('base64');
      const mimeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
      };
      sendJson(res, 200, {
        type: 'image',
        url: `data:${mimeMap[ext] ?? 'image/octet-stream'};base64,${base64}`,
        ext,
      });
    } else {
      sendJson(res, 200, { type: 'binary', ext, size: fs.statSync(resolved).size });
    }
  });
}
