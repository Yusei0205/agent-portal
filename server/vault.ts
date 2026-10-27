/**
 * Vault file management routes.
 *
 * Three scopes:
 *   project  — project_id set, user_id null  → all project members
 *   personal — project_id set, user_id set   → uploader only
 *   portal   — project_id null, user_id null → admin-uploaded, all projects
 *
 * Routes:
 *   GET    /api/projects/:id/vault                       — list (scope filter via ?scope=)
 *   POST   /api/projects/:id/vault/upload                — multipart upload
 *   DELETE /api/projects/:id/vault/:fileId               — delete
 *   GET    /api/projects/:id/vault/:fileId/download      — stream file
 *   GET    /api/projects/:id/vault/zip                   — zip scope
 *   GET    /api/vault                                    — list portal-wide (admin)
 *   POST   /api/vault/upload                             — portal-wide upload (admin)
 */

import fs from 'node:fs';
import path from 'node:path';
import { IncomingMessage } from 'node:http';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { all, one, run, insert } from './db.ts';
import type { Row } from './db.ts';
import { generateId, now, str, badRequest, notFound, forbidden } from './util.ts';
import { config } from './config.ts';

// ── Exported vault helpers (used by vault-generated.ts) ──────────────────────

/** Maximum bytes per file in the vault. */
export const MAX_FILE = 100 * 1024 * 1024;

/** Maximum total bytes in a project's vault. */
export const MAX_VAULT = 2 * 1024 * 1024 * 1024;

/** Resolve the root directory of the vault for a scope/project/user combination. */
export function vaultDir(scope: 'project' | 'personal' | 'portal', userId: string, projectId: string): string {
  if (scope === 'project') {
    return path.join(config.dataDir, 'vault', 'projects', projectId, 'project');
  }
  if (scope === 'personal') {
    return path.join(config.dataDir, 'vault', 'projects', projectId, 'personal', userId);
  }
  return path.join(config.dataDir, 'vault', 'portal');
}

/** List all files (recursively) under a vault root directory. Returns stat entries. */
export function listVault(root: string): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          out.push({ path: full, size: fs.statSync(full).size });
        } catch {
          // unreadable
        }
      }
    }
  };
  walk(root);
  return out;
}

// ── Multipart reader (reused pattern from knowledge.ts) ───────────────────────

interface UploadedFile {
  filename: string;
  mimeType: string;
  data: Buffer;
}

