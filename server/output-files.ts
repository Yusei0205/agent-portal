/**
 * Per-workflow output file collection and routes.
 *
 * Routes:
 *   GET /api/workflows/:id/output-files                       — list (latest version per path)
 *   GET /api/workflows/:id/output-files/:fileId/download      — stream file (falls back to Vault)
 *   GET /api/workflows/:id/output-files/:fileId/preview       — preview metadata
 *   GET /api/workflows/:id/output-files/zip                   — zip all
 *
 * collectOutputFiles(runId, workflowId, workDir, runStartedAt?)
 *   Called at the end of every run (success, failure and cancel).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { generateId, now } from './util.ts';
import { config } from './config.ts';
import { convertToMarkdown, pptxSlides } from './convert.ts';
import { emit } from './events.ts';
import { getSessionsRepository } from './repositories/sessions.ts';
import { getProjectRepository } from './repositories/projects.ts';
import { getVaultFilesRepository } from './repositories/vault-files.ts';
import { getOutputFilesRepository } from './repositories/output-files.ts';

// ── Extension allow-list ──────────────────────────────────────────────────────

const ALLOWED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.pdf',
  '.md', '.docx', '.xlsx', '.pptx', '.csv', '.html', '.drawio',
]);

const EXCLUDED_WORK_DIRS = new Set([
  'repos', 'home', '.browser', '.claude', '.kiro', '.git', 'node_modules',
]);

const SKELETON_FILES = new Set(['CLAUDE.md', 'docs/decisions.md']);

const MAX_FILES = 50;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

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
  '.webp':   'image/webp',
  '.html':   'text/html',
  '.md':     'text/markdown',
  '.txt':    'text/plain',
  '.json':   'application/json',
  '.yaml':   'text/yaml',
  '.yml':    'text/yaml',
  '.csv':    'text/csv',
  '.drawio': 'application/xml',
};

function mimeForExt(ext: string): string {
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

const INLINE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf',
]);

function buildContentDisposition(disposition: 'attachment' | 'inline', filename: string): string {
  const safe = filename.replace(/[\x00-\x1f]/g, '_');
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_');
  const escapedAscii = ascii.replace(/["\\]/g, '\\$&');
  if (ascii === safe) {
    return `${disposition}; filename="${escapedAscii}"`;
  }
  const encoded = encodeURIComponent(safe)
    .replace(/[*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${escapedAscii}"; filename*=UTF-8''${encoded}`;
}

function inlineCsp(mime: string): string {
  if (mime === 'application/pdf') {
    return "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
  }
  return "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
}

function hashFile(absPath: string): string {
  return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

// ── git helpers ───────────────────────────────────────────────────────────────

function spawnGitSafe(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const out: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.on('close', (code) => resolve(code === 0 ? Buffer.concat(out).toString('utf8') : ''));
    proc.on('error', () => resolve(''));
  });
}

function parseGitPorcelain(output: string, repoDir: string): string[] {
  const files: string[] = [];
  const entries = output.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    if (xy === '!!') continue;
    if (xy[0] === 'D' || xy[1] === 'D') continue;
    if (filePath && !filePath.endsWith('/')) files.push(path.join(repoDir, filePath));
  }
  return files;
}

async function collectFromRepo(repoDir: string): Promise<string[]> {
  const statusOut = await spawnGitSafe(['status', '--porcelain', '-z', '--untracked-files=all'], repoDir);
  const fromStatus = parseGitPorcelain(statusOut, repoDir);
  const logOut = await spawnGitSafe(
    ['log', '--pretty=format:', '--name-only', 'origin/HEAD..HEAD'],
    repoDir,
  );
  const fromLog: string[] = [];
  if (logOut) {
    for (const line of logOut.split('\n')) {
      const f = line.trim();
      if (f) fromLog.push(path.join(repoDir, f));
    }
  }
  return [...new Set([...fromStatus, ...fromLog])];
}

function collectFromWorkDir(workDir: string, cutoffMs: number): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (EXCLUDED_WORK_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        const rel = path.relative(workDir, full).replace(/\\/g, '/');
        if (SKELETON_FILES.has(rel)) continue;
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs >= cutoffMs) results.push(full);
        } catch { /* skip */ }
      }
    }
  };
  walk(workDir);
  return results;
}

// ── Vault helpers ─────────────────────────────────────────────────────────────

