/**
 * Session IDE — file explorer and editor routes for the in-browser IDE panel.
 *
 * Three scopes per session (workflow):
 *   work     — run work dir (DATA_DIR/projects/{slug}/work/{runId}/)
 *   uploads  — per-workflow upload staging area (DATA_DIR/projects/{slug}/uploads/{wid}/)
 *   vault    — read-only vault overlay (reuses vault storage, no duplication)
 *
 * Routes:
 *   GET    /api/workflows/:id/ide/tree              — list directory (lazy, by scope+path)
 *   GET    /api/workflows/:id/ide/file              — read file
 *   PUT    /api/workflows/:id/ide/file              — write file (optimistic token)
 *   POST   /api/workflows/:id/ide/file              — create file
 *   POST   /api/workflows/:id/ide/folder            — create folder
 *   DELETE /api/workflows/:id/ide/file              — delete file or folder
 *   PATCH  /api/workflows/:id/ide/rename            — rename
 *   POST   /api/workflows/:id/ide/upload            — multipart upload → uploads scope
 *   GET    /api/workflows/:id/ide/download-zip      — zip download of scope/subpath
 *   GET    /api/workflows/:id/ide/git/status        — git status across repos
 *   GET    /api/workflows/:id/ide/git/diff          — git diff for one file
 *   GET    /api/workflows/:id/ide/vault             — list vault files (read-only meta)
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all } from './db.ts';
import type { Row } from './db.ts';
import { safeJoin, now, generateId, badRequest, notFound } from './util.ts';
import { config } from './config.ts';
import { appendAudit } from './audit.ts';
import { getVaultFilesRepository } from './repositories/vault-files.ts';
import { getDb } from './db.ts';
import { persistFile, forgetFile, restoreTree, forgetTree, persistTree } from './durable-files.ts';

import { getLatestRunRow, getMemberRow, getProjectRow, getWorkflowRow } from './project-access.ts';
// ── Constants ─────────────────────────────────────────────────────────────────

const TEXT_EXTS = new Set([
  '.md', '.txt', '.ts', '.js', '.mjs', '.cjs', '.jsx', '.tsx',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.sh', '.bash',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp', '.h',
  '.html', '.css', '.scss', '.less', '.xml', '.csv',
  '.env', '.env.example', '.gitignore', '.dockerignore',
  '.conf', '.ini', '.cfg', '.log',
]);

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp',
]);

const MAX_TEXT_BYTES = 2 * 1024 * 1024;   // 2 MB text cap
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB upload cap

// Hidden dirs/files to exclude from listings
const SKIP_NAMES = new Set([
  '.git', 'node_modules', '__pycache__', '.DS_Store',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

export type IdeScope = 'work' | 'uploads' | 'vault';

interface WorkingCopyRoots {
  workDir: string;
  uploadsDir: string;
  projectId: string;
  workflowId: string;
  runId: string | null;
  projectSlug: string;
}

export interface IdeTreeEntry {
  name: string;
  path: string;       // relative to scope root
  type: 'file' | 'directory';
  size?: number;
  mtime?: number;     // unix ms
  readOnly?: boolean;
}

// ── Multipart parser (minimal, from vault.ts pattern) ─────────────────────────

interface UploadedFile {
  filename: string;
  mimeType: string;
  data: Buffer;
}

function parseMultipartUpload(
  rawBody: Buffer,
  contentType: string,
): UploadedFile {
  const files = parseMultipartUploadMulti(rawBody, contentType);
  if (files.length === 0) throw badRequest('No file found in upload');
  return files[0];
}

function parseMultipartUploadMulti(
  rawBody: Buffer,
  contentType: string,
): UploadedFile[] {
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) throw badRequest('Missing multipart boundary');
  const boundary = '--' + boundaryMatch[1];
  const bodyStr = rawBody.toString('binary');

  const parts: Buffer[] = [];
  let start = 0;
  while (true) {
    const idx = bodyStr.indexOf(boundary, start);
    if (idx < 0) break;
    if (start > 0) {
      let end = idx;
      if (bodyStr[end - 1] === '\n') end--;
      if (bodyStr[end - 1] === '\r') end--;
      parts.push(rawBody.slice(start, end));
    }
    start = idx + boundary.length;
    if (bodyStr[start] === '\r') start++;
    if (bodyStr[start] === '\n') start++;
    if (bodyStr.slice(idx + boundary.length, idx + boundary.length + 2) === '--') break;
  }

  const files: UploadedFile[] = [];
  for (const part of parts) {
    const partStr = part.toString('binary');
    const headerEnd = partStr.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headerSection = partStr.slice(0, headerEnd);
    const partData = part.slice(headerEnd + 4);
    const filenameMatch = headerSection.match(/Content-Disposition:[^\r\n]*filename="([^"]+)"/i);
    if (!filenameMatch) continue;
    const ctMatch = headerSection.match(/Content-Type:\s*([^\r\n]+)/i);
    files.push({
      filename: filenameMatch[1].trim(),
      mimeType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
      data: partData,
    });
  }
  return files;
}

// ── Working copy resolution ───────────────────────────────────────────────────

async function resolveWorkingCopyRoots(workflowId: string): Promise<WorkingCopyRoots | null> {
  const wf = await getWorkflowRow(workflowId);
  if (!wf) return null;
  if (!wf.project_id) return null;

  // S1-TODO(projects): This should use getProjectRepository().getProjectById() once
  // resolveWorkingCopyRoots is converted to async. The function is called synchronously
  // from async route handlers in session-files.ts; converting it requires making those
  // callers await it. Leave on direct SQLite until session-files module is converted.
  const project = await getProjectRow(wf.project_id as string);
  if (!project) return null;

  const slug = String(project.slug);
  const projectDir = path.join(config.dataDir, 'projects', slug);

  // Prefer the persistent work_dir stored on the workflow (set by runner after first run)
  let runWorkDir: string;
  let runId: string | null;

  if (wf.work_dir) {
    runWorkDir = String(wf.work_dir);
    // Derive a synthetic runId from the path for backward-compat callers
    runId = path.basename(runWorkDir);
  } else {
    // Pre-M21 fallback: look up the latest run
    const workDir = path.join(projectDir, 'work');
    const latestRun = await getLatestRunRow(workflowId);
    runId = latestRun ? String(latestRun.id) : null;
    runWorkDir = runId ? path.join(workDir, runId) : workDir;
  }

  const uploadsDir = path.join(projectDir, 'uploads', workflowId);

  // On Lambda the local disk starts empty: bring back what was mirrored to S3 for this session.
  await restoreTree(runWorkDir);
  await restoreTree(uploadsDir);

  return {
    workDir: runWorkDir,
    uploadsDir,
    projectId: String(project.id),
    workflowId,
    runId,
    projectSlug: slug,
  };
}

/** Resolve a scope+relative-path to an absolute path, with strict containment check. */
function resolveScopePath(
  roots: WorkingCopyRoots,
  scope: IdeScope,
  relPath: string,
): string {
  if (scope === 'vault') {
    throw badRequest('Vault paths are read-only and accessed by file ID');
  }
  const root = scope === 'uploads' ? roots.uploadsDir : roots.workDir;
  const safePath = relPath ? safeJoin(root, relPath) : root;
  // Additional symlink-escape guard: if the resolved path exists, realpathSync it
  try {
    const real = fs.realpathSync(safePath);
    const realRoot = fs.realpathSync(root);
    // Use sep-aware containment to prevent sibling-prefix bypass
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new Error(`Path escapes root`);
    }
    return safePath;
  } catch (e: unknown) {
    // If path doesn't exist yet (new file/dir creation), safeJoin already checked the prefix
    if (e instanceof Error && e.message.includes('escapes root')) {
      throw badRequest('Path traversal detected');
    }
    // ENOENT — path doesn't exist yet, safeJoin check is sufficient
    return safePath;
  }
}

