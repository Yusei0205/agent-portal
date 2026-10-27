/**
 * Per-workflow output file collection and routes.
 *
 * Routes:
 *   GET /api/workflows/:id/output-files                       — list (latest version per name)
 *   GET /api/workflows/:id/output-files/:fileId/download      — stream file
 *   GET /api/workflows/:id/output-files/:fileId/preview       — preview metadata
 *   GET /api/workflows/:id/output-files/zip                   — zip all
 *
 * collectOutputFiles(runId, workflowId, workDir)
 *   Scans workDir/output/ (max depth 3), collects allowed extensions,
 *   refuses executables and oversized files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { all, one, run, insert } from './db.ts';
import type { Row } from './db.ts';
import { generateId, now, badRequest, notFound } from './util.ts';
import { config } from './config.ts';
import { convertToMarkdown, pptxSlides } from './convert.ts';

// ── Extension allow/deny lists ────────────────────────────────────────────────

const ALLOWED_EXTS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.csv',
  '.docx', '.xlsx', '.pptx', '.pdf',
  '.png', '.jpg', '.jpeg', '.svg', '.drawio', '.html',
]);

const REFUSED_EXTS = new Set([
  '.sh', '.bat', '.cmd', '.exe', '.ps1', '.py', '.js', '.ts',
]);

// ── File collection limits ────────────────────────────────────────────────────

const MAX_FILES = 50;
const MAX_FILE_BYTES = 25 * 1024 * 1024;    // 25 MB per file
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;  // 100 MB total

// ── MIME helpers ──────────────────────────────────────────────────────────────

const EXT_MIME: Record<string, string> = {
  '.pdf':    'application/pdf',
  '.docx':   'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx':   'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx':   'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png':    'image/png',
  '.jpg':    'image/jpeg',
  '.jpeg':   'image/jpeg',
  '.svg':    'image/svg+xml',
  '.gif':    'image/gif',
  '.html':   'text/html',
  '.txt':    'text/plain',
  '.md':     'text/markdown',
  '.json':   'application/json',
  '.yaml':   'text/yaml',
  '.yml':    'text/yaml',
  '.csv':    'text/csv',
  '.drawio': 'application/xml',
};

function mimeForExt(ext: string): string {
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

// ── File scanner ──────────────────────────────────────────────────────────────

function scanDir(dir: string, depth: number, maxDepth: number, results: string[]): void {
  if (depth > maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      scanDir(full, depth + 1, maxDepth, results);
    } else if (e.isFile()) {
      results.push(full);
    }
  }
}

// ── collectOutputFiles ────────────────────────────────────────────────────────

export async function collectOutputFiles(
  runId: string,
  workflowId: string,
  workDir: string,
): Promise<void> {
  const outputDir = path.join(workDir, 'output');
  if (!fs.existsSync(outputDir)) return;

  const allFiles: string[] = [];
  scanDir(outputDir, 0, 3, allFiles);

  let fileCount = 0;
  let totalBytes = 0;

  for (const absPath of allFiles) {
    if (fileCount >= MAX_FILES) break;

    const ext = path.extname(absPath).toLowerCase();
    const name = path.basename(absPath);

    // Executables/scripts — always refused (store row with refused_reason)
    if (REFUSED_EXTS.has(ext)) {
      const fileId = generateId();
      insert('output_files', {
        id: fileId,
        workflow_id: workflowId,
        run_id: runId,
        name,
        path: path.relative(workDir, absPath),
        size_bytes: 0,
        mime_type: null,
        version: 1,
        refused_reason: `Files of type ${ext} are not allowed for security reasons`,
        created_at: now(),
      });
      continue;
    }

    // Skip unrecognised extensions silently
    if (!ALLOWED_EXTS.has(ext)) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }

    // Over 25 MB — refused
    if (stat.size > MAX_FILE_BYTES) {
      const fileId = generateId();
      insert('output_files', {
        id: fileId,
        workflow_id: workflowId,
        run_id: runId,
        name,
        path: path.relative(workDir, absPath),
        size_bytes: stat.size,
        mime_type: null,
        version: 1,
        refused_reason: `File exceeds 25 MB limit (${Math.round(stat.size / 1024 / 1024)} MB)`,
        created_at: now(),
      });
      continue;
    }

    if (totalBytes + stat.size > MAX_TOTAL_BYTES) break;

    // Check for existing row with same name to set version
    const existing = all<Row>(
      'SELECT version FROM output_files WHERE workflow_id = ? AND name = ? AND refused_reason IS NULL ORDER BY version DESC LIMIT 1',
      workflowId,
      name,
    );
    const version = existing.length > 0 ? (existing[0].version as number) + 1 : 1;

    const fileId = generateId();
    const relPath = path.relative(workDir, absPath);

    insert('output_files', {
      id: fileId,
      workflow_id: workflowId,
      run_id: runId,
      name,
      path: relPath,
      size_bytes: stat.size,
      mime_type: mimeForExt(ext),
      version,
      refused_reason: null,
      created_at: now(),
    });

    fileCount++;
    totalBytes += stat.size;
  }
}

// ── Access helper ─────────────────────────────────────────────────────────────

function requireWorkflowAccess(
  req: PortalRequest,
  res: PortalResponse,
  workflowId: string,
): Row | null {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const wf = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', workflowId);
  if (!wf) {
    sendJson(res, 404, { error: 'Workflow not found' });
    return null;
  }
  if (req.user.is_admin) return wf;
  if (!wf.project_id) return wf;
  const member = one<Row>(
    'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
    wf.project_id as string,
    req.user.id,
  );
  if (!member) {
    sendJson(res, 403, { error: 'Not a project member' });
    return null;
  }
  return wf;
}

function resolveRunWorkDir(wf: Row, runId: string): string | null {
  if (!wf.project_id) return null;
  const project = one<Row>('SELECT slug FROM projects WHERE id = ?', wf.project_id as string);
  if (!project) return null;
  return path.join(config.dataDir, 'projects', String(project.slug), 'work', runId);
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerOutputFileRoutes(): void {

  // GET /api/workflows/:id/output-files
  router.get(
    '/api/workflows/:id/output-files',
    (req: PortalRequest, res: PortalResponse): void => {
      const wf = requireWorkflowAccess(req, res, req.params.id);
      if (!wf) return;

      // Latest version per filename, excluding refused files
      const files = all<Row>(
        `SELECT of1.*
           FROM output_files of1
          WHERE of1.workflow_id = ?
            AND of1.refused_reason IS NULL
            AND of1.version = (
              SELECT MAX(of2.version)
                FROM output_files of2
               WHERE of2.workflow_id = of1.workflow_id
                 AND of2.name = of1.name
                 AND of2.refused_reason IS NULL
            )
          ORDER BY of1.created_at DESC`,
        req.params.id,
      );

      sendJson(res, 200, { files });
    },
  );

  // GET /api/workflows/:id/output-files/:fileId/download
  router.get(
    '/api/workflows/:id/output-files/:fileId/download',
    (req: PortalRequest, res: PortalResponse): void => {
      const wf = requireWorkflowAccess(req, res, req.params.id);
      if (!wf) return;

      const file = one<Row>(
        'SELECT * FROM output_files WHERE id = ? AND workflow_id = ?',
        req.params.fileId,
        req.params.id,
      );
      if (!file) {
        sendJson(res, 404, { error: 'File not found' });
        return;
      }
      if (file.refused_reason) {
        sendJson(res, 403, { error: String(file.refused_reason) });
        return;
      }

      // Resolve absolute path using the run's work dir
      const run = one<Row>('SELECT * FROM p6_runs WHERE id = ?', file.run_id as string);
      if (!run) {
        sendJson(res, 404, { error: 'Run not found' });
        return;
      }
      const workDir = resolveRunWorkDir(wf, String(file.run_id));
      if (!workDir) {
        sendJson(res, 404, { error: 'Work directory not found' });
        return;
      }
      const absPath = path.resolve(workDir, String(file.path));
      if (!absPath.startsWith(path.resolve(workDir))) {
        sendJson(res, 403, { error: 'Path traversal detected' });
        return;
      }
      if (!fs.existsSync(absPath)) {
        sendJson(res, 404, { error: 'File not on disk' });
        return;
      }

      const stat = fs.statSync(absPath);
      const mime = String(file.mime_type || 'application/octet-stream');
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(String(file.name))}"`,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(absPath).pipe(res);
    },
  );

  // GET /api/workflows/:id/output-files/:fileId/preview
  router.get(
    '/api/workflows/:id/output-files/:fileId/preview',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const wf = requireWorkflowAccess(req, res, req.params.id);
      if (!wf) return;

      const file = one<Row>(
        'SELECT * FROM output_files WHERE id = ? AND workflow_id = ?',
        req.params.fileId,
        req.params.id,
      );
      if (!file) {
        sendJson(res, 404, { error: 'File not found' });
        return;
      }
      if (file.refused_reason) {
        sendJson(res, 403, { error: String(file.refused_reason) });
        return;
      }

      const workDir = resolveRunWorkDir(wf, String(file.run_id));
      if (!workDir) {
        sendJson(res, 200, { type: 'none' });
        return;
      }
      const absPath = path.resolve(workDir, String(file.path));
      if (!absPath.startsWith(path.resolve(workDir)) || !fs.existsSync(absPath)) {
        sendJson(res, 200, { type: 'none' });
        return;
      }

      const ext = path.extname(String(file.name)).toLowerCase();
      const mime = String(file.mime_type || mimeForExt(ext));
      const name = String(file.name);
      const downloadUrl = `/api/workflows/${req.params.id}/output-files/${req.params.fileId}/download`;

      // PDF
      if (ext === '.pdf' || mime.includes('pdf')) {
        sendJson(res, 200, { type: 'inline', url: downloadUrl, mime: 'application/pdf', name });
        return;
      }

      // Images
      if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)) {
        sendJson(res, 200, { type: 'inline', url: downloadUrl, mime, name });
        return;
      }

      // PPTX — extract slide text
      if (ext === '.pptx') {
        try {
          const slides = await pptxSlides(absPath);
          sendJson(res, 200, { type: 'pptx', slides });
        } catch {
          sendJson(res, 200, { type: 'none' });
        }
        return;
      }

      // DOCX / XLSX — convert to markdown
      if (ext === '.docx' || ext === '.xlsx') {
        try {
          const content = await convertToMarkdown(absPath, mime);
          sendJson(res, 200, { type: 'markdown', content });
        } catch {
          sendJson(res, 200, { type: 'none' });
        }
        return;
      }

      // Text / Markdown
      if (['.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.html', '.xml'].includes(ext)) {
        try {
          const content = fs.readFileSync(absPath, 'utf8');
          sendJson(res, 200, { type: 'text', content });
        } catch {
          sendJson(res, 200, { type: 'none' });
        }
        return;
      }

      sendJson(res, 200, { type: 'none' });
    },
  );

  // GET /api/workflows/:id/output-files/zip
  router.get(
    '/api/workflows/:id/output-files/zip',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const wf = requireWorkflowAccess(req, res, req.params.id);
      if (!wf) return;

      const files = all<Row>(
        `SELECT of1.*
           FROM output_files of1
          WHERE of1.workflow_id = ?
            AND of1.refused_reason IS NULL
            AND of1.version = (
              SELECT MAX(of2.version)
                FROM output_files of2
               WHERE of2.workflow_id = of1.workflow_id
                 AND of2.name = of1.name
                 AND of2.refused_reason IS NULL
            )
          ORDER BY of1.created_at DESC`,
        req.params.id,
      );

      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      for (const f of files) {
        const workDir = resolveRunWorkDir(wf, String(f.run_id));
        if (!workDir) continue;
        const absPath = path.resolve(workDir, String(f.path));
        if (!absPath.startsWith(path.resolve(workDir))) continue;
        if (fs.existsSync(absPath)) {
          zip.file(String(f.name), fs.readFileSync(absPath));
        }
      }

      const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': buf.length,
        'Content-Disposition': 'attachment; filename="output-files.zip"',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    },
  );
}
