import { constants } from 'node:fs';
import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from './config.ts';
import { badRequest, generateId } from './util.ts';
import { getProjectRepository } from './repositories/projects.ts';
import { validateAttachmentIds } from './ai-attachments.ts';
import { persistFile, restoreFile } from './durable-files.ts';
import { INPUT_FILE_EXTS, INPUT_FILE_LIMITS } from './agent/runner-files.ts';
import { attachmentLimits } from './agent/input-file-urls.ts';
import { getSessionsRepository } from './repositories/sessions.ts';
import { getVaultFilesRepository } from './repositories/vault-files.ts';
import { sessionVaultFolder, USER_UPLOADS_FOLDER } from './session-vault-folder.ts';
import { now } from './util.ts';

const mb = (bytes: number): string => `${bytes / 1024 / 1024} MB`;

export interface ChatAttachment { path: string; name: string; size: number }

async function storageDir(projectId: string, workflowId: string): Promise<string> {
  const project = await getProjectRepository().getProjectById(projectId);
  if (!project) throw badRequest('Project not found');
  return path.join(config.dataDir, 'projects', project.slug, 'uploads', workflowId, 'chat');
}

/** Snapshot accepted uploads so pending messages survive upload cleanup and cold starts. */
export async function saveChatAttachments(projectId: string, workflowId: string, raw: unknown): Promise<ChatAttachment[]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 5 || raw.some(id => typeof id !== 'string' || !id || id.length > 200)) {
    throw badRequest('attachmentIds must contain at most 5 attachment IDs');
  }
  const ids = [...new Set(raw as string[])];
  const checked = await validateAttachmentIds(projectId, ids);
  if (checked.error) throw badRequest(checked.error);
  const files: Array<{ source: string; name: string; size: number; ext: string }> = [];
  // 2 MB each / 8 MB in all, or 50 MB each / 100 MB in all where large files can be sent to the runner as download links.
  const limits = attachmentLimits();
  let total = 0;
  for (const row of checked.rows ?? []) {
    const source = String(row.file_path);
    const ext = path.extname(String(row.filename)).toLowerCase();
    if (!INPUT_FILE_EXTS.has(ext)) throw badRequest('Unsupported chat attachment type');
    if (!await restoreFile(source)) throw badRequest('Attachment is no longer available. Attach it again.');
    const stat = await fs.lstat(source);
    if (!stat.isFile() || !stat.size || stat.size > limits.fileBytes) throw badRequest(`Chat attachments must be between 1 byte and ${mb(limits.fileBytes)} each`);
    total += stat.size;
    if (total > limits.totalBytes) throw badRequest(`Chat attachments exceed the ${mb(limits.totalBytes)} total limit`);
    files.push({ source, name: String(row.original_name || row.filename), size: stat.size, ext });
  }
  if (!files.length) return [];
  const dir = await storageDir(projectId, workflowId);
  await fs.mkdir(dir, { recursive: true });
  if ((await fs.lstat(dir)).isSymbolicLink()) throw badRequest('Invalid attachment storage');
  const saved: ChatAttachment[] = [];
  for (const file of files) {
    const name = generateId() + file.ext;
    const dest = path.join(dir, name);
    await fs.copyFile(file.source, dest, constants.COPYFILE_EXCL);
    await persistFile(dest);
    saved.push({ path: name, name: file.name, size: file.size });
  }
  return saved;
}

/**
 * Save files that did not come from an upload (for example a Jira ticket's attachments) as chat attachments of a
 * session, so the next run gets them under attachments/. The same type and size limits as uploads apply; files that do
 * not fit are returned in `skipped` with the reason. The stored name is random, `name` keeps the original.
 */