/** Check that the path is strictly inside the root (no escape). */
function assertPathContained(absPath: string, root: string): void {
  const resolvedPath = path.resolve(absPath);
  const resolvedRoot = path.resolve(root);
  if (!resolvedPath.startsWith(resolvedRoot + path.sep) && resolvedPath !== resolvedRoot) {
    throw badRequest('Path traversal detected');
  }
}

// ── Access control ────────────────────────────────────────────────────────────

/** Returns the workflow row or null (response already sent). */
async function requireWorkflowReadAccess(
  req: PortalRequest,
  res: PortalResponse,
  workflowId: string,
): Promise<Row | null> {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const wf = await getWorkflowRow(workflowId);
  if (!wf) {
    sendJson(res, 404, { error: 'Session not found' });
    return null;
  }
  if (req.user.is_admin) return wf;
  if (!wf.project_id) {
    // Project-less workflow: only the creator can access (gap 10)
    if (String(wf.created_by ?? '') === req.user.id) return wf;
    sendJson(res, 403, { error: 'Not authorized to access this session' });
    return null;
  }
  const member = await getMemberRow(wf.project_id as string, req.user.id);
  if (!member) {
    sendJson(res, 403, { error: 'Not a project member' });
    return null;
  }
  return wf;
}

/** Returns true if the user can write to the session's working copy. */
async function canWrite(req: PortalRequest, wf: Row): Promise<boolean> {
  if (!req.user) return false;
  if (req.user.is_admin) {
    // Admin via API token still needs write scope
    if (req.authViaToken && !(req.tokenScopes ?? []).includes('write')) return false;
    return true;
  }
  if (!wf.project_id) return false;
  const member = await getMemberRow(wf.project_id as string, req.user.id);
  if (!member) return false;
  if (!['editor', 'owner'].includes(String(member.access))) return false;
  // API-token requests additionally need write scope
  if (req.authViaToken && !(req.tokenScopes ?? []).includes('write')) return false;
  return true;
}

