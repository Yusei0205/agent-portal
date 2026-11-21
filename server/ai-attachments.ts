/**
 * AI Attachment upload, storage, and helpers.
 *
 * Attachments are project-scoped files (images, documents, diagram sources)
 * that editors can upload to provide context for AI generation.
 *
 * Routes:
 *   POST   /api/projects/:id/ai-attachments           — upload (multipart/form-data, field: file)
 *   DELETE /api/projects/:id/ai-attachments/:attId    — delete unused/pending attachment
 *
 * Exported helpers used by generate.ts, diagrams.ts, generated-docs.ts, presentations.ts:
 *   validateAttachmentIds   — validate & load rows
 *   getAttachmentsView      — lightweight view objects for API responses
 *   stageAttachmentsToWorkDir — copy files into an agent work dir's attachments/ subfolder
 *   buildAttachmentPromptBlock — build the goal block describing staged files
 *   linkAttachmentsToParent — mark attachments as used by a resource
 *   deleteAttachmentsForParent — remove files + DB rows when the parent resource is deleted
 *   deleteAttachmentsByIds  — remove specific attachment files + rows (used after test gen)
 *   cleanupOrphanedAttachments — sweep pending attachments older than 24 h
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, run as dbRunSync, getDb } from './db.ts';
import type { Row } from './db.ts';
import { generateId, now, badRequest } from './util.ts';
import { config } from './config.ts';
import { persistFile, restoreFile, forgetFile, durableKeyFor } from './durable-files.ts';
import { directUploadStorage, sealUpload, openUpload, stagingKey, MAX_CHAT_UPLOAD_BYTES, UPLOAD_URL_SECONDS, UPLOAD_TOKEN_MS } from './direct-upload.ts';
import { attachmentLimits } from './agent/input-file-urls.ts';
import { appendAudit } from './audit.ts';
import { getAiAttachmentRepository } from './repositories/ai-attachments.ts';
import type { AiAttachmentRecord, AttachmentParentKind } from './repositories/ai-attachments.ts';

import { getMemberRow, getProjectRow } from './project-access.ts';
// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_IMAGE_BYTES    = 10 * 1024 * 1024; // 10 MB — images
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024; // 20 MB — documents and diagrams

/** The largest file for an upload of this kind and purpose: a chat message takes 50 MB (direct uploads only), anything else the limits above. */
function uploadLimit(kind: 'image' | 'document' | 'diagram', purpose: 'chat' | 'default'): { bytes: number; label: string } {
  if (purpose === 'chat') return { bytes: MAX_CHAT_UPLOAD_BYTES, label: '50 MB' };
  return kind === 'image' ? { bytes: MAX_IMAGE_BYTES, label: '10 MB' } : { bytes: MAX_DOCUMENT_BYTES, label: '20 MB' };
}

