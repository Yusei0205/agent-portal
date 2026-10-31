/**
 * Test projects CRUD + browser capability endpoint.
 *
 * Routes:
 *   GET  /api/tests/capability                           — browser availability (any authenticated user)
 *   GET  /api/projects/:pid/tests                        — list test projects (viewer+)
 *   POST /api/projects/:pid/tests                        — create test project (editor+, write scope)
 *   GET  /api/projects/:pid/tests/:tpid                  — get test project (viewer+)
 *   PUT  /api/projects/:pid/tests/:tpid                  — update test project (editor+, write scope)
 *   DELETE /api/projects/:pid/tests/:tpid                — delete test project (editor+, write scope)
 */

import { router, sendJson, requireAuth } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { all, one, run, insert } from '../db.ts';
import { generateId, now, str, badRequest } from '../util.ts';
import { auditRaw } from '../audit.ts';
import { findBrowser } from '../docimage.ts';
import {
  requireProjectMember,
  requireProjectEditor,
  requireTestProject,
  hasScope,
} from './helpers.ts';
import type { TestProject } from './helpers.ts';

// ── View helpers ───────────────────────────────────────────────────────────────

function tpView(tp: TestProject) {
  return {
    id: tp.id,
    projectId: tp.project_id,
    name: tp.name,
    appUrl: tp.app_url,
    apiBaseUrl: tp.api_base_url ?? null,
    repoIds: safeJson(tp.repo_ids, []),
    vaultDocPaths: safeJson(tp.vault_doc_paths, []),
    viewportWidth: tp.viewport_width,
    viewportHeight: tp.viewport_height,
    timeoutSecs: tp.timeout_secs,
    rulesForAi: tp.rules_for_ai,
    createdBy: tp.created_by ?? null,
    createdAt: tp.created_at,
    updatedAt: tp.updated_at,
  };
}

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(String(s)) as T; } catch { return fallback; }
}

// ── Browser capability check ───────────────────────────────────────────────────