export async function saveBufferAttachments(
  projectId: string, workflowId: string, files: Array<{ name: string; data: Buffer }>,
): Promise<{ saved: ChatAttachment[]; skipped: Array<{ name: string; reason: string }> }> {
  const saved: ChatAttachment[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  let total = 0;
  const dir = await storageDir(projectId, workflowId);
  for (const f of files) {
    const ext = path.extname(f.name).toLowerCase();
    if (!INPUT_FILE_EXTS.has(ext)) { skipped.push({ name: f.name, reason: `${ext || 'this'} files are not delivered to the agent` }); continue; }
    if (!f.data.length || f.data.length > INPUT_FILE_LIMITS.fileBytes) { skipped.push({ name: f.name, reason: `over ${INPUT_FILE_LIMITS.fileBytes / 1048576} MB` }); continue; }
    if (saved.length >= INPUT_FILE_LIMITS.files || total + f.data.length > INPUT_FILE_LIMITS.totalBytes) { skipped.push({ name: f.name, reason: `the files together are over ${INPUT_FILE_LIMITS.totalBytes / 1048576} MB` }); continue; }
    await fs.mkdir(dir, { recursive: true });
    if ((await fs.lstat(dir)).isSymbolicLink()) throw badRequest('Invalid attachment storage');
    const stored = generateId() + ext;
    const dest = path.join(dir, stored);
    await fs.writeFile(dest, f.data, { flag: 'wx' });
    await persistFile(dest);
    total += f.data.length;
    saved.push({ path: stored, name: f.name, size: f.data.length });
  }
  return { saved, skipped };
}

/** Stage only the files referenced by pending messages, before invoking any runner. */
export async function stageChatAttachments(projectId: string, workflowId: string, events: Array<{ data: string | null }>, workDir: string): Promise<ChatAttachment[]> {
  const attachments: ChatAttachment[] = [];
  for (const event of events) {
    const data = JSON.parse(event.data || '{}');
    if (Array.isArray(data.attachments)) attachments.push(...data.attachments);
  }
  if (!attachments.length) return [];
  if (attachments.length > INPUT_FILE_LIMITS.files) throw new Error('Too many pending chat attachments');
  const runnerLimit = attachmentLimits().totalBytes;
  if (attachments.reduce((sum, a) => sum + a.size, 0) > runnerLimit) throw new Error(`Pending chat attachments exceed the ${mb(runnerLimit)} runner limit`);
  const dir = await storageDir(projectId, workflowId);
  const target = path.join(workDir, 'attachments');
  await fs.mkdir(target, { recursive: true });
  if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('Invalid attachment directory');
  for (const attachment of attachments) {
    if (typeof attachment.path !== 'string' || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(attachment.path)) throw new Error('Invalid attachment path');
    const source = path.join(dir, attachment.path);
    if (!await restoreFile(source)) throw new Error('A chat attachment could not be restored. Attach it again.');
    if (!(await fs.lstat(source)).isFile()) throw new Error('Invalid attachment file');
    const dest = path.join(target, attachment.path);
    const existing = await fs.lstat(dest).catch(() => null);
    if (existing && !existing.isFile()) throw new Error('Invalid attachment destination');
    if (existing) await fs.unlink(dest);
    await fs.copyFile(source, dest, constants.COPYFILE_EXCL);
    await persistFile(dest);
  }
  return attachments;
}

/**
 * The files the person attached to earlier messages in this session, put back in the work folder (attachments/) for this turn.
 *
 * The agent is only handed the files of the message it is answering. Every later turn runs on a fresh machine, so a file attached
 * two messages ago (a scan, a spec) was gone and the agent searched the disk for it in vain. This puts the earlier ones back, newest
 * first, one copy of each (the same name and size attached again is one file), only those after the last /clear, and only as many
 * as the runner accepts next to the current message's files: what does not fit is returned in `skipped` so the agent can say so.
 * A file that can no longer be restored is skipped, never an error: the turn must not fail because of an old file.
 */
export async function stagePriorAttachments(
  projectId: string,
  workflowId: string,
  current: ChatAttachment[],
  workDir: string,
): Promise<{ staged: ChatAttachment[]; skipped: ChatAttachment[] }> {
  const out = { staged: [] as ChatAttachment[], skipped: [] as ChatAttachment[] };
  const repo = getSessionsRepository();
  const clearedAt = await repo.getLastWorkflowEventTime(workflowId, 'command', '/clear');
  const events = await repo.listHumanWorkflowEvents(workflowId, clearedAt, null, null);
  const here = new Set(current.map((a) => a.path));
  const seen = new Set(current.map((a) => `${a.name}|${a.size}`));
  const earlier: ChatAttachment[] = [];
  for (const e of [...events].reverse()) {
    let list: unknown;
    try { list = (JSON.parse(e.data || '{}') as { attachments?: unknown }).attachments; } catch { continue; }
    if (!Array.isArray(list)) continue;
    for (const a of list as ChatAttachment[]) {
      if (typeof a?.path !== 'string' || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(a.path) || typeof a.name !== 'string' || !(a.size > 0)) continue;
      const key = `${a.name}|${a.size}`;
      if (here.has(a.path) || seen.has(key)) continue;
      seen.add(key);
      earlier.push({ path: a.path, name: a.name, size: a.size });
    }
  }
  if (!earlier.length) return out;

  const limits = attachmentLimits();
  let room = limits.totalBytes - current.reduce((n, a) => n + a.size, 0);
  let slots = Math.min(limits.files, INPUT_FILE_LIMITS.files) - current.length;
  const dir = await storageDir(projectId, workflowId);
  const target = path.join(workDir, 'attachments');
  await fs.mkdir(target, { recursive: true });
  if ((await fs.lstat(target)).isSymbolicLink()) return out;
  for (const a of earlier) {
    if (slots <= 0 || a.size > limits.fileBytes || a.size > room) { out.skipped.push(a); continue; }
    try {
      const source = path.join(dir, a.path);
      if (!await restoreFile(source) || !(await fs.lstat(source)).isFile()) { out.skipped.push(a); continue; }
      const dest = path.join(target, a.path);
      const existing = await fs.lstat(dest).catch(() => null);
      if (existing && !existing.isFile()) { out.skipped.push(a); continue; }
      if (existing) await fs.unlink(dest);
      await fs.copyFile(source, dest, constants.COPYFILE_EXCL);
      await persistFile(dest);
      out.staged.push(a);
      slots--;
      room -= a.size;
    } catch (e) {
      console.warn(`[session-attachments] could not bring back ${a.name}: ${(e as Error).message}`);
      out.skipped.push(a);
    }
  }
  return out;
}

const VAULT_MIME: Record<string, string> = {
  '.zip': 'application/zip', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
/**
 * Keep a copy of the files a person attached in the chat in the project Vault, under the session's "User uploads" folder with
 * their own names, so they stay with the project after the message (and can be opened, downloaded and shared from the Vault page).
 * Best effort: a file that cannot be copied is never allowed to stop the message (the agent still gets the files as before, in its
 * attachments/ folder), but it is reported back so the person is told. There is no size cap of its own: the chat already limits what
 * can be attached, and the Vault page's 25 MB limit is for its upload form, not for this server-side copy.
 */
export async function saveUploadsToVault(
  wf: { id: string; project_id: string | null; title?: string | null; goal?: string | null },
  saved: ChatAttachment[],
  uploadedBy: string | null,
): Promise<{ saved: string[]; failed: Array<{ name: string; reason: string }> }> {
  const out = { saved: [] as string[], failed: [] as Array<{ name: string; reason: string }> };
  if (!wf.project_id || !saved.length) return out;
  const projectId = String(wf.project_id);
  const repo = getVaultFilesRepository();
  const folder = `${sessionVaultFolder(wf)}/${USER_UPLOADS_FOLDER}`;
  let dir: string;
  try { dir = await storageDir(projectId, wf.id); } catch (e) {
    return { saved: [], failed: saved.map((a) => ({ name: a.name, reason: (e as Error).message })) };
  }
  for (const a of saved) {
    try {
      const src = path.join(dir, a.path);
      const ext = path.extname(a.name);
      const stem = path.basename(a.name, ext).replace(/[\\/:*?"<>|]/g, '_').replace(/\p{Cc}/gu, '_').trim().slice(0, 150) || 'file';
      // The same name uploaded again keeps both: "report.pdf", "report (2).pdf", ...
      let name = `${stem}${ext}`;
      for (let n = 2; n < 100 && await repo.findByWorkflowFolderName(projectId, folder, name, wf.id); n++) name = `${stem} (${n})${ext}`;
      const id = generateId();
      const rel = path.posix.join('vault', 'projects', projectId, 'project', `${id}-${name}`);
      const abs = path.join(config.dataDir, ...rel.split('/'));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.copyFile(src, abs);
      const mime = VAULT_MIME[ext.toLowerCase()] ?? 'application/octet-stream';
      await persistFile(abs, mime);
      await repo.create({
        id, project_id: projectId, user_id: null, name, path: rel, size_bytes: a.size, mime_type: mime,
        uploaded_by: uploadedBy, folder, source_workflow_id: wf.id, created_at: now(),
      });
      out.saved.push(name);
    } catch (e) {
      console.warn(`[session-attachments] could not copy ${a.name} to the Vault: ${(e as Error).message}`);
      out.failed.push({ name: a.name, reason: (e as Error).message });
    }
  }
  return out;
}