/** Allowed extensions → (kind, canonical mime type) */
const ALLOWED: Record<string, { kind: 'image' | 'document' | 'diagram'; mime: string }> = {
  '.png':    { kind: 'image',    mime: 'image/png' },
  '.jpg':    { kind: 'image',    mime: 'image/jpeg' },
  '.jpeg':   { kind: 'image',    mime: 'image/jpeg' },
  '.webp':   { kind: 'image',    mime: 'image/webp' },
  '.gif':    { kind: 'image',    mime: 'image/gif' },
  '.pdf':    { kind: 'document', mime: 'application/pdf' },
  '.docx':   { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.xlsx':   { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.pptx':   { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  '.zip':    { kind: 'document', mime: 'application/zip' },
  '.md':     { kind: 'document', mime: 'text/markdown' },
  '.txt':    { kind: 'document', mime: 'text/plain' },
  '.csv':    { kind: 'document', mime: 'text/csv' },
  '.drawio': { kind: 'diagram',  mime: 'application/xml' },
  '.mmd':    { kind: 'diagram',  mime: 'text/plain' },
  '.svg':    { kind: 'diagram',  mime: 'image/svg+xml' },
};

// ── Magic-byte validation ─────────────────────────────────────────────────────

function checkMagicBytes(buf: Buffer, ext: string): { ok: boolean; reason?: string } {
  if (buf.length === 0) return { ok: false, reason: 'File is empty' };

  switch (ext) {
    case '.png':
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
        return { ok: true };
      return { ok: false, reason: 'File does not appear to be a valid PNG image' };

    case '.jpg':
    case '.jpeg':
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ok: true };
      return { ok: false, reason: 'File does not appear to be a valid JPEG image' };

    case '.gif':
      if (buf.slice(0, 4).toString('ascii') === 'GIF8') return { ok: true };
      return { ok: false, reason: 'File does not appear to be a valid GIF image' };

    case '.webp':
      if (
        buf.length >= 12 &&
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
      ) return { ok: true };
      return { ok: false, reason: 'File does not appear to be a valid WEBP image' };

    case '.pdf':
      if (buf.slice(0, 4).toString('ascii') === '%PDF') return { ok: true };
      return { ok: false, reason: 'File does not appear to be a valid PDF' };

    case '.docx':
    case '.xlsx':
    case '.pptx':
      if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)
        return { ok: true };
      return { ok: false, reason: `File does not appear to be a valid ${ext.slice(1).toUpperCase()} document` };

    case '.zip':
      // A zip starts with a local file header ('PK\x03\x04'), or is empty ('PK\x05\x06').
      if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) return { ok: true };
      return { ok: false, reason: 'File does not appear to be a valid zip archive' };

    case '.md':
    case '.txt':
    case '.csv':
    case '.mmd': {
      try { buf.toString('utf8'); return { ok: true }; } catch {
        return { ok: false, reason: 'File does not appear to be valid UTF-8 text' };
      }
    }

    case '.drawio': {
      const start = buf.slice(0, 512).toString('utf8');
      if (start.includes('<mxGraphModel') || start.includes('<?xml') || start.includes('<diagram'))
        return { ok: true };
      return { ok: false, reason: 'File does not appear to be a valid draw.io XML file' };
    }

    case '.svg': {
      // SVG is treated as text source only — never executed/rendered server-side
      const start = buf.slice(0, 512).toString('utf8');
      if (start.includes('<svg') || start.includes('<?xml')) return { ok: true };
      return { ok: false, reason: 'File does not appear to be a valid SVG file' };
    }

    default:
      return { ok: false, reason: `Unsupported file type: ${ext}` };
  }
}

// ── Multipart parser ──────────────────────────────────────────────────────────

interface UploadedFile {
  filename: string;
  mimeType: string;
  data: Buffer;
}

function parseMultipartFile(rawBody: Buffer, contentType: string): UploadedFile | null {
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

  for (const part of parts) {
    const partStr = part.toString('binary');
    const headerEnd = partStr.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headerSection = partStr.slice(0, headerEnd);
    const fileData = part.slice(headerEnd + 4);
    const filenameMatch = headerSection.match(/Content-Disposition:[^\r\n]*filename="([^"]+)"/i);
    const ctMatch = headerSection.match(/Content-Type:\s*([^\r\n]+)/i);
    if (!filenameMatch) continue;
    return {
      filename: filenameMatch[1].trim(),
      mimeType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
      data: fileData,
    };
  }
  return null;
}

// ── Access control ────────────────────────────────────────────────────────────

async function requireEditorAccess(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
): Promise<Row | null> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return null; }
  const project = await getProjectRow(projectId);
  if (!project) { sendJson(res, 404, { error: 'Project not found' }); return null; }
  if (req.user.is_admin) return project;
  const member = await getMemberRow(projectId, req.user.id);
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return null; }
  if (!['owner', 'editor'].includes(String(member.access))) {
    sendJson(res, 403, { error: 'Editor access required to manage AI attachments' });
    return null;
  }
  return project;
}

// ── Storage helpers ───────────────────────────────────────────────────────────

function attachmentsDir(projectSlug: string): string {
  return path.join(config.dataDir, 'projects', projectSlug, 'ai-attachments');
}

function sanitizeFilename(original: string): string {
  const name = path.basename(original)
    .replace(/[^\w.\-]/g, '_')
    .replace(/^\.+/, '_');
  return (name || 'upload').slice(0, 200);
}

// ── Public types and view helpers ─────────────────────────────────────────────

export interface AttachmentView {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'document' | 'diagram';
}

