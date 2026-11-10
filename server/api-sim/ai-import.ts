/**
 * Importing a Word or Excel document with AI, as a background job (it makes one model call per API, so it takes a while).
 *
 *   POST /api/projects/:id/sim/import-ai          {attachmentId, credentialId?, model?}  -> 202 {jobId}
 *   GET  /api/projects/:id/sim/import-jobs/:jid   progress, and the result when done
 *
 * The document is uploaded first as an AI attachment (the same upload the test generation uses). The job turns it into
 * text, reads it with the chosen model (ai-extract.ts) and saves the APIs as draft versions, so reading an updated
 * document again adds a new version to the APIs it recognises. Postman and OpenAPI files do not use this.
 */

import { router, sendJson } from '../http.ts';
import { generateId, now } from '../util.ts';
import { getSetting, setSetting } from '../settings.ts';
import { getDb } from '../db.ts';
import { auditRaw } from '../audit.ts';
import { registerBackgroundJob, runInBackground } from '../background-jobs.ts';
import { restoreFile } from '../durable-files.ts';
import { convertToMarkdown } from '../convert.ts';
import { deleteAttachmentsByIds, validateAttachmentIds } from '../ai-attachments.ts';
import { callTextModel } from '../testing/model-provider.ts';
import { requireProjectAccess, bad } from './access.ts';
import { extractApis } from './ai-extract.ts';
import type { ModelCall } from './ai-extract.ts';
import { importDrafts } from './import-drafts.ts';
import type { ImportedApi } from './import-drafts.ts';

export interface ImportJob {
  id: string;
  projectId: string;
  userId: string;
  attachmentId: string;
  fileName: string;
  credentialId: string | null;
  model: string | null;
  status: 'running' | 'done' | 'failed';
  phase: string;
  done: number;
  total: number;
  current: string;
  created: ImportedApi[];
  errors: Array<{ api: string; message: string }>;
  notes: string[];
  baseUrls: Array<{ label: string; url: string }>;
  liveBaseUrl: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const key = (id: string): string => `simjob.${id}`;

async function saveJob(job: ImportJob): Promise<void> { await setSetting(getDb(), key(job.id), JSON.stringify(job)); }

export function loadJob(id: string): ImportJob | null {
  try {
    const raw = getSetting(getDb(), key(id));
    return raw ? (JSON.parse(raw) as ImportJob) : null;
  } catch { return null; }
}

/** The address to offer as the client's real API: a test or UAT one first, and only https. */
export function pickLiveBaseUrl(urls: Array<{ label: string; url: string }>): string {
  const https = urls.filter((u) => /^https:\/\/[^\s/]+/i.test(u.url) && !/@/.test(u.url.replace(/^https:\/\//i, '').split('/')[0]));
  const test = https.find((u) => /uat|test|stag|sandbox|dev/i.test(u.label));
  return (test ?? https[0])?.url.replace(/\/+$/, '') ?? '';
}

let modelFactory: ((job: ImportJob) => ModelCall) | null = null;
/** Test hook: replace the model call. */
export function _setImportModel(fn: ((job: ImportJob) => ModelCall) | null): void { modelFactory = fn; }

function modelFor(job: ImportJob): ModelCall {
  if (modelFactory) return modelFactory(job);
  return (system, user, maxTokens) => callTextModel(system, user, { maxTokens, createdBy: job.userId, credentialId: job.credentialId, model: job.model });
}

async function runJob(jobId: string): Promise<void> {
  const job = loadJob(jobId);
  if (!job || job.status !== 'running') return;
  const update = async (p: Partial<ImportJob>): Promise<void> => { Object.assign(job, p); await saveJob(job); };

  try {
    const { rows, error } = await validateAttachmentIds(job.projectId, [job.attachmentId]);
    if (error || !rows || rows.length === 0) throw new Error(error ?? 'The uploaded document is no longer available. Upload it again.');
    const file = rows[0];
    const filePath = String(file.file_path);
    await restoreFile(filePath);
    const markdown = await convertToMarkdown(filePath, String(file.mime_type));

    const result = await extractApis(markdown, modelFor(job), async (p) => {
      await update({ phase: p.phase, done: p.done, total: p.total, current: p.current ?? '' });
    });

    const liveBaseUrl = pickLiveBaseUrl(result.baseUrls);
    const created = result.drafts.length > 0
      ? await importDrafts(job.projectId, job.userId, result.drafts.map((d) => ({ ...d, liveBaseUrl })))
      : [];
    const notes = [...result.notes];
    if (liveBaseUrl && created.some((c) => c.isNew)) {
      const label = result.baseUrls.find((u) => u.url.replace(/\/+$/, '') === liveBaseUrl)?.label;
      notes.push(`The client's address${label ? ` (${label})` : ''} from the document, ${liveBaseUrl}, was saved as the live address of the new APIs. Nothing is sent to it unless you run on the live API.`);
    }
    await update({
      status: result.drafts.length > 0 ? 'done' : 'failed',
      phase: 'done', done: result.drafts.length, total: Math.max(result.drafts.length, 1), current: '',
      created, errors: result.errors, notes, baseUrls: result.baseUrls, liveBaseUrl,
      error: result.drafts.length === 0 ? (result.errors[0]?.message ?? 'No APIs could be read from the document.') : null,
      finishedAt: now(),
    });
    auditRaw(job.userId, 'sim_api.ai_import', `project:${job.projectId}`, { apis: created.length, errors: result.errors.length, model: job.model ?? 'default' });
  } catch (e) {
    await update({ status: 'failed', phase: 'done', error: (e instanceof Error ? e.message : String(e)).slice(0, 300), finishedAt: now() });
  } finally {
    // The document has been read; it is not kept.
    await deleteAttachmentsByIds([job.attachmentId]).catch(() => undefined);
  }
}

export function registerAiImportRoutes(): void {
  registerBackgroundJob('sim-ai-import', async (a) => { await runJob(String(a.jobId)); });

  router.post('/api/projects/:id/sim/import-ai', async (req, res): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const attachmentId = typeof body.attachmentId === 'string' ? body.attachmentId : '';
    if (!attachmentId) { bad(res, 'attachmentId is required: upload the document first'); return; }
    const { rows, error } = await validateAttachmentIds(req.params.id, [attachmentId]);
    if (error || !rows) { bad(res, error ?? 'Attachment not found'); return; }

    const job: ImportJob = {
      id: generateId(), projectId: req.params.id, userId: req.user!.id, attachmentId, fileName: String(rows[0].original_name ?? rows[0].filename ?? ''),
      credentialId: typeof body.credentialId === 'string' && body.credentialId ? body.credentialId : null,
      model: typeof body.model === 'string' && body.model ? body.model.slice(0, 200) : null,
      status: 'running', phase: 'queued', done: 0, total: 0, current: '', created: [], errors: [], notes: [], baseUrls: [], liveBaseUrl: '',
      error: null, startedAt: now(), finishedAt: null,
    };
    await saveJob(job);
    await runInBackground('sim-ai-import', { jobId: job.id });
    sendJson(res, 202, { jobId: job.id });
  });

  router.get('/api/projects/:id/sim/import-jobs/:jid', async (req, res): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const job = loadJob(req.params.jid);
    if (!job || job.projectId !== req.params.id) { bad(res, 'Import not found', 404); return; }
    const { userId: _u, attachmentId: _a, credentialId: _c, ...view } = job;
    sendJson(res, 200, { job: view });
  });
}
