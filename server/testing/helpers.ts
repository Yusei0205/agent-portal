/**
 * Shared helpers for the testing module: auth guards, scope checks, DB types.
 */
import { one } from '../db.ts';
import type { Row } from '../db.ts';
import { sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';

// ── DB row types ───────────────────────────────────────────────────────────────

export interface TestProject extends Row {
  id: string;
  project_id: string;
  name: string;
  app_url: string;
  api_base_url: string | null;
  repo_ids: string;
  vault_doc_paths: string;
  viewport_width: number;
  viewport_height: number;
  timeout_secs: number;
  rules_for_ai: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TestVaultItem extends Row {
  id: string;
  test_project_id: string;
  name: string;
  kind: 'login' | 'secret';
  username: string | null;
  password_enc: string | null;
  totp_secret_enc: string | null;
  value_enc: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TestGroup extends Row {
  id: string;
  test_project_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TestScript extends Row {
  id: string;
  test_project_id: string;
  test_group_id: string;
  name: string;
  sort_order: number;
  steps: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TestRun extends Row {
  id: string;
  test_project_id: string;
  script_id: string | null;
  group_id: string | null;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'error';
  error: string | null;
  artifact_dir: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface TestRunStep extends Row {
  id: string;
  run_id: string;
  script_id: string;
  step_index: number;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  duration_ms: number | null;
  error: string | null;
  screenshot_path: string | null;
  created_at: string;
}

export interface TestGeneration extends Row {
  id: string;
  test_project_id: string;
  script_id: string | null;
  kind: 'generate' | 'refine' | 'import';
  description: string | null;
  status: 'pending' | 'running' | 'done' | 'failed';
  error: string | null;
  result_script_ids: string;
  warnings: string;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  progress: string;
  cancelled_at: string | null;
}

// ── Scope helpers ──────────────────────────────────────────────────────────────

/**
 * Returns true when the request has the given scope or is a browser session.
 */
export function hasScope(req: PortalRequest, scope: 'read' | 'write' | 'review' | 'merge' | 'tests'): boolean {
  if (!req.authViaToken) return true; // browser session — all scopes allowed
  return (req.tokenScopes ?? []).includes(scope);
}

// ── Project membership guard ───────────────────────────────────────────────────

/**
 * Require the caller to be a member of the portal project.
 * Returns the member row (or null on failure, after sending the response).
 */
function getProjectMember(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
): { role: string } | null {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const project = one<Row>('SELECT id FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (req.user.is_admin) return { role: 'owner' };
  const member = one<Row>(
    'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    req.user.id,
  );
  if (!member) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  return { role: String(member.role) };
}

/**
 * Require:
 *  1. caller is a portal project member (viewer+)
 *  2. test project exists and belongs to the portal project
 *  3. the caller has the requested minimum role:
 *     - 'viewer' → any member role
 *     - 'editor' → editor or owner
 *
 * On success returns the TestProject row.
 * On failure sends the error response and returns null.
 */
export function requireTestProject(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
  testProjectId: string,
  minRole: 'viewer' | 'editor' = 'viewer',
): TestProject | null {
  const member = getProjectMember(req, res, projectId);
  if (!member) return null;

  if (minRole === 'editor' && member.role === 'viewer') {
    sendJson(res, 403, { error: 'Editor access required' });
    return null;
  }

  const tp = one<TestProject>(
    'SELECT * FROM test_projects WHERE id = ? AND project_id = ?',
    testProjectId,
    projectId,
  );
  if (!tp) {
    sendJson(res, 404, { error: 'Test project not found' });
    return null;
  }
  return tp;
}

/**
 * Require the caller to be a project member (at least viewer) without needing a test project.
 * Used for listing test projects and the capability endpoint.
 */
export function requireProjectMember(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
): boolean {
  const member = getProjectMember(req, res, projectId);
  return member !== null;
}

/**
 * Require the caller to be at least an editor of the portal project.
 */
export function requireProjectEditor(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
): boolean {
  const member = getProjectMember(req, res, projectId);
  if (!member) return false;
  if (member.role === 'viewer') {
    sendJson(res, 403, { error: 'Editor access required' });
    return false;
  }
  return true;
}

/**
 * Browser-only guard: rejects API token requests for vault writes.
 */
export function requireBrowserAuth(req: PortalRequest, res: PortalResponse): boolean {
  const authHeader = String(req.headers.authorization ?? '');
  if (authHeader.startsWith('Bearer ')) {
    sendJson(res, 403, {
      error: 'Test vault writes can only be performed from a signed-in browser, not via API tokens',
    });
    return false;
  }
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return false;
  }
  return true;
}