function rowToView(row: AiAttachmentRecord): AttachmentView {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    kind: row.kind,
  };
}

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Validate a list of attachment IDs for a project.
 * Returns `{ error, rows: null }` on failure, `{ error: null, rows }` on success.
 *
 * Backlog S2: convert to async using getAiAttachmentRepository() once all
 * callers (diagrams.ts, presentations.ts, etc.) have been made async.
 */
export async function validateAttachmentIds(
  projectId: string,
  ids: string[],
): Promise<{ error: string; rows: null } | { error: null; rows: Row[] }> {
  if (ids.length > 5) {
    return { error: 'Maximum 5 attachments allowed per generation', rows: null };
  }
  const rows: Row[] = [];
  for (const id of ids) {
    const att = (await getAiAttachmentRepository().getById(id)) as unknown as Row | null;
    if (!att) return { error: `Attachment ${id} not found`, rows: null };
    if (String(att.project_id) !== projectId)
      return { error: `Attachment ${id} does not belong to this project`, rows: null };
    rows.push(att);
  }
  return { error: null, rows };
}

/** Return view objects for a list of attachment rows. Silently skips missing rows.
 *
 * Backlog S2: convert to async using getAiAttachmentRepository() once
 * diagramView/presView/docView callers are made async.
 */
export async function getAttachmentsView(projectId: string, ids: string[]): Promise<AttachmentView[]> {
  const found = await Promise.all(ids.map((id) => getAiAttachmentRepository().getByIdForProject(id, projectId)));
  return found
    .filter((r): r is NonNullable<typeof r> => r != null)
    .map((row) => ({
      id: String(row.id),
      filename: String(row.filename),
      mimeType: String(row.mime_type),
      size: Number(row.size),
      kind: String(row.kind) as 'image' | 'document' | 'diagram',
    }));
}

/**
 * Copy attachment files into `{workDir}/attachments/`.
 * Returns the list of successfully staged files.
 */
export async function stageAttachmentsToWorkDir(
  attachmentRows: Row[],
  workDir: string,
): Promise<Array<{ filename: string; mimeType: string; kind: string }>> {
  if (!attachmentRows.length) return [];
  const dir = path.join(workDir, 'attachments');
  await fsp.mkdir(dir, { recursive: true });

  const staged: Array<{ filename: string; mimeType: string; kind: string }> = [];
  const usedNames = new Set<string>();
  for (const att of attachmentRows) {
    const srcPath = String(att.file_path ?? att.file_path);
    if (!(await restoreFile(srcPath))) continue;

    let stagedName = String(att.filename);
    if (usedNames.has(stagedName)) {
      const ext = path.extname(stagedName);
      const base = path.basename(stagedName, ext);
      let n = 2;
      while (usedNames.has(`${base}-${n}${ext}`)) n++;
      stagedName = `${base}-${n}${ext}`;
    }
    usedNames.add(stagedName);

    await fsp.copyFile(srcPath, path.join(dir, stagedName));
    staged.push({
      filename: stagedName,
      mimeType: String(att.mime_type),
      kind: String(att.kind),
    });
  }
  return staged;
}

/**
 * Build the goal prompt block that references staged attachment files.
 * Returns an empty string if no files were staged.
 */
export function buildAttachmentPromptBlock(
  staged: Array<{ filename: string; kind: string }>,
): string {
  if (!staged.length) return '';
  const fileList = staged.map((f) => `  - ${f.filename} (${f.kind})`).join('\n');
  return (
    '\n\n## Attached Reference Files\n\n' +
    'The following files have been staged in your working directory under the `attachments/` folder. ' +
    "Read them as primary source material — they describe the app's requirements, architecture, or design:\n\n" +
    fileList +
    '\n\nUse the contents of these files to guide your output.'
  );
}

/**
 * Mark attachment rows as linked to a parent resource (diagram / doc / presentation).
 * Call this after the resource row has been inserted/updated.
 */
export async function linkAttachmentsToParent(
  ids: string[],
  parentKind: AttachmentParentKind,
  parentId: string,
): Promise<void> {
  await getAiAttachmentRepository().linkToParent(ids, parentKind, parentId);
}

