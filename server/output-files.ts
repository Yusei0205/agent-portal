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
 *   Detects outputs two ways:
 *     - repos/ subdirectories: git status --porcelain (untracked + modified)
 *       plus git log since origin/HEAD for committed files.
 *     - Everything else in workDir: files whose mtime >= runStartedAt.
 *   Allowed extensions: png, jpg, jpeg, gif, svg, pdf, md, docx, xlsx, pptx, csv, html, drawio.
 *   Skips files whose content hash matches the last recorded version (no duplicate rows).
 *   Copies eligible files to the project Vault under a per-session folder.
 *   Emits output-files.updated on the project SSE channel.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { all, one, run, insert } from './db.ts';
import type { Row } from './db.ts';
import { generateId, now } from './util.ts';
import { config } from './config.ts';
import { convertToMarkdown, pptxSlides } from './convert.ts';
import { emit } from './events.ts';

// ── Extension allow-list (document / image files only) ────────────────────────

// Collected as outputs: documents and images only (user decision, 2026-11-01).
// .txt/.json/.yaml are previewable but deliberately NOT collected, because agents
// routinely edit config files such as package.json or cdk.json.
const ALLOWED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.pdf',
  '.md', '.docx', '.xlsx', '.pptx', '.csv', '.html', '.drawio',
]);

// ── Internal directories that must never be treated as session outputs ────────
// repos/  — handled separately via git status
// home/   — materialised user config (contains decrypted .aws, .kiro, .claude)
// .browser — browser-automation state
// .claude — skills / agent config copied in at run start
// .kiro   — kiro config copied in at run start
// .git, node_modules — never outputs

const EXCLUDED_WORK_DIRS = new Set([
  'repos', 'home', '.browser', '.claude', '.kiro', '.git', 'node_modules',
]);

// Project skeleton files the portal copies into every new session work dir
// (server/workflows/working-copies.ts). They are inputs, not outputs.
const SKELETON_FILES = new Set(['CLAUDE.md', 'docs/decisions.md']);

// ── File limits ───────────────────────────────────────────────────────────────

const MAX_FILES = 50;
const MAX_FILE_BYTES = 25 * 1024 * 1024;   // 25 MB per file
const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB total

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

// ── Inline-eligible extensions ────────────────────────────────────────────────

const INLINE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf',
]);

// ── Content-Disposition builder (RFC 6266 / RFC 5987) ────────────────────────

/**
 * Build a Content-Disposition header value that is safe for non-ASCII filenames.
 *
 * Pure-ASCII names:  disposition; filename="<escaped>"
 * Non-ASCII names:   disposition; filename="<ascii-fallback>"; filename*=UTF-8''<rfc5987>
 *
 * The legacy `filename=` uses an ASCII fallback (non-ASCII replaced with `_`)
 * so older clients get a reasonable name. Modern clients use `filename*=`.
 */