// ── Directory listing ─────────────────────────────────────────────────────────

function listDirectory(absDir: string, scopeRoot: string, readOnly: boolean): IdeTreeEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: IdeTreeEntry[] = [];
  for (const entry of entries) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const absPath = path.join(absDir, entry.name);
    const relPath = path.relative(scopeRoot, absPath);
    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        path: relPath,
        type: 'directory',
        readOnly: readOnly || undefined,
      });
    } else if (entry.isFile()) {
      let size: number | undefined;
      let mtime: number | undefined;
      try {
        const stat = fs.statSync(absPath);
        size = stat.size;
        mtime = stat.mtimeMs;
      } catch {
        // best-effort
      }
      result.push({
        name: entry.name,
        path: relPath,
        type: 'file',
        size,
        mtime,
        readOnly: readOnly || undefined,
      });
    }
  }
  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ── File type detection ───────────────────────────────────────────────────────

function fileTypeForExt(ext: string): 'text' | 'image' | 'binary' {
  if (TEXT_EXTS.has(ext.toLowerCase())) return 'text';
  if (IMAGE_EXTS.has(ext.toLowerCase())) return 'image';
  return 'binary';
}

function mimeForExt(ext: string): string {
  const MIME: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    '.ico': 'image/x-icon',
  };
  return MIME[ext.toLowerCase()] ?? 'application/octet-stream';
}

// ── Concurrency token ─────────────────────────────────────────────────────────

/** Generate a concurrency token from a file's mtime and size. */
function fileToken(stat: fs.Stats): string {
  return createHash('sha1')
    .update(`${stat.mtimeMs}:${stat.size}`)
    .digest('hex')
    .slice(0, 16);
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function spawnGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8').trimEnd());
      else reject(new Error(Buffer.concat(err).toString('utf8').trimEnd() || `git exited with ${code}`));
    });
    proc.on('error', reject);
  });
}