/**
 * Delete attachment files and DB rows for a given parent resource.
 * Called when the parent (diagram / doc / presentation) is deleted.
 */
export async function deleteAttachmentsForParent(
  parentKind: AttachmentParentKind,
  parentId: string,
): Promise<void> {
  const repo = getAiAttachmentRepository();
  const rows = await repo.listByParent(parentKind, parentId);
  for (const row of rows) {
    try { fs.rmSync(row.file_path, { force: true }); } catch { /* best effort */ }
    await forgetFile(row.file_path).catch(() => {});
  }
  await repo.deleteByParent(parentKind, parentId);
}

/**
 * Delete specific attachment files and DB rows by ID.
 * Used by test-generation cleanup (attachments are single-use for tests).
 */
export async function deleteAttachmentsByIds(ids: string[]): Promise<void> {
  const repo = getAiAttachmentRepository();
  for (const id of ids) {
    const att = await repo.getById(id);
    if (!att) continue;
    try { fs.rmSync(att.file_path, { force: true }); } catch { /* best effort */ }
    await forgetFile(att.file_path).catch(() => {});
  }
  await repo.deleteByIds(ids);
}

/**
 * Sweep orphaned attachments (no parent, uploaded more than 24 h ago).
 * Safe to call on a schedule (every hour, etc.).
 *
 * Backlog S2: convert to async using getAiAttachmentRepository() once
 * the test is updated to await the call (or uses a sync-compatible API).
 */
