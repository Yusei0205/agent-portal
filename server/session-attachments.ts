import { constants } from 'node:fs';
import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from './config.ts';
import { badRequest, generateId } from './util.ts';
import { getProjectRepository } from './repositories/projects.ts';
import { validateAttachmentIds } from './ai-attachments.ts';
import { persistFile, restoreFile } from './durable-files.ts';
import { INPUT_FILE_EXTS, INPUT_FILE_LIMITS } from './agent/runner-files.ts';

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
  let total = 0;
  for (const row of checked.rows ?? []) {
    const source = String(row.file_path);
    const ext = path.extname(String(row.filename)).toLowerCase();
    if (!INPUT_FILE_EXTS.has(ext)) throw badRequest('Unsupported chat attachment type');
    if (!await restoreFile(source)) throw badRequest('Attachment is no longer available. Attach it again.');
    const stat = await fs.lstat(source);
    if (!stat.isFile() || !stat.size || stat.size > INPUT_FILE_LIMITS.fileBytes) throw badRequest('Chat attachments must be between 1 byte and 2 MB each');
    total += stat.size;
    if (total > INPUT_FILE_LIMITS.totalBytes) throw badRequest('Chat attachments exceed the 8 MB total limit');
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

/** Stage only the files referenced by pending messages, before invoking any runner. */
export async function stageChatAttachments(projectId: string, workflowId: string, events: Array<{ data: string | null }>, workDir: string): Promise<ChatAttachment[]> {
  const attachments: ChatAttachment[] = [];
  for (const event of events) {
    const data = JSON.parse(event.data || '{}');
    if (Array.isArray(data.attachments)) attachments.push(...data.attachments);
  }
  if (!attachments.length) return [];
  if (attachments.length > INPUT_FILE_LIMITS.files) throw new Error('Too many pending chat attachments');
  if (attachments.reduce((sum, a) => sum + a.size, 0) > INPUT_FILE_LIMITS.totalBytes) throw new Error('Pending chat attachments exceed the 8 MB runner limit');
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