/** Find all git repo directories inside a work dir (repos/* subdirs with .git). */
function findGitRepos(workDir: string): string[] {
  const reposDir = path.join(workDir, 'repos');
  if (!fs.existsSync(reposDir)) return [];
  const result: string[] = [];
  try {
    for (const entry of fs.readdirSync(reposDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(reposDir, entry.name);
      if (fs.existsSync(path.join(candidate, '.git'))) {
        result.push(candidate);
      }
    }
  } catch {
    // ignore
  }
  return result;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerSessionFileRoutes(): void {

  // GET /api/workflows/:id/ide/tree
  router.get('/api/workflows/:id/ide/tree', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const wf = await requireWorkflowReadAccess(req, res, req.params.id);
    if (!wf) return;

    const roots = await resolveWorkingCopyRoots(req.params.id);
    if (!roots) {
      sendJson(res, 404, { error: 'Session working copy not found' });
      return;
    }

    const scope = (req.query.get('scope') as IdeScope | null) ?? null;
    const relPath = req.query.get('path') ?? '';

    // No scope → return available roots
    if (!scope) {
      sendJson(res, 200, {
        roots: [
          { name: 'Working Copy', scope: 'work', path: '' },
          { name: 'Uploads', scope: 'uploads', path: '' },
          { name: 'Vault', scope: 'vault', path: '', readOnly: true },
        ],
      });
      return;
    }

    if (scope === 'vault') {
      // Vault listing — delegate to vault query
      const projectId = roots.projectId;
      const userId = req.user!.id;
      const files = await getVaultFilesRepository().listByProject(projectId, userId, null);
      files.sort((a, b) => a.name.localeCompare(b.name));
      sendJson(res, 200, {
        scope: 'vault',
        path: '',
        readOnly: true,
        entries: files.map((f) => ({
          name: f.name,
          path: f.id,
          type: 'file',
          size: f.size_bytes,
          mtime: undefined,
          readOnly: true,
          vaultId: f.id,
          downloadUrl: `/api/projects/${projectId}/vault/${f.id}/download`,
        })),
      });
      return;
    }

    const scopeRoot = scope === 'uploads' ? roots.uploadsDir : roots.workDir;

    // Ensure uploads dir exists
    if (scope === 'uploads') {
      await fsp.mkdir(roots.uploadsDir, { recursive: true });
    }

    const absDir = relPath ? resolveScopePath(roots, scope, relPath) : scopeRoot;

    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
      sendJson(res, 404, { error: 'Directory not found' });
      return;
    }

    const entries = listDirectory(absDir, scopeRoot, false);
    sendJson(res, 200, { scope, path: relPath, entries });
  });

  // GET /api/workflows/:id/ide/file
  router.get('/api/workflows/:id/ide/file', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const wf = await requireWorkflowReadAccess(req, res, req.params.id);
    if (!wf) return;

    const scope = (req.query.get('scope') as IdeScope | null) ?? 'work';
    const relPath = req.query.get('path') ?? '';
    if (!relPath) {
      sendJson(res, 400, { error: 'path query parameter required' });
      return;
    }
    if (scope === 'vault') {
      sendJson(res, 400, { error: 'Use the vault download route for vault files' });
      return;
    }

    const roots = await resolveWorkingCopyRoots(req.params.id);
    if (!roots) {
      sendJson(res, 404, { error: 'Session working copy not found' });
      return;
    }

    let absPath: string;
    try {
      absPath = resolveScopePath(roots, scope, relPath);
    } catch {
      sendJson(res, 400, { error: 'Invalid path' });
      return;
    }

    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      sendJson(res, 404, { error: 'File not found' });
      return;
    }

    const stat = fs.statSync(absPath);
    const token = fileToken(stat);
    const ext = path.extname(absPath).toLowerCase();
    const fileType = fileTypeForExt(ext);

    if (fileType === 'text') {
      if (stat.size > MAX_TEXT_BYTES) {
        sendJson(res, 200, {
          type: 'binary',
          ext,
          size: stat.size,
          token,
          tooLarge: true,
          message: `File is too large to edit in browser (${Math.round(stat.size / 1024)} KB, max ${MAX_TEXT_BYTES / 1024} KB)`,
        });
        return;
      }
      const content = fs.readFileSync(absPath, 'utf8');
      sendJson(res, 200, { type: 'text', ext, content, size: stat.size, token, mtime: stat.mtimeMs });
      return;
    }

    if (fileType === 'image') {
      if (stat.size > 5 * 1024 * 1024) {
        sendJson(res, 200, { type: 'binary', ext, size: stat.size, token });
        return;
      }
      const buf = fs.readFileSync(absPath);
      sendJson(res, 200, {
        type: 'image',
        ext,
        size: stat.size,
        token,
        url: `data:${mimeForExt(ext)};base64,${buf.toString('base64')}`,
        mtime: stat.mtimeMs,
      });
      return;
    }

    sendJson(res, 200, { type: 'binary', ext, size: stat.size, token, mtime: stat.mtimeMs });
  });

  // PUT /api/workflows/:id/ide/file — write (requires token for concurrency guard)
  router.put('/api/workflows/:id/ide/file', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const wf = await requireWorkflowReadAccess(req, res, req.params.id);
    if (!wf) return;
    if (!await canWrite(req, wf)) {
      sendJson(res, 403, { error: 'Project editor access required' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const scope = (body.scope as IdeScope | undefined) ?? 'work';
    const relPath = String(body.path ?? '');
    const content = String(body.content ?? '');
    const clientToken = body.token as string | undefined;

    if (!relPath) {
      sendJson(res, 400, { error: 'path required' });
      return;
    }
    if (scope === 'vault') {
      sendJson(res, 400, { error: 'Vault files are read-only' });
      return;
    }

    const roots = await resolveWorkingCopyRoots(req.params.id);
    if (!roots) {
      sendJson(res, 404, { error: 'Session working copy not found' });
      return;
    }

    let absPath: string;
    try {
      absPath = resolveScopePath(roots, scope, relPath);
    } catch {
      sendJson(res, 400, { error: 'Invalid path' });
      return;
    }

    // Optimistic concurrency: if file exists and client supplied a token, verify it
    if (fs.existsSync(absPath)) {
      if (clientToken) {
        const currentStat = fs.statSync(absPath);
        const currentToken = fileToken(currentStat);
        if (currentToken !== clientToken) {
          sendJson(res, 409, {
            error: 'File was modified by another process',
            code: 'stale_token',
            token: currentToken,
          });
          return;
        }
      }
    } else {
      await fsp.mkdir(path.dirname(absPath), { recursive: true });
    }

    await fsp.writeFile(absPath, content, 'utf8');
    await persistFile(absPath);
    const newStat = fs.statSync(absPath);

    appendAudit(
      getDb(),
      req.user!.id,
      'ide.file.write',
      `workflow:${req.params.id}`,
      { scope, path: relPath },
      req.ip,
    );

    sendJson(res, 200, { ok: true, token: fileToken(newStat), size: newStat.size, mtime: newStat.mtimeMs });
  });

  // POST /api/workflows/:id/ide/file — create new file
  router.post('/api/workflows/:id/ide/file', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const wf = await requireWorkflowReadAccess(req, res, req.params.id);
    if (!wf) return;
    if (!await canWrite(req, wf)) {
      sendJson(res, 403, { error: 'Project editor access required' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const scope = (body.scope as IdeScope | undefined) ?? 'work';
    const relPath = String(body.path ?? '');
    const content = String(body.content ?? '');

    if (!relPath) {
      sendJson(res, 400, { error: 'path required' });
      return;
    }
    if (scope === 'vault') {
      sendJson(res, 400, { error: 'Vault files are read-only' });
      return;
    }

    const roots = await resolveWorkingCopyRoots(req.params.id);
    if (!roots) {
      sendJson(res, 404, { error: 'Session working copy not found' });
      return;
    }

    let absPath: string;
    try {
      absPath = resolveScopePath(roots, scope, relPath);
    } catch {
      sendJson(res, 400, { error: 'Invalid path' });
      return;
    }

    if (fs.existsSync(absPath)) {
      sendJson(res, 409, { error: 'File already exists' });
      return;
    }

    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.writeFile(absPath, content, 'utf8');
    await persistFile(absPath);
    const stat = fs.statSync(absPath);

    appendAudit(
      getDb(),
      req.user!.id,
      'ide.file.create',
      `workflow:${req.params.id}`,
      { scope, path: relPath },
      req.ip,
    );

    sendJson(res, 201, { ok: true, token: fileToken(stat), size: stat.size, mtime: stat.mtimeMs });
  });

  // POST /api/workflows/:id/ide/folder — create folder
  router.post('/api/workflows/:id/ide/folder', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const wf = await requireWorkflowReadAccess(req, res, req.params.id);
    if (!wf) return;
    if (!await canWrite(req, wf)) {
      sendJson(res, 403, { error: 'Project editor access required' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const scope = (body.scope as IdeScope | undefined) ?? 'work';
    const relPath = String(body.path ?? '');

    if (!relPath) {
      sendJson(res, 400, { error: 'path required' });
      return;
    }
    if (scope === 'vault') {
      sendJson(res, 400, { error: 'Vault files are read-only' });
      return;
    }

    const roots = await resolveWorkingCopyRoots(req.params.id);
    if (!roots) {
      sendJson(res, 404, { error: 'Session working copy not found' });
      return;
    }

    let absPath: string;
    try {
      absPath = resolveScopePath(roots, scope, relPath);
    } catch {
      sendJson(res, 400, { error: 'Invalid path' });
      return;
    }

    await fsp.mkdir(absPath, { recursive: true });
    sendJson(res, 201, { ok: true });
  });

  // DELETE /api/workflows/:id/ide/file
  router.delete('/api/workflows/:id/ide/file', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const wf = await requireWorkflowReadAccess(req, res, req.params.id);
    if (!wf) return;
    if (!await canWrite(req, wf)) {
      sendJson(res, 403, { error: 'Project editor access required' });
      return;
    }

    const scope = (req.query.get('scope') as IdeScope | null) ?? 'work';
    const relPath = req.query.get('path') ?? '';

    if (!relPath) {
      sendJson(res, 400, { error: 'path query parameter required' });
      return;
    }
    if (scope === 'vault') {
      sendJson(res, 403, { error: 'Vault files are read-only and cannot be deleted' });
      return;
    }

    const roots = await resolveWorkingCopyRoots(req.params.id);
    if (!roots) {
      sendJson(res, 404, { error: 'Session working copy not found' });
      return;
    }

    let absPath: string;
    try {
      absPath = resolveScopePath(roots, scope, relPath);
    } catch {
      sendJson(res, 400, { error: 'Invalid path' });
      return;
    }

    if (!fs.existsSync(absPath)) {
      sendJson(res, 404, { error: 'File not found' });
      return;
    }

    // Refuse to delete the scope root itself
    const scopeRoot = scope === 'uploads' ? roots.uploadsDir : roots.workDir;
    if (path.resolve(absPath) === path.resolve(scopeRoot)) {
      sendJson(res, 400, { error: 'Cannot delete the root working copy directory' });
      return;
    }

    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      await fsp.rm(absPath, { recursive: true, force: true });
      await forgetTree(absPath);
    } else {
      await fsp.rm(absPath, { force: true });
      await forgetFile(absPath);
    }

    appendAudit(
      getDb(),
      req.user!.id,
      'ide.file.delete',
      `workflow:${req.params.id}`,
      { scope, path: relPath },
      req.ip,
    );

    sendJson(res, 200, { ok: true });
  });

  // PATCH /api/workflows/:id/ide/rename
  router.patch('/api/workflows/:id/ide/rename', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const wf = await requireWorkflowReadAccess(req, res, req.params.id);
    if (!wf) return;
    if (!await canWrite(req, wf)) {
      sendJson(res, 403, { error: 'Project editor access required' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const scope = (body.scope as IdeScope | undefined) ?? 'work';
    // Support both { from, to } (contract) and { path, newPath } (legacy)
    const relPath = String(body.from ?? body.path ?? '');
    const newRelPath = String(body.to ?? body.newPath ?? '');

    if (!relPath || !newRelPath) {
      sendJson(res, 400, { error: 'from/to (or path/newPath) required' });
      return;
    }
    if (scope === 'vault') {
      sendJson(res, 403, { error: 'Vault files are read-only' });
      return;
    }

    const roots = await resolveWorkingCopyRoots(req.params.id);
    if (!roots) {
      sendJson(res, 404, { error: 'Session working copy not found' });
      return;
    }

    let srcPath: string;
    let destPath: string;
    try {
      srcPath = resolveScopePath(roots, scope, relPath);
      destPath = resolveScopePath(roots, scope, newRelPath);
    } catch {
      sendJson(res, 400, { error: 'Invalid path' });
      return;
    }

    if (!fs.existsSync(srcPath)) {
      sendJson(res, 404, { error: 'Source file not found' });
      return;
    }
    if (fs.existsSync(destPath)) {
      sendJson(res, 409, { error: 'Destination already exists' });
      return;
    }

    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    const movedDir = fs.statSync(srcPath).isDirectory();
    await fsp.rename(srcPath, destPath);
    if (movedDir) {
      await forgetTree(srcPath);
      await persistTree(destPath);
    } else {
      await forgetFile(srcPath);
      await persistFile(destPath);
    }

    appendAudit(
      getDb(),
      req.user!.id,
      'ide.file.rename',
      `workflow:${req.params.id}`,
      { scope, from: relPath, to: newRelPath },
      req.ip,
    );

    sendJson(res, 200, { ok: true, path: newRelPath });
  });

  // POST /api/workflows/:id/ide/upload
  router.post('/api/workflows/:id/ide/upload', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const wf = await requireWorkflowReadAccess(req, res, req.params.id);
    if (!wf) return;
    if (!await canWrite(req, wf)) {
      sendJson(res, 403, { error: 'Project editor access required' });
      return;
    }

    if (!req.rawBody || req.rawBody.length === 0) {
      sendJson(res, 400, { error: 'No file data received' });
      return;
    }

    const ct = String(req.headers['content-type'] ?? '');
    let uploadedFiles: UploadedFile[];
    try {
      uploadedFiles = parseMultipartUploadMulti(req.rawBody, ct);
    } catch (e: unknown) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
      return;
    }

    if (uploadedFiles.length === 0) {
      sendJson(res, 400, { error: 'No files found in upload' });
      return;
    }

    // Check total size before writing anything
    const totalSize = uploadedFiles.reduce((s, f) => s + f.data.length, 0);
    if (totalSize > MAX_UPLOAD_BYTES) {
      sendJson(res, 413, { error: `Upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit` });
      return;
    }
    // Also check individual files
    for (const f of uploadedFiles) {
      if (f.data.length > MAX_UPLOAD_BYTES) {
        sendJson(res, 413, { error: `File "${f.filename}" exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit` });
        return;
      }
    }

    const roots = await resolveWorkingCopyRoots(req.params.id);
    if (!roots) {
      sendJson(res, 404, { error: 'Session working copy not found' });
      return;
    }

    await fsp.mkdir(roots.uploadsDir, { recursive: true });

    const savedFiles: Array<{ path: string; size: number; name: string; mtime: number }> = [];
    for (const uploaded of uploadedFiles) {
      const safeFilename = path.basename(uploaded.filename)
        .replace(/[^\w.\-]/g, '_')
        .slice(0, 200);
      const destPath = path.join(roots.uploadsDir, safeFilename);
      assertPathContained(destPath, roots.uploadsDir);

      await fsp.writeFile(destPath, uploaded.data);
      await persistFile(destPath);
      const stat = fs.statSync(destPath);

      appendAudit(
        getDb(),
        req.user!.id,
        'ide.upload',
        `workflow:${req.params.id}`,
        { filename: safeFilename, size: stat.size },
        req.ip,
      );

      savedFiles.push({ path: safeFilename, size: stat.size, name: safeFilename, mtime: stat.mtimeMs });
    }

    // Return new contract { files: [{path, size}] } plus backward-compat { ok, file }
    const first = savedFiles[0];
    sendJson(res, 200, {
      ok: true,
      files: savedFiles.map(f => ({ path: f.path, size: f.size })),
      // backward-compat single-file shape
      file: first ? {
        name: first.name,
        path: first.path,
        scope: 'uploads',
        size: first.size,
        mtime: first.mtime,
      } : null,
    });
  });

  // GET /api/workflows/:id/ide/download-zip
  router.get('/api/workflows/:id/ide/download-zip', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const wf = await requireWorkflowReadAccess(req, res, req.params.id);
    if (!wf) return;

    const repoParam = req.query.get('repo') ?? '';
    const scope = (req.query.get('scope') as IdeScope | null) ?? 'work';
    const relPath = req.query.get('path') ?? '';

    if (scope === 'vault') {
      sendJson(res, 400, { error: 'Use the vault download routes for vault files' });
      return;
    }

    const roots = await resolveWorkingCopyRoots(req.params.id);
    if (!roots) {
      sendJson(res, 404, { error: 'Session working copy not found' });
      return;
    }

    let absDir: string;
    let zipName: string;

    if (repoParam) {
      // Download a specific git repo checkout (gap 4)
      const repoDir = path.join(roots.workDir, 'repos', repoParam);
      try {
        assertPathContained(repoDir, roots.workDir);
      } catch {
        sendJson(res, 400, { error: 'Invalid repo name' });
        return;
      }
      absDir = repoDir;
      zipName = `${repoParam}.zip`;
    } else {
      const scopeRoot = scope === 'uploads' ? roots.uploadsDir : roots.workDir;
      absDir = relPath ? resolveScopePath(roots, scope, relPath) : scopeRoot;
      zipName = relPath
        ? `${path.basename(relPath)}.zip`
        : `${scope}.zip`;
    }

    if (!fs.existsSync(absDir)) {
      sendJson(res, 404, { error: 'Directory not found' });
      return;
    }

    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();

    function addToZip(dir: string, prefix: string): void {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIP_NAMES.has(entry.name)) continue;
        const entryPath = path.join(dir, entry.name);
        const zipPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          addToZip(entryPath, zipPath);
        } else if (entry.isFile()) {
          try {
            zip.file(zipPath, fs.readFileSync(entryPath));
          } catch {
            // skip unreadable files
          }
        }
      }
    }

    addToZip(absDir, '');
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(zipName)}"`,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });

  // GET /api/workflows/:id/ide/git/status
  router.get('/api/workflows/:id/ide/git/status', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const wf = await requireWorkflowReadAccess(req, res, req.params.id);
    if (!wf) return;

    const roots = await resolveWorkingCopyRoots(req.params.id);
    if (!roots || !fs.existsSync(roots.workDir)) {
      sendJson(res, 200, { repos: [] });
      return;
    }

    const repoDirs = findGitRepos(roots.workDir);
    const repos: Array<{
      name: string;
      branch: string;
      base: string | null;
      files: Array<{ path: string; status: 'A' | 'M' | 'D' | 'R' | '?'; oldPath?: string }>;
    }> = [];

    for (const repoDir of repoDirs) {
      const repoName = path.basename(repoDir);
      try {
        // Get current branch name
        const branch = await spawnGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).catch(() => 'HEAD');

        // Determine base branch: try upstream tracking, then common refs
        let base: string | null = null;
        try {
          base = await spawnGit(['rev-parse', '--abbrev-ref', '@{u}'], repoDir);
        } catch {
          for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
            try {
              await spawnGit(['rev-parse', '--verify', candidate], repoDir);
              base = candidate;
              break;
            } catch { /* continue */ }
          }
        }

        const files: Array<{ path: string; status: 'A' | 'M' | 'D' | 'R' | '?'; oldPath?: string }> = [];

        // Get committed changes vs base (if base is known)
        if (base) {
          try {
            const diffOut = await spawnGit(['diff', '--name-status', `${base}..HEAD`], repoDir);
            if (diffOut) {
              // Parse each line: "STATUS\tpath" or "R100\told\tnew"
              for (const line of diffOut.split('\n')) {
                const l = line.replace(/\r$/, '').trim();
                if (!l) continue;
                const parts = l.split('\t');
                if (parts.length < 2) continue;
                const code = parts[0];
                if (code.startsWith('R') || code.startsWith('C')) {
                  const oldP = parts[1] ?? '';
                  const newP = parts[2] ?? '';
                  if (newP) files.push({ path: newP, status: 'R', oldPath: oldP });
                } else {
                  const fp = parts[1] ?? '';
                  const s = (code[0] as 'A' | 'M' | 'D') || 'M';
                  if (fp) files.push({ path: fp, status: s === 'A' || s === 'M' || s === 'D' ? s : 'M' });
                }
              }
            }
          } catch { /* skip committed diff if it fails */ }
        }

        // Get uncommitted changes (overrides committed entries for the same path)
        // Use newline-delimited output (more reliable cross-platform than -z)
        const statusOut = await spawnGit(['status', '--porcelain=v1'], repoDir).catch(() => '');
        const seenPaths = new Set(files.map(f => f.path));
        if (statusOut) {
          const lines = statusOut.split('\n');
          for (let li = 0; li < lines.length; li++) {
            // Trim \r for Windows compatibility
            const line = lines[li].replace(/\r$/, '');
            if (!line || line.length < 4) continue;
            const x = line[0];
            const y = line[1];
            // position 2 is space separator
            const filePart = line.slice(3);

            if (x === '?' && y === '?') {
              // Untracked
              if (!seenPaths.has(filePart)) {
                files.push({ path: filePart, status: '?' });
                seenPaths.add(filePart);
              }
            } else if (x === 'R' || y === 'R' || x === 'C') {
              // Rename: porcelain v1 format is "R  new -> old" (with arrow)
              const arrowIdx = filePart.indexOf(' -> ');
              const newPath = arrowIdx >= 0 ? filePart.slice(0, arrowIdx) : filePart;
              const oldPath = arrowIdx >= 0 ? filePart.slice(arrowIdx + 4) : undefined;
              if (!seenPaths.has(newPath)) {
                files.push({ path: newPath, status: 'R', oldPath });
                seenPaths.add(newPath);
              }
            } else {
              const effStatus = (x !== ' ' && x !== '?') ? x : y;
              let s: 'A' | 'M' | 'D' = 'M';
              if (effStatus === 'A') s = 'A';
              else if (effStatus === 'D') s = 'D';
              if (!seenPaths.has(filePart)) {
                files.push({ path: filePart, status: s });
                seenPaths.add(filePart);
              }
            }
          }
        }

        repos.push({ name: repoName, branch, base, files });
      } catch {
        // git not available or not a repo — skip
      }
    }

    sendJson(res, 200, { repos });
  });

  // GET /api/workflows/:id/ide/git/diff
  router.get('/api/workflows/:id/ide/git/diff', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const wf = await requireWorkflowReadAccess(req, res, req.params.id);
    if (!wf) return;

    // New contract: ?repo=<name>&path=<relpath>
    // Legacy fallback: ?path=repos/<name>/...
    const repoParam = req.query.get('repo') ?? '';
    const pathParam = req.query.get('path') ?? '';

    if (!pathParam && !repoParam) {
      sendJson(res, 400, { error: 'path query parameter required' });
      return;
    }

    const roots = await resolveWorkingCopyRoots(req.params.id);
    if (!roots || !fs.existsSync(roots.workDir)) {
      sendJson(res, 404, { error: 'Working copy not found' });
      return;
    }

    let repoDir: string;
    let fileInRepo: string;

    if (repoParam) {
      // New contract: repo=<name>&path=<relpath>
      repoDir = path.join(roots.workDir, 'repos', repoParam);
      try {
        assertPathContained(repoDir, path.join(roots.workDir, 'repos'));
      } catch {
        sendJson(res, 400, { error: 'Invalid repo name' });
        return;
      }
      fileInRepo = pathParam;
    } else {
      // Legacy: path=repos/<name>/relative/file
      const parts = pathParam.split('/').filter(Boolean);
      if (parts.length < 2 || parts[0] !== 'repos') {
        sendJson(res, 400, { error: 'Diff only available for files inside repos/' });
        return;
      }
      const repoName = parts[1];
      repoDir = path.join(roots.workDir, 'repos', repoName);
      assertPathContained(repoDir, path.join(roots.workDir, 'repos'));
      fileInRepo = parts.slice(2).join('/');
    }

    if (!fs.existsSync(path.join(repoDir, '.git'))) {
      sendJson(res, 404, { error: 'Not a git repository' });
      return;
    }

    const MAX_DIFF_BYTES = 512 * 1024; // 512 KB cap

    try {
      // Check if file is binary
      let binary = false;
      try {
        const numstatOut = await spawnGit(['diff', 'HEAD', '--numstat', '--', fileInRepo || '.'], repoDir);
        if (numstatOut.startsWith('-\t-')) binary = true;
      } catch { /* ignore */ }

      if (binary) {
        sendJson(res, 200, { diff: '', binary: true, truncated: false });
        return;
      }

      // Try staged+unstaged diff vs HEAD first
      let diff = '';
      try {
        diff = await spawnGit(['diff', 'HEAD', '--', fileInRepo || '.'], repoDir);
      } catch {
        try {
          diff = await spawnGit(['diff', '--', fileInRepo || '.'], repoDir);
        } catch {
          diff = '';
        }
      }

      const truncated = Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES;
      const finalDiff = truncated ? diff.slice(0, MAX_DIFF_BYTES) : diff;

      sendJson(res, 200, { diff: finalDiff, binary: false, truncated });
    } catch {
      sendJson(res, 200, { diff: '', binary: false, truncated: false });
    }
  });

  // GET /api/workflows/:id/ide/vault — list vault files (read-only overlay)
  router.get('/api/workflows/:id/ide/vault', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const wf = await requireWorkflowReadAccess(req, res, req.params.id);
    if (!wf) return;

    const roots = await resolveWorkingCopyRoots(req.params.id);
    if (!roots) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    const projectId = roots.projectId;
    const userId = req.user!.id;
    const scope = (req.query.get('scope') ?? 'all') as 'project' | 'personal' | 'portal' | 'all';

    let files;
    if (scope === 'project') {
      files = await getVaultFilesRepository().listByProject(projectId, userId, 'project');
    } else if (scope === 'personal') {
      files = await getVaultFilesRepository().listByProject(projectId, userId, 'personal');
    } else if (scope === 'portal') {
      files = await getVaultFilesRepository().listPortal();
    } else {
      files = await getVaultFilesRepository().listByProject(projectId, userId, null);
    }

    files.sort((a, b) => a.name.localeCompare(b.name));

    sendJson(res, 200, {
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        scope: f.project_id === null ? 'portal' : f.user_id ? 'personal' : 'project',
        size_bytes: f.size_bytes,
        mime_type: f.mime_type,
        created_at: f.created_at,
        readOnly: true,
        downloadUrl: `/api/projects/${projectId}/vault/${f.id}/download`,
      })),
    });
  });
}