function computeVaultFolder(wf: { id: string; title?: string | null; goal?: string | null }): string {
  const raw = String(wf.title || wf.goal || '').trim();
  const sanitised = raw
    .replace(/[^\w\s.\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `Sessions/${sanitised || 'Session'} (${wf.id.slice(0, 8)})`;
}

function vaultDisplayNames(relPaths: string[]): Map<string, string> {
  const sorted = [...relPaths].sort();
  const usedCounts = new Map<string, number>();
  const result = new Map<string, string>();
  for (const relPath of sorted) {
    const base = path.basename(relPath);
    const ext = path.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    const count = (usedCounts.get(base) ?? 0) + 1;
    usedCounts.set(base, count);
    result.set(relPath, count === 1 ? base : `${stem} (${count})${ext}`);
  }
  return result;
}

interface VaultCandidate {
  id: string;
  relPath: string;
  absPath: string;
  mime: string;
  size: number;
}

async function copyToVault(
  workflowId: string,
  projectId: string,
  files: VaultCandidate[],
): Promise<void> {
  if (!files.length) return;

  const proj = await getProjectRepository().getProjectById(projectId);
  if (!proj || proj.vault_generated === 0) return;

  const wf = await getSessionsRepository().getWorkflowById(workflowId);
  if (!wf) return;

  const folder = computeVaultFolder(wf);
  const displayNames = vaultDisplayNames(files.map((f) => f.relPath));
  const vaultRepo = getVaultFilesRepository();
  const outputRepo = getOutputFilesRepository();

  for (const f of files) {
    const displayName = displayNames.get(f.relPath) ?? path.basename(f.relPath);
    const safeName = path.basename(displayName).replace(/[^\w.\-]/g, '_').slice(0, 200);

    try {
      const existing = await vaultRepo.findByWorkflowFolderName(projectId, folder, safeName, workflowId);

      if (existing) {
        const absVault = path.join(config.dataDir, existing.path);
        fs.mkdirSync(path.dirname(absVault), { recursive: true });
        fs.copyFileSync(f.absPath, absVault);
        await vaultRepo.updateSizeAndMime(existing.id, f.size, f.mime);
        await outputRepo.updateVaultFileId(f.id, existing.id);
      } else {
        const vaultFileId = generateId();
        const relVault = path.posix.join(
          'vault', 'projects', projectId, 'project', `${vaultFileId}-${safeName}`,
        );
        const absVault = path.join(config.dataDir, ...relVault.split('/'));
        fs.mkdirSync(path.dirname(absVault), { recursive: true });
        fs.copyFileSync(f.absPath, absVault);
        await vaultRepo.create({
          id: vaultFileId,
          project_id: projectId,
          user_id: null,
          name: safeName,
          path: relVault,
          size_bytes: f.size,
          mime_type: f.mime,
          uploaded_by: null,
          folder,
          source_workflow_id: workflowId,
          created_at: now(),
        });
        await outputRepo.updateVaultFileId(f.id, vaultFileId);
      }
    } catch {
      // Best effort
    }
  }
}

// ── Main collection function ──────────────────────────────────────────────────

export async function collectOutputFiles(
  runId: string,
  workflowId: string,
  workDir: string,
  runStartedAt: string = new Date(0).toISOString(),
): Promise<void> {
  if (!workDir || !fs.existsSync(workDir)) return;

  const wf = await getSessionsRepository().getWorkflowById(workflowId);
  if (!wf) return;

  const projectId = wf.project_id ? String(wf.project_id) : null;
  const cutoffMs = new Date(runStartedAt).getTime() || 0;

  const allCandidates: string[] = [];

  const reposDir = path.join(workDir, 'repos');
  if (fs.existsSync(reposDir)) {
    try {
      for (const entry of fs.readdirSync(reposDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const repoDir = path.join(reposDir, entry.name);
        if (fs.existsSync(path.join(repoDir, '.git'))) {
          const repoFiles = await collectFromRepo(repoDir);
          allCandidates.push(...repoFiles);
        }
      }
    } catch { /* skip */ }
  }

  const nonRepoFiles = collectFromWorkDir(workDir, cutoffMs);
  allCandidates.push(...nonRepoFiles);

  const unique = [...new Set(allCandidates)];

  let fileCount = 0;
  let totalBytes = 0;
  const vaultCandidates: VaultCandidate[] = [];
  const outputRepo = getOutputFilesRepository();

  for (const absPath of unique) {
    if (fileCount >= MAX_FILES) break;

    const ext = path.extname(absPath).toLowerCase();
    const name = path.basename(absPath);

    if (!ALLOWED_EXTS.has(ext)) continue;

    let stat: fs.Stats;
    try { stat = fs.statSync(absPath); } catch { continue; }

    const relPath = path.relative(workDir, absPath).replace(/\\/g, '/');

    if (stat.size > MAX_FILE_BYTES) {
      await outputRepo.create({
        id: generateId(),
        workflow_id: workflowId,
        run_id: runId,
        name,
        path: relPath,
        size_bytes: stat.size,
        mime_type: null,
        version: 1,
        refused_reason: `File exceeds 25 MB limit (${Math.round(stat.size / 1024 / 1024)} MB)`,
        hash: null,
        created_at: now(),
      });
      continue;
    }

    if (totalBytes + stat.size > MAX_TOTAL_BYTES) break;

    let hash: string;
    try { hash = hashFile(absPath); } catch { continue; }

    const existing = await outputRepo.getLatestByPath(workflowId, relPath);

    if (existing && existing.hash === hash) continue;

    const version = existing ? existing.version + 1 : 1;
    const mime = mimeForExt(ext);
    const fileId = generateId();

    await outputRepo.create({
      id: fileId,
      workflow_id: workflowId,
      run_id: runId,
      name,
      path: relPath,
      size_bytes: stat.size,
      mime_type: mime,
      version,
      refused_reason: null,
      hash,
      created_at: now(),
    });

    fileCount++;
    totalBytes += stat.size;
    vaultCandidates.push({ id: fileId, relPath, absPath, mime, size: stat.size });
  }

  if (vaultCandidates.length && projectId) {
    try { await copyToVault(workflowId, projectId, vaultCandidates); } catch { /* non-fatal */ }
  }

  if (projectId && fileCount > 0) {
    try {
      const count = await outputRepo.countByWorkflow(workflowId);
      emit(projectId, { type: 'output-files.updated', workflowId, count });
    } catch { /* non-fatal */ }
  }
}

// ── Access helper ─────────────────────────────────────────────────────────────

async function requireWorkflowAccess(
  req: PortalRequest,
  res: PortalResponse,
  workflowId: string,
) {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const wf = await getSessionsRepository().getWorkflowById(workflowId);
  if (!wf) {
    sendJson(res, 404, { error: 'Workflow not found' });
    return null;
  }
  if (req.user.is_admin) return wf;
  if (!wf.project_id) return wf;
  const member = await getProjectRepository().isMember(wf.project_id, req.user.id);
  if (!member) {
    sendJson(res, 403, { error: 'Not a project member' });
    return null;
  }
  return wf;
}

/**
 * Resolve the work directory for a workflow.
 */
async function resolveWorkDir(wf: { id: string; work_dir?: string | null; project_id?: string | null }): Promise<string | null> {
  if (wf.work_dir) return wf.work_dir;
  if (!wf.project_id) return null;
  const project = await getProjectRepository().getProjectById(wf.project_id);
  if (!project) return null;
  const latestRun = await getSessionsRepository().getLatestRun(wf.id);
  if (!latestRun) return null;
  return path.join(config.dataDir, 'projects', project.slug, 'work', latestRun.id);
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerOutputFileRoutes(): void {

  // GET /api/workflows/:id/output-files
  router.get(
    '/api/workflows/:id/output-files',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const wf = await requireWorkflowAccess(req, res, req.params.id);
      if (!wf) return;

      const files = await getOutputFilesRepository().listLatestByWorkflow(req.params.id);

      const enriched = files.map((f) => ({
        id: f.id,
        name: f.name,
        path: f.path,
        size_bytes: f.size_bytes,
        mime_type: f.mime_type,
        version: f.version,
        created_at: f.created_at,
        run_id: f.run_id,
        vault_file_id: f.vault_file_id ?? null,
        download_url: `/api/workflows/${req.params.id}/output-files/${f.id}/download`,
        preview_url: `/api/workflows/${req.params.id}/output-files/${f.id}/preview`,
      }));

      let vaultFolderName: string | null = null;
      if (wf.project_id) {
        const proj = await getProjectRepository().getProjectById(wf.project_id);
        if (!proj || proj.vault_generated !== 0) {
          vaultFolderName = computeVaultFolder(wf);
        }
      }

      sendJson(res, 200, { files: enriched, vaultFolder: vaultFolderName });
    },
  );

  // GET /api/workflows/:id/output-files/:fileId/download
  router.get(
    '/api/workflows/:id/output-files/:fileId/download',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const wf = await requireWorkflowAccess(req, res, req.params.id);
      if (!wf) return;

      const file = await getOutputFilesRepository().getById(req.params.fileId, req.params.id);
      if (!file) { sendJson(res, 404, { error: 'File not found' }); return; }
      if (file.refused_reason) { sendJson(res, 403, { error: file.refused_reason }); return; }

      const workDir = await resolveWorkDir(wf);
      const name = file.name;
      const ext  = path.extname(name).toLowerCase();
      const mime = String(file.mime_type || mimeForExt(ext) || 'application/octet-stream');

      const wantsInline = req.query.get('inline') === '1';
      const useInline   = wantsInline && INLINE_EXTS.has(ext);
      const disposition = useInline ? 'inline' : 'attachment';

      const tryServeAbsPath = (absPath: string): boolean => {
        if (!fs.existsSync(absPath)) return false;
        const stat = fs.statSync(absPath);
        const headers: Record<string, string | number> = {
          'Content-Type': mime,
          'Content-Length': stat.size,
          'Content-Disposition': buildContentDisposition(disposition, name),
          'Cache-Control': 'no-store',
        };
        if (useInline) {
          headers['X-Content-Type-Options'] = 'nosniff';
          headers['Content-Security-Policy'] = inlineCsp(mime);
        }
        res.writeHead(200, headers);
        fs.createReadStream(absPath).pipe(res);
        return true;
      };

      if (workDir) {
        const absPath = path.resolve(workDir, file.path);
        if (!absPath.startsWith(path.resolve(workDir))) {
          sendJson(res, 403, { error: 'Path traversal detected' });
          return;
        }
        if (tryServeAbsPath(absPath)) return;
      }

      if (file.vault_file_id) {
        const vf = await getVaultFilesRepository().getById(file.vault_file_id);
        if (vf) {
          const absVault = path.join(config.dataDir, vf.path);
          if (tryServeAbsPath(absVault)) return;
        }
      }

      sendJson(res, 404, { error: 'File not on disk' });
    },
  );

  // GET /api/workflows/:id/output-files/:fileId/preview
  router.get(
    '/api/workflows/:id/output-files/:fileId/preview',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const wf = await requireWorkflowAccess(req, res, req.params.id);
      if (!wf) return;

      const file = await getOutputFilesRepository().getById(req.params.fileId, req.params.id);
      if (!file) { sendJson(res, 404, { error: 'File not found' }); return; }
      if (file.refused_reason) { sendJson(res, 403, { error: file.refused_reason }); return; }

      let absPath: string | null = null;
      const workDir = await resolveWorkDir(wf);
      if (workDir) {
        const candidate = path.resolve(workDir, file.path);
        if (candidate.startsWith(path.resolve(workDir)) && fs.existsSync(candidate)) {
          absPath = candidate;
        }
      }
      if (!absPath && file.vault_file_id) {
        const vf = await getVaultFilesRepository().getById(file.vault_file_id);
        if (vf) {
          const candidate = path.join(config.dataDir, vf.path);
          if (fs.existsSync(candidate)) absPath = candidate;
        }
      }

      if (!absPath) { sendJson(res, 200, { type: 'none' }); return; }

      const ext = path.extname(file.name).toLowerCase();
      const mime = String(file.mime_type || mimeForExt(ext));
      const name = file.name;
      const downloadUrl = `/api/workflows/${req.params.id}/output-files/${req.params.fileId}/download`;
      const inlineUrl   = `${downloadUrl}?inline=1`;

      if (ext === '.pdf' || mime.includes('pdf')) {
        sendJson(res, 200, { type: 'inline', url: inlineUrl, mime: 'application/pdf', name });
        return;
      }
      if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)) {
        sendJson(res, 200, { type: 'inline', url: inlineUrl, mime, name });
        return;
      }
      if (ext === '.pptx') {
        try {
          const slides = await pptxSlides(absPath);
          sendJson(res, 200, { type: 'pptx', slides });
        } catch {
          sendJson(res, 200, { type: 'none' });
        }
        return;
      }
      if (ext === '.docx' || ext === '.xlsx') {
        try {
          const content = await convertToMarkdown(absPath, mime);
          sendJson(res, 200, { type: 'markdown', content });
        } catch {
          sendJson(res, 200, { type: 'none' });
        }
        return;
      }
      if (['.md', '.csv', '.html', '.xml', '.txt', '.json', '.yaml', '.yml'].includes(ext)) {
        try {
          const TEXT_PREVIEW_LIMIT = 512 * 1024;
          const buf = fs.readFileSync(absPath);
          const truncated = buf.length > TEXT_PREVIEW_LIMIT;
          const content = buf.slice(0, TEXT_PREVIEW_LIMIT).toString('utf8');
          sendJson(res, 200, { type: 'text', content, truncated });
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
      const wf = await requireWorkflowAccess(req, res, req.params.id);
      if (!wf) return;

      const files = await getOutputFilesRepository().listLatestByWorkflow(req.params.id);
      const workDir = await resolveWorkDir(wf);
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      for (const f of files) {
        let content: Buffer | null = null;
        if (workDir) {
          const absPath = path.resolve(workDir, f.path);
          if (absPath.startsWith(path.resolve(workDir)) && fs.existsSync(absPath)) {
            try { content = fs.readFileSync(absPath); } catch { /* skip */ }
          }
        }
        if (!content && f.vault_file_id) {
          const vf = await getVaultFilesRepository().getById(f.vault_file_id);
          if (vf) {
            const absVault = path.join(config.dataDir, vf.path);
            if (fs.existsSync(absVault)) {
              try { content = fs.readFileSync(absVault); } catch { /* skip */ }
            }
          }
        }
        if (content) zip.file(f.name, content);
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