export async function cleanupOrphanedAttachments(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const repo = getAiAttachmentRepository();
    const rows = await repo.listOrphanedBefore(cutoff);
    for (const row of rows) {
      try { fs.rmSync(String(row.file_path), { force: true }); } catch { /* best effort */ }
      await forgetFile(String(row.file_path)).catch(() => { /* best effort */ });
    }
    if (rows.length > 0) await repo.deleteOrphanedBefore(cutoff);
  } catch { /* non-fatal */ }
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerAiAttachmentRoutes(): void {

  // GET /api/attachment-limits
  //
  // What a chat message may carry on this portal, so the chat box can say so: 50 MB a file and 100 MB in all where files go
  // straight to storage and reach the agent as download links (the cloud portal), 2 MB and 8 MB otherwise.
  router.get(
    '/api/attachment-limits',
    (req: PortalRequest, res: PortalResponse): void => {
      if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
      sendJson(res, 200, { direct: directUploadStorage() !== null, chat: attachmentLimits() });
    },
  );

  // POST /api/projects/:id/ai-attachments/presign
  //
  // Start an upload that goes straight from the browser to S3, so a file is not limited by what a Lambda request can carry
  // (6 MB). Body { filename, size, purpose?: 'chat' }. Answers { url, token }: the browser PUTs the file to `url`, then calls
  // /complete with `token`. 409 when this deployment cannot do that (the browser then posts the file to the portal as before).
  router.post(
    '/api/projects/:id/ai-attachments/presign',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const project = await requireEditorAccess(req, res, req.params.id);
      if (!project) return;
      const storage = directUploadStorage();
      if (!storage) {
        sendJson(res, 409, { error: 'Direct upload is not available here. Send the file through the portal instead.', direct: false });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const originalName = typeof body.filename === 'string' ? body.filename.trim().slice(0, 255) : '';
      if (!originalName) { sendJson(res, 400, { error: 'filename is required' }); return; }
      const size = body.size;
      if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) { sendJson(res, 400, { error: 'size must be a whole number of bytes' }); return; }
      if (size === 0) { sendJson(res, 400, { error: 'Uploaded file is empty' }); return; }
      const purpose = body.purpose === 'chat' ? 'chat' : 'default';

      const safe = sanitizeFilename(originalName);
      const ext = path.extname(safe).toLowerCase();
      const meta = ALLOWED[ext];
      if (!meta) {
        sendJson(res, 400, { error: `Unsupported file type "${ext || '(none)'}". Allowed: ` + Object.keys(ALLOWED).join(', ') });
        return;
      }
      const limit = uploadLimit(meta.kind, purpose);
      if (size > limit.bytes) {
        sendJson(res, 400, { error: `File exceeds the ${limit.label} limit (got ${(size / 1024 / 1024).toFixed(1)} MB)` });
        return;
      }

      const uploadId = generateId();
      const url = await storage.presign(stagingKey(req.params.id, uploadId, safe), 'put', UPLOAD_URL_SECONDS, { contentLength: size });
      const token = sealUpload({ v: 1, user: req.user!.id, project: req.params.id, id: uploadId, name: originalName, safe, size, purpose, exp: Date.now() + UPLOAD_TOKEN_MS });
      sendJson(res, 200, { url, token, expiresIn: UPLOAD_URL_SECONDS });
    },
  );

  // POST /api/projects/:id/ai-attachments/complete
  //
  // The browser has uploaded to the link /presign gave it. Check what arrived (it exists, it is the size that was chosen, it looks
  // like what its name says), move it to its permanent place inside S3 and record it like any other attachment. Body { token }.
  // Answers like the multipart upload: { attachment }. Calling it again for the same upload gives the same attachment.
  router.post(
    '/api/projects/:id/ai-attachments/complete',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const project = await requireEditorAccess(req, res, req.params.id);
      if (!project) return;
      const storage = directUploadStorage();
      if (!storage) {
        sendJson(res, 409, { error: 'Direct upload is not available here. Send the file through the portal instead.', direct: false });
        return;
      }
      const upload = openUpload((req.body as { token?: unknown } | undefined)?.token, req.user!.id, req.params.id);
      if (!upload) { sendJson(res, 400, { error: 'This upload has expired. Choose the file again.' }); return; }

      const repo = getAiAttachmentRepository();
      const existing = await repo.getById(upload.id);
      if (existing) {
        if (existing.project_id !== req.params.id || existing.uploaded_by !== req.user!.id) { sendJson(res, 400, { error: 'This upload has expired. Choose the file again.' }); return; }
        sendJson(res, 200, { attachment: rowToView(existing) });
        return;
      }

      const key = stagingKey(req.params.id, upload.id, upload.safe);
      const refuse = async (error: string): Promise<void> => {
        await storage.delete(key).catch(() => { /* the lifecycle rule removes it */ });
        sendJson(res, 400, { error });
      };

      const head = await storage.head(key);
      if (!head) { sendJson(res, 400, { error: 'The file did not arrive. Choose it again.' }); return; }
      if (head.size !== upload.size) { await refuse('The file that arrived is not the size that was chosen. Choose it again.'); return; }

      const ext = path.extname(upload.safe).toLowerCase();
      const meta = ALLOWED[ext];
      if (!meta) { await refuse(`Unsupported file type "${ext || '(none)'}"`); return; }
      const limit = uploadLimit(meta.kind, upload.purpose);
      if (head.size > limit.bytes) { await refuse(`File exceeds the ${limit.label} limit`); return; }

      const first = await storage.readRange(key, 0, Math.min(head.size, 4096) - 1);
      const magic = checkMagicBytes(first, ext);
      if (!magic.ok) { await refuse(magic.reason ?? 'File content validation failed'); return; }

      const filePath = path.join(attachmentsDir(String(project.slug)), `${upload.id}-${upload.safe}`);
      const durable = durableKeyFor(filePath);
      if (!durable) { await refuse('The file could not be stored'); return; }
      // The copy gets the type the file's name stands for, not whatever the browser said it was.
      await storage.copy(key, durable, { contentType: meta.mime });
      await storage.delete(key).catch(() => { /* the lifecycle rule removes it */ });

      await repo.create({
        id: upload.id,
        project_id: req.params.id,
        filename: upload.safe,
        original_name: upload.name,
        mime_type: meta.mime,
        size: head.size,
        kind: meta.kind,
        file_path: filePath,
        parent_kind: null,
        parent_id: null,
        uploaded_by: req.user!.id,
        created_at: now(),
      });

      appendAudit(
        getDb(),
        req.user!.id,
        'ai_attachment.upload',
        `project:${req.params.id}`,
        { filename: upload.safe, kind: meta.kind, size: head.size, direct: true },
        req.ip,
      );

      sendJson(res, 201, { attachment: { id: upload.id, filename: upload.safe, mimeType: meta.mime, size: head.size, kind: meta.kind } });
    },
  );

  // POST /api/projects/:id/ai-attachments
  router.post(
    '/api/projects/:id/ai-attachments',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const project = await requireEditorAccess(req, res, req.params.id);
      if (!project) return;

      if (!req.rawBody || req.rawBody.length === 0) {
        sendJson(res, 400, { error: 'No file data received' });
        return;
      }

      const ct = String(req.headers['content-type'] ?? '');
      if (!ct.includes('multipart/form-data')) {
        sendJson(res, 400, { error: 'Expected multipart/form-data' });
        return;
      }

      let uploaded: UploadedFile | null;
      try {
        uploaded = parseMultipartFile(req.rawBody, ct);
      } catch (e: unknown) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
        return;
      }

      if (!uploaded) {
        sendJson(res, 400, { error: 'No file found in upload. Use field name "file".' });
        return;
      }

      const { filename: originalName, data } = uploaded;

      if (data.length === 0) {
        sendJson(res, 400, { error: 'Uploaded file is empty' });
        return;
      }

      const safeFilename = sanitizeFilename(originalName);
      const ext = path.extname(safeFilename).toLowerCase();
      const meta = ALLOWED[ext];
      if (!meta) {
        sendJson(res, 400, {
          error:
            `Unsupported file type "${ext || '(none)'}". Allowed: ` +
            Object.keys(ALLOWED).join(', '),
        });
        return;
      }

      const maxBytes   = meta.kind === 'image' ? MAX_IMAGE_BYTES    : MAX_DOCUMENT_BYTES;
      const limitLabel = meta.kind === 'image' ? '10 MB'            : '20 MB';
      if (data.length > maxBytes) {
        sendJson(res, 400, {
          error: `File exceeds the ${limitLabel} limit (got ${(data.length / 1024 / 1024).toFixed(1)} MB)`,
        });
        return;
      }

      const magic = checkMagicBytes(data, ext);
      if (!magic.ok) {
        sendJson(res, 400, { error: magic.reason ?? 'File content validation failed' });
        return;
      }

      const id = generateId();
      const slug = String(project.slug);
      const dir = attachmentsDir(slug);
      fs.mkdirSync(dir, { recursive: true });

      const storedName = `${id}-${safeFilename}`;
      const filePath = path.join(dir, storedName);
      fs.writeFileSync(filePath, data);
      await persistFile(filePath);

      await getAiAttachmentRepository().create({
        id,
        project_id: req.params.id,
        filename: safeFilename,
        original_name: originalName,
        mime_type: meta.mime,
        size: data.length,
        kind: meta.kind,
        file_path: filePath,
        parent_kind: null,
        parent_id: null,
        uploaded_by: req.user!.id,
        created_at: now(),
      });

      appendAudit(
        getDb(),
        req.user!.id,
        'ai_attachment.upload',
        `project:${req.params.id}`,
        { filename: safeFilename, kind: meta.kind, size: data.length },
        req.ip,
      );

      sendJson(res, 201, {
        attachment: { id, filename: safeFilename, mimeType: meta.mime, size: data.length, kind: meta.kind },
      });
    },
  );

  // DELETE /api/projects/:id/ai-attachments/:attId
  router.delete(
    '/api/projects/:id/ai-attachments/:attId',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const project = await requireEditorAccess(req, res, req.params.id);
      if (!project) return;

      const att = await getAiAttachmentRepository().getByIdForProject(req.params.attId, req.params.id);
      if (!att) { sendJson(res, 404, { error: 'Attachment not found' }); return; }

      if (att.parent_id !== null && att.parent_id !== undefined) {
        sendJson(res, 400, {
          error: 'Cannot delete an attachment that is linked to a resource. Delete the resource to remove its attachments.',
        });
        return;
      }

      try { fs.rmSync(att.file_path, { force: true }); } catch { /* best effort */ }
      await forgetFile(att.file_path).catch(() => {});
      await getAiAttachmentRepository().deleteByIds([req.params.attId]);

      appendAudit(
        getDb(),
        req.user!.id,
        'ai_attachment.delete',
        `project:${req.params.id}`,
        { filename: att.filename },
        req.ip,
      );

      sendJson(res, 200, { ok: true });
    },
  );
}