function buildContentDisposition(disposition: 'attachment' | 'inline', filename: string): string {
  const safe = filename.replace(/[\x00-\x1f]/g, '_');
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_');
  const escapedAscii = ascii.replace(/["\\]/g, '\\$&');
  if (ascii === safe) {
    return `${disposition}; filename="${escapedAscii}"`;
  }
  // RFC 5987 percent-encoding: encode everything except attr-char.
  // encodeURIComponent leaves !, ~, *, ', ( ) — encode the disallowed ones.
  const encoded = encodeURIComponent(safe)
    .replace(/[*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${escapedAscii}"; filename*=UTF-8''${encoded}`;
}

// ── CSP for inline responses ──────────────────────────────────────────────────

/**
 * Return a tight Content-Security-Policy for directly-opened inline files.
 *
 * SVG and raster images get `sandbox` — SVG can embed scripts, and sandbox
 * is the strongest containment available at the document level.
 *
 * PDF intentionally omits `sandbox` so Chrome's native PDF viewer is not
 * blocked (the viewer runs as a privileged process, not as a sandboxed iframe,
 * but the CSP `sandbox` directive still restricts the outer page in a way that
 * can prevent the viewer from initialising in some Chrome versions).
 */
function inlineCsp(mime: string): string {
  if (mime === 'application/pdf') {
    return "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
  }
  return "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
}

// ── File hash ─────────────────────────────────────────────────────────────────

function hashFile(absPath: string): string {
  return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

// ── git helpers ───────────────────────────────────────────────────────────────

/** Run a git command without a shell; resolve to '' on any error. */
function spawnGitSafe(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const out: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.on('close', (code) => resolve(code === 0 ? Buffer.concat(out).toString('utf8') : ''));
    proc.on('error', () => resolve(''));
  });
}

/**
 * Parse `git status --porcelain -z` output and return absolute paths.
 * Entries are NUL-separated, so paths with spaces or quotes are safe.
 * For renames and copies (`R`/`C`) the entry holds the new path and the next
 * entry is the old path, which is skipped. Ignored and deleted files are skipped.
 */
function parseGitPorcelain(output: string, repoDir: string): string[] {
  const files: string[] = [];
  const entries = output.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++;          // skip the old path
    if (xy === '!!') continue;                        // ignored
    if (xy[0] === 'D' || xy[1] === 'D') continue;    // deleted
    if (filePath && !filePath.endsWith('/')) files.push(path.join(repoDir, filePath));
  }
  return files;
}

/**
 * Collect output-eligible files from a git working copy.
 * Uses git status (modified + every untracked file, not just new folders) plus
 * git log for any commits made since the remote origin baseline (best effort).
 */
async function collectFromRepo(repoDir: string): Promise<string[]> {
  const statusOut = await spawnGitSafe(['status', '--porcelain', '-z', '--untracked-files=all'], repoDir);
  const fromStatus = parseGitPorcelain(statusOut, repoDir);

  // Files committed since origin/HEAD (cheap baseline — fails gracefully)
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

  // Union, deduped
  return [...new Set([...fromStatus, ...fromLog])];
}

/**
 * Walk workDir (excluding EXCLUDED_WORK_DIRS) and return absolute paths of
 * files whose mtime is >= cutoffMs.
 */
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

/**
 * Build the vault folder name for a workflow.
 * Format: "Sessions/<title or goal, sanitised> (<first 8 chars of workflowId>)"
 */
function computeVaultFolder(wf: Row): string {
  const raw = String(wf.title || wf.goal || '').trim();
  const sanitised = raw
    .replace(/[^\w\s.\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `Sessions/${sanitised || 'Session'} (${String(wf.id).slice(0, 8)})`;
}

/**
 * Compute a unique vault display name for every file in the list.
 * Files are sorted by path first so the mapping is deterministic.
 * When two files share the same basename, the second gets "(2)" suffix, etc.
 */
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
  id: string;         // output_files.id
  relPath: string;    // relative to workDir, forward slashes
  absPath: string;
  mime: string;
  size: number;
}

/**
 * Copy output files to the project Vault.
 * - Respects the project's vault_generated flag (default on).
 * - Creates one vault_files row per unique display name in the session folder.
 * - If the row already exists (same folder + name + workflow), overwrites the
 *   physical file and updates size_bytes (replace-in-place, same id).
 * - Updates output_files.vault_file_id for each copied file.
 * - Best-effort: individual errors are silently swallowed.
 */
async function copyToVault(
  workflowId: string,
  projectId: string,
  files: VaultCandidate[],
): Promise<void> {
  if (!files.length) return;

  const proj = one<{ vault_generated: number | null }>(
    'SELECT vault_generated FROM projects WHERE id = ?',
    projectId,
  );
  if (!proj || proj.vault_generated === 0) return;

  const wf = one<Row>('SELECT id, title, goal FROM p6_workflows WHERE id = ?', workflowId);
  if (!wf) return;

  const folder = computeVaultFolder(wf);
  const displayNames = vaultDisplayNames(files.map((f) => f.relPath));

  for (const f of files) {
    const displayName = displayNames.get(f.relPath) ?? path.basename(f.relPath);
    const safeName = path.basename(displayName).replace(/[^\w.\-]/g, '_').slice(0, 200);

    try {
      const existing = one<Row>(
        `SELECT id, path FROM vault_files
          WHERE project_id = ? AND folder = ? AND name = ? AND source_workflow_id = ?`,
        projectId,
        folder,
        safeName,
        workflowId,
      );

      if (existing) {
        // Replace in place: overwrite file on disk, update size/mime
        const absVault = path.join(config.dataDir, String(existing.path));
        fs.mkdirSync(path.dirname(absVault), { recursive: true });
        fs.copyFileSync(f.absPath, absVault);
        run(
          'UPDATE vault_files SET size_bytes = ?, mime_type = ? WHERE id = ?',
          f.size, f.mime, String(existing.id),
        );
        run('UPDATE output_files SET vault_file_id = ? WHERE id = ?', String(existing.id), f.id);
      } else {
        // Create new vault_files row
        const vaultFileId = generateId();
        const relVault = path.posix.join(
          'vault', 'projects', projectId, 'project', `${vaultFileId}-${safeName}`,
        );
        const absVault = path.join(config.dataDir, ...relVault.split('/'));
        fs.mkdirSync(path.dirname(absVault), { recursive: true });
        fs.copyFileSync(f.absPath, absVault);
        insert('vault_files', {
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
        run('UPDATE output_files SET vault_file_id = ? WHERE id = ?', vaultFileId, f.id);
      }
    } catch {
      // Best effort — vault copy failure must not propagate
    }
  }
}

// ── Main collection function ──────────────────────────────────────────────────

/**
 * Collect output files produced during a run and save them to output_files.
 * Called by the runner at the end of every run (success, failure, cancel).
 *
 * @param runId          The run whose output is being collected.
 * @param workflowId     The workflow owning this run.
 * @param workDir        Absolute path to the session's persistent work directory.
 * @param runStartedAt   ISO timestamp of when the run started (used as mtime
 *                       cutoff for non-repo files). Defaults to epoch (collect all).
 */
export async function collectOutputFiles(
  runId: string,
  workflowId: string,
  workDir: string,
  runStartedAt: string = new Date(0).toISOString(),
): Promise<void> {
  if (!workDir || !fs.existsSync(workDir)) return;

  const wf = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', workflowId);
  if (!wf) return;

  const projectId = wf.project_id ? String(wf.project_id) : null;
  const cutoffMs = new Date(runStartedAt).getTime() || 0;

  // ── 1. Collect candidate absolute paths ─────────────────────────────────────

  const allCandidates: string[] = [];

  // Repo working copies: detect via git status + git log
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

  // Non-repo work dir files: scan by mtime
  const nonRepoFiles = collectFromWorkDir(workDir, cutoffMs);
  allCandidates.push(...nonRepoFiles);

  // Dedup
  const unique = [...new Set(allCandidates)];

  // ── 2. Filter, hash, record ──────────────────────────────────────────────────

  let fileCount = 0;
  let totalBytes = 0;
  const vaultCandidates: VaultCandidate[] = [];

  for (const absPath of unique) {
    if (fileCount >= MAX_FILES) break;

    const ext = path.extname(absPath).toLowerCase();
    const name = path.basename(absPath);

    if (!ALLOWED_EXTS.has(ext)) continue;

    let stat: fs.Stats;
    try { stat = fs.statSync(absPath); } catch { continue; }

    // Relative path, always forward slashes
    const relPath = path.relative(workDir, absPath).replace(/\\/g, '/');

    if (stat.size > MAX_FILE_BYTES) {
      insert('output_files', {
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
        vault_file_id: null,
        created_at: now(),
      });
      continue;
    }

    if (totalBytes + stat.size > MAX_TOTAL_BYTES) break;

    let hash: string;
    try { hash = hashFile(absPath); } catch { continue; }

    // Check for existing row by path (latest version)
    const existing = one<Row>(
      `SELECT id, version, hash FROM output_files
        WHERE workflow_id = ? AND path = ? AND refused_reason IS NULL
        ORDER BY version DESC LIMIT 1`,
      workflowId,
      relPath,
    );

    // Skip if content is identical
    if (existing && existing.hash === hash) continue;

    const version = existing ? (existing.version as number) + 1 : 1;
    const mime = mimeForExt(ext);
    const fileId = generateId();

    insert('output_files', {
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
      vault_file_id: null,
      created_at: now(),
    });

    fileCount++;
    totalBytes += stat.size;
    vaultCandidates.push({ id: fileId, relPath, absPath, mime, size: stat.size });
  }

  // ── 3. Vault copy ────────────────────────────────────────────────────────────

  if (vaultCandidates.length && projectId) {
    try { await copyToVault(workflowId, projectId, vaultCandidates); } catch { /* non-fatal */ }
  }

  // ── 4. SSE notification ──────────────────────────────────────────────────────

  if (projectId && fileCount > 0) {
    try {
      const countRow = one<{ c: number }>(
        'SELECT COUNT(*) AS c FROM output_files WHERE workflow_id = ? AND refused_reason IS NULL',
        workflowId,
      );
      emit(projectId, {
        type: 'output-files.updated',
        workflowId,
        count: Number(countRow?.c ?? 0),
      });
    } catch { /* non-fatal */ }
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

/**
 * Resolve the work directory for a workflow.
 * Uses the persistent work_dir column (M21+); falls back to a path derived
 * from the latest run's id for pre-M21 workflows.
 */
function resolveWorkDir(wf: Row): string | null {
  if (wf.work_dir) return String(wf.work_dir);
  if (!wf.project_id) return null;
  const project = one<Row>('SELECT slug FROM projects WHERE id = ?', wf.project_id as string);
  if (!project) return null;
  const latestRun = one<Row>(
    'SELECT id FROM p6_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1',
    String(wf.id),
  );
  if (!latestRun) return null;
  return path.join(config.dataDir, 'projects', String(project.slug), 'work', String(latestRun.id));
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerOutputFileRoutes(): void {

  // GET /api/workflows/:id/output-files
  router.get(
    '/api/workflows/:id/output-files',
    (req: PortalRequest, res: PortalResponse): void => {
      const wf = requireWorkflowAccess(req, res, req.params.id);
      if (!wf) return;

      // Latest version per path, excluding refused files
      const files = all<Row>(
        `SELECT of1.*
           FROM output_files of1
          WHERE of1.workflow_id = ?
            AND of1.refused_reason IS NULL
            AND of1.version = (
              SELECT MAX(of2.version)
                FROM output_files of2
               WHERE of2.workflow_id = of1.workflow_id
                 AND of2.path = of1.path
                 AND of2.refused_reason IS NULL
            )
          ORDER BY of1.created_at DESC`,
        req.params.id,
      );

      // Build response with computed URL fields
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

      // Compute the vault folder for this session
      let vaultFolderName: string | null = null;
      if (wf.project_id) {
        const proj = one<{ vault_generated: number | null }>(
          'SELECT vault_generated FROM projects WHERE id = ?',
          String(wf.project_id),
        );
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
    (req: PortalRequest, res: PortalResponse): void => {
      const wf = requireWorkflowAccess(req, res, req.params.id);
      if (!wf) return;

      const file = one<Row>(
        'SELECT * FROM output_files WHERE id = ? AND workflow_id = ?',
        req.params.fileId,
        req.params.id,
      );
      if (!file) { sendJson(res, 404, { error: 'File not found' }); return; }
      if (file.refused_reason) { sendJson(res, 403, { error: String(file.refused_reason) }); return; }

      const workDir = resolveWorkDir(wf);
      const name = String(file.name);
      const ext  = path.extname(name).toLowerCase();
      const mime = String(file.mime_type || mimeForExt(ext) || 'application/octet-stream');

      // ?inline=1 — only honoured for images and PDF
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

      // Try work dir first
      if (workDir) {
        const absPath = path.resolve(workDir, String(file.path));
        if (!absPath.startsWith(path.resolve(workDir))) {
          sendJson(res, 403, { error: 'Path traversal detected' });
          return;
        }
        if (tryServeAbsPath(absPath)) return;
      }

      // Fall back to vault copy
      if (file.vault_file_id) {
        const vf = one<Row>('SELECT * FROM vault_files WHERE id = ?', file.vault_file_id as string);
        if (vf) {
          const absVault = path.join(config.dataDir, String(vf.path));
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
      const wf = requireWorkflowAccess(req, res, req.params.id);
      if (!wf) return;

      const file = one<Row>(
        'SELECT * FROM output_files WHERE id = ? AND workflow_id = ?',
        req.params.fileId,
        req.params.id,
      );
      if (!file) { sendJson(res, 404, { error: 'File not found' }); return; }
      if (file.refused_reason) { sendJson(res, 403, { error: String(file.refused_reason) }); return; }

      // Resolve actual file path (work dir, then vault fallback)
      let absPath: string | null = null;
      const workDir = resolveWorkDir(wf);
      if (workDir) {
        const candidate = path.resolve(workDir, String(file.path));
        if (candidate.startsWith(path.resolve(workDir)) && fs.existsSync(candidate)) {
          absPath = candidate;
        }
      }
      if (!absPath && file.vault_file_id) {
        const vf = one<Row>('SELECT * FROM vault_files WHERE id = ?', file.vault_file_id as string);
        if (vf) {
          const candidate = path.join(config.dataDir, String(vf.path));
          if (fs.existsSync(candidate)) absPath = candidate;
        }
      }

      if (!absPath) { sendJson(res, 200, { type: 'none' }); return; }

      const ext = path.extname(String(file.name)).toLowerCase();
      const mime = String(file.mime_type || mimeForExt(ext));
      const name = String(file.name);
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
                 AND of2.path = of1.path
                 AND of2.refused_reason IS NULL
            )
          ORDER BY of1.created_at DESC`,
        req.params.id,
      );

      const workDir = resolveWorkDir(wf);
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      for (const f of files) {
        // Try work dir first, then vault fallback
        let content: Buffer | null = null;
        if (workDir) {
          const absPath = path.resolve(workDir, String(f.path));
          if (absPath.startsWith(path.resolve(workDir)) && fs.existsSync(absPath)) {
            try { content = fs.readFileSync(absPath); } catch { /* skip */ }
          }
        }
        if (!content && f.vault_file_id) {
          const vf = one<Row>('SELECT * FROM vault_files WHERE id = ?', f.vault_file_id as string);
          if (vf) {
            const absVault = path.join(config.dataDir, String(vf.path));
            if (fs.existsSync(absVault)) {
              try { content = fs.readFileSync(absVault); } catch { /* skip */ }
            }
          }
        }
        if (content) zip.file(String(f.name), content);
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