async function readMultipartFile(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ file: UploadedFile | null; fields: Record<string, string> }> {
  const ct = req.headers['content-type'] ?? '';
  const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) throw badRequest('Missing multipart boundary');
  const boundary = '--' + boundaryMatch[1];

  const chunks: Buffer[] = [];
  let total = 0;

  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(badRequest(`Upload exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit`));
        (req as any).destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', reject);
  });

  const body = Buffer.concat(chunks);
  const bodyStr = body.toString('binary');
  const boundaryBuf = Buffer.from(boundary, 'utf8');

  const parts: Buffer[] = [];
  let start = 0;
  while (true) {
    const idx = bodyStr.indexOf(boundary, start);
    if (idx < 0) break;
    if (start > 0) {
      let end = idx;
      if (bodyStr[end - 1] === '\n') end--;
      if (bodyStr[end - 1] === '\r') end--;
      parts.push(body.slice(start, end));
    }
    start = idx + boundaryBuf.length;
    if (bodyStr[start] === '\r') start++;
    if (bodyStr[start] === '\n') start++;
    if (bodyStr.slice(idx + boundaryBuf.length, idx + boundaryBuf.length + 2) === '--') break;
  }

  let file: UploadedFile | null = null;
  const fields: Record<string, string> = {};

  for (const part of parts) {
    const partStr = part.toString('binary');
    const headerEnd = partStr.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headerSection = partStr.slice(0, headerEnd);
    const partData = part.slice(headerEnd + 4);

    const nameMatch = headerSection.match(/Content-Disposition:[^\r\n]*name="([^"]+)"/i);
    const filenameMatch = headerSection.match(/Content-Disposition:[^\r\n]*filename="([^"]+)"/i);
    const ctMatch = headerSection.match(/Content-Type:\s*([^\r\n]+)/i);

    const fieldName = nameMatch?.[1] ?? '';

    if (filenameMatch) {
      file = {
        filename: filenameMatch[1].trim(),
        mimeType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
        data: partData,
      };
    } else if (fieldName) {
      fields[fieldName] = partData.toString('utf8').trim();
    }
  }

  return { file, fields };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireMember(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
): Row | null {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const project = one<Row>('SELECT * FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (req.user.is_admin) return project;
  const member = one<Row>(
    'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    req.user.id,
  );
  if (!member) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  return project;
}

type VaultScope = 'project' | 'personal' | 'portal';

function vaultStorePath(
  scope: VaultScope,
  projectId: string | null,
  userId: string | null,
  fileId: string,
  filename: string,
): string {
  const safe = path.basename(filename).replace(/[^\w.\-]/g, '_').slice(0, 200);
  if (scope === 'portal') {
    return path.join(config.dataDir, 'vault', 'portal', `${fileId}-${safe}`);
  }
  if (scope === 'personal') {
    return path.join(
      config.dataDir,
      'vault',
      'projects',
      projectId!,
      'personal',
      `${fileId}-${safe}`,
    );
  }
  // project scope
  return path.join(
    config.dataDir,
    'vault',
    'projects',
    projectId!,
    'project',
    `${fileId}-${safe}`,
  );
}

function vaultRelPath(absPath: string): string {
  return path.relative(config.dataDir, absPath);
}

function mimeFromExt(filename: string): string {
  const MIME: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.zip': 'application/zip',
  };
  return MIME[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

async function doUpload(
  req: PortalRequest,
  res: PortalResponse,
  scope: VaultScope,
  projectId: string | null,
): Promise<void> {
  let parsed: Awaited<ReturnType<typeof readMultipartFile>>;
  try {
    parsed = await readMultipartFile(req as unknown as IncomingMessage, MAX_FILE);
  } catch (err: unknown) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  if (!parsed.file) {
    sendJson(res, 400, { error: 'No file in upload' });
    return;
  }

  const { filename, mimeType, data } = parsed.file;
  const effectiveScope: VaultScope = scope !== 'portal'
    ? ((parsed.fields.scope as VaultScope | undefined) ?? scope)
    : 'portal';

  const fileId = generateId();
  const userId = effectiveScope === 'personal' ? req.user!.id : null;
  const absPath = vaultStorePath(effectiveScope, projectId, userId, fileId, filename);
  const safeFilename = path.basename(filename).replace(/[^\w.\-]/g, '_').slice(0, 200);

  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, data);

  const relPath = vaultRelPath(absPath);

  insert('vault_files', {
    id: fileId,
    project_id: effectiveScope === 'portal' ? null : projectId,
    user_id: userId,
    name: safeFilename,
    path: relPath,
    size_bytes: data.length,
    mime_type: mimeType || mimeFromExt(filename),
    uploaded_by: req.user!.id,
    created_at: now(),
  });

  const vaultFile = one<Row>('SELECT * FROM vault_files WHERE id = ?', fileId);
  sendJson(res, 200, { vault_file: vaultFile });
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerVaultRoutes(): void {

  // ── Project-scoped vault ─────────────────────────────────────────────────

  // GET /api/projects/:id/vault
  router.get('/api/projects/:id/vault', (req: PortalRequest, res: PortalResponse): void => {
    const project = requireMember(req, res, req.params.id);
    if (!project) return;

    const scopeFilter = req.query.get('scope');
    const userId = req.user!.id;
    const projectId = req.params.id;

    if (scopeFilter === 'project') {
      const files = all<Row>(
        'SELECT * FROM vault_files WHERE project_id = ? AND user_id IS NULL ORDER BY created_at DESC',
        projectId,
      );
      sendJson(res, 200, { files });
      return;
    }
    if (scopeFilter === 'personal') {
      const files = all<Row>(
        'SELECT * FROM vault_files WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC',
        projectId,
        userId,
      );
      sendJson(res, 200, { files });
      return;
    }
    if (scopeFilter === 'portal') {
      const files = all<Row>(
        'SELECT * FROM vault_files WHERE project_id IS NULL ORDER BY created_at DESC',
      );
      sendJson(res, 200, { files });
      return;
    }

    // Return all three combined
    const files = all<Row>(
      `SELECT * FROM vault_files
        WHERE (project_id = ? AND user_id IS NULL)
           OR (project_id = ? AND user_id = ?)
           OR project_id IS NULL
        ORDER BY created_at DESC`,
      projectId,
      projectId,
      userId,
    );
    sendJson(res, 200, { files });
  });

  // POST /api/projects/:id/vault/upload
  router.post(
    '/api/projects/:id/vault/upload',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const project = requireMember(req, res, req.params.id);
      if (!project) return;
      await doUpload(req, res, 'project', req.params.id);
    },
  );

  // DELETE /api/projects/:id/vault/:fileId
  router.delete(
    '/api/projects/:id/vault/:fileId',
    (req: PortalRequest, res: PortalResponse): void => {
      const project = requireMember(req, res, req.params.id);
      if (!project) return;

      const vf = one<Row>(
        'SELECT * FROM vault_files WHERE id = ? AND project_id = ?',
        req.params.fileId,
        req.params.id,
      );
      if (!vf) {
        sendJson(res, 404, { error: 'File not found' });
        return;
      }

      // Check ownership for personal files
      if (vf.user_id && vf.user_id !== req.user!.id && !req.user!.is_admin) {
        sendJson(res, 403, { error: 'You can only delete your own files' });
        return;
      }

      // Delete from disk
      const absPath = path.join(config.dataDir, String(vf.path));
      try {
        fs.rmSync(absPath, { force: true });
      } catch {
        // non-fatal
      }

      run('DELETE FROM vault_files WHERE id = ?', req.params.fileId);
      sendJson(res, 200, { ok: true });
    },
  );

  // GET /api/projects/:id/vault/:fileId/download
  router.get(
    '/api/projects/:id/vault/:fileId/download',
    (req: PortalRequest, res: PortalResponse): void => {
      const project = requireMember(req, res, req.params.id);
      if (!project) return;

      const vf = one<Row>(
        `SELECT * FROM vault_files
          WHERE id = ?
            AND (project_id = ? OR project_id IS NULL)`,
        req.params.fileId,
        req.params.id,
      );
      if (!vf) {
        sendJson(res, 404, { error: 'File not found' });
        return;
      }

      const absPath = path.join(config.dataDir, String(vf.path));
      if (!fs.existsSync(absPath)) {
        sendJson(res, 404, { error: 'File not on disk' });
        return;
      }

      const stat = fs.statSync(absPath);
      const mime = String(vf.mime_type || 'application/octet-stream');
      const safeFilename = encodeURIComponent(String(vf.name));

      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${safeFilename}"`,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(absPath).pipe(res);
    },
  );

  // GET /api/projects/:id/vault/zip
  router.get('/api/projects/:id/vault/zip', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = requireMember(req, res, req.params.id);
    if (!project) return;

    const scope = (req.query.get('scope') as VaultScope | null) ?? 'project';
    const userId = req.user!.id;
    const projectId = req.params.id;

    let files: Row[];
    if (scope === 'portal') {
      files = all<Row>('SELECT * FROM vault_files WHERE project_id IS NULL');
    } else if (scope === 'personal') {
      files = all<Row>(
        'SELECT * FROM vault_files WHERE project_id = ? AND user_id = ?',
        projectId, userId,
      );
    } else {
      files = all<Row>(
        'SELECT * FROM vault_files WHERE project_id = ? AND user_id IS NULL',
        projectId,
      );
    }

    // Dynamically import JSZip
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();

    for (const f of files) {
      const absPath = path.join(config.dataDir, String(f.path));
      if (fs.existsSync(absPath)) {
        zip.file(String(f.name), fs.readFileSync(absPath));
      }
    }

    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="vault-${scope}.zip"`,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });

  // ── Portal-wide vault ─────────────────────────────────────────────────────

  // GET /api/vault
  router.get('/api/vault', (req: PortalRequest, res: PortalResponse): void => {
    if (!req.user?.is_admin) {
      sendJson(res, 403, { error: 'Admin only' });
      return;
    }
    const files = all<Row>(
      'SELECT * FROM vault_files WHERE project_id IS NULL ORDER BY created_at DESC',
    );
    sendJson(res, 200, { files });
  });

  // POST /api/vault/upload
  router.post('/api/vault/upload', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user?.is_admin) {
      sendJson(res, 403, { error: 'Admin only' });
      return;
    }
    await doUpload(req, res, 'portal', null);
  });
}