async function checkBrowserCapability(): Promise<{ available: boolean; reason?: string }> {
  // Try playwright (devDep) or playwright-core (optional dep)
  try {
    const pw = await (async () => {
      try { return await import('playwright'); }
      catch { return await import('playwright-core'); }
    })();
    // Try to find a browser executable
    const executablePath = findBrowser() ?? undefined;
    // Quick launch check
    const browser = await pw.chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    }).catch(() => null);
    if (!browser) return { available: false, reason: 'Chromium could not be launched' };
    await browser.close();
    return { available: true };
  } catch {
    const systemBrowser = findBrowser();
    if (systemBrowser) {
      return {
        available: false,
        reason: 'playwright or playwright-core is not installed. Install playwright-core and run playwright install chromium.',
      };
    }
    return {
      available: false,
      reason: 'No headless browser found. Install Chromium or set DOC_BROWSER, then install playwright-core.',
    };
  }
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerTestProjectRoutes(): void {

  // GET /api/tests/capability — browser availability (no project context needed)
  router.get('/api/tests/capability', requireAuth(async (_req: PortalRequest, res: PortalResponse) => {
    const result = await checkBrowserCapability();
    sendJson(res, 200, result);
  }));

  // GET /api/projects/:pid/tests — list test projects
  router.get('/api/projects/:pid/tests', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    if (!requireProjectMember(req, res, req.params.pid)) return;
    const projects = all<TestProject>(
      'SELECT * FROM test_projects WHERE project_id = ? ORDER BY created_at DESC',
      req.params.pid,
    );
    sendJson(res, 200, { testProjects: projects.map(tpView) });
  });

  // POST /api/projects/:pid/tests — create test project
  router.post('/api/projects/:pid/tests', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    if (!requireProjectEditor(req, res, req.params.pid)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 200 }).trim();
    const appUrl = str(body.appUrl, 'appUrl', { max: 2000 }).trim();
    if (!appUrl.startsWith('http://') && !appUrl.startsWith('https://')) {
      sendJson(res, 400, { error: 'appUrl must start with http:// or https://' });
      return;
    }
    const apiBaseUrl = typeof body.apiBaseUrl === 'string' && body.apiBaseUrl.trim()
      ? body.apiBaseUrl.trim()
      : null;
    const repoIds = Array.isArray(body.repoIds) ? body.repoIds as string[] : [];
    const vaultDocPaths = Array.isArray(body.vaultDocPaths) ? body.vaultDocPaths as string[] : [];
    const viewportWidth = typeof body.viewportWidth === 'number' ? Math.max(320, Math.min(3840, body.viewportWidth)) : 1440;
    const viewportHeight = typeof body.viewportHeight === 'number' ? Math.max(200, Math.min(2160, body.viewportHeight)) : 900;
    const timeoutSecs = typeof body.timeoutSecs === 'number' ? Math.max(10, Math.min(3600, body.timeoutSecs)) : 300;
    const rulesForAi = typeof body.rulesForAi === 'string' ? body.rulesForAi.slice(0, 4000) : '';

    const id = generateId();
    const ts = now();

    insert('test_projects', {
      id,
      project_id: req.params.pid,
      name,
      app_url: appUrl,
      api_base_url: apiBaseUrl,
      repo_ids: JSON.stringify(repoIds),
      vault_doc_paths: JSON.stringify(vaultDocPaths),
      viewport_width: viewportWidth,
      viewport_height: viewportHeight,
      timeout_secs: timeoutSecs,
      rules_for_ai: rulesForAi,
      created_by: req.user!.id,
      created_at: ts,
      updated_at: ts,
    });

    auditRaw(req.user!.id, 'test_project.create', `test_project:${id}`, { name, projectId: req.params.pid });

    const tp = one<TestProject>('SELECT * FROM test_projects WHERE id = ?', id)!;
    sendJson(res, 201, { testProject: tpView(tp) });
  });

  // GET /api/projects/:pid/tests/:tpid — get test project
  router.get('/api/projects/:pid/tests/:tpid', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    sendJson(res, 200, { testProject: tpView(tp) });
  });

  // PUT /api/projects/:pid/tests/:tpid — update test project
  router.put('/api/projects/:pid/tests/:tpid', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updated_at: now() };

    if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 200);
    if (typeof body.appUrl === 'string') {
      const u = body.appUrl.trim();
      if (!u.startsWith('http://') && !u.startsWith('https://')) {
        sendJson(res, 400, { error: 'appUrl must start with http:// or https://' });
        return;
      }
      patch.app_url = u;
    }
    if (body.apiBaseUrl !== undefined) {
      patch.api_base_url = typeof body.apiBaseUrl === 'string' && body.apiBaseUrl.trim()
        ? body.apiBaseUrl.trim()
        : null;
    }
    if (Array.isArray(body.repoIds)) patch.repo_ids = JSON.stringify(body.repoIds);
    if (Array.isArray(body.vaultDocPaths)) patch.vault_doc_paths = JSON.stringify(body.vaultDocPaths);
    if (typeof body.viewportWidth === 'number') patch.viewport_width = Math.max(320, Math.min(3840, body.viewportWidth));
    if (typeof body.viewportHeight === 'number') patch.viewport_height = Math.max(200, Math.min(2160, body.viewportHeight));
    if (typeof body.timeoutSecs === 'number') patch.timeout_secs = Math.max(10, Math.min(3600, body.timeoutSecs));
    if (typeof body.rulesForAi === 'string') patch.rules_for_ai = body.rulesForAi.slice(0, 4000);

    const keys = Object.keys(patch);
    if (keys.length === 1) { sendJson(res, 400, { error: 'Nothing to update' }); return; }
    run(
      `UPDATE test_projects SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => patch[k] as string),
      tp.id,
    );

    auditRaw(req.user!.id, 'test_project.update', `test_project:${tp.id}`, { name: patch.name });
    const updated = one<TestProject>('SELECT * FROM test_projects WHERE id = ?', tp.id)!;
    sendJson(res, 200, { testProject: tpView(updated) });
  });

  // DELETE /api/projects/:pid/tests/:tpid — delete test project
  router.delete('/api/projects/:pid/tests/:tpid', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;

    run('DELETE FROM test_projects WHERE id = ?', tp.id);
    auditRaw(req.user!.id, 'test_project.delete', `test_project:${tp.id}`, { name: tp.name });
    sendJson(res, 200, { ok: true });
  });
}
