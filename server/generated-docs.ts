/**
 * Generated documents API (P9, NEW-6).
 *
 * Routes:
 *   GET    /api/projects/:id/generated-docs                  — list
 *   POST   /api/projects/:id/generated-docs                  — create + start agent session
 *   GET    /api/projects/:id/generated-docs/:docId           — get with latest version
 *   DELETE /api/projects/:id/generated-docs/:docId           — delete
 *   POST   /api/projects/:id/generated-docs/:docId/refresh   — re-run agent session
 *   GET    /api/projects/:id/generated-docs/:docId/versions  — list versions
 *   GET    /api/projects/:id/generated-docs/:docId/download  — download .md or .docx
 */
import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, insert, run as dbRun, update } from './db.ts';
import type { Row } from './db.ts';
import { newId, now, badRequest, notFound, str, parseJson } from './util.ts';
import { emit } from './events.ts';
import { config } from './config.ts';
import {
  DOC_TYPES,
  DOC_TYPE_LABELS,
  DOC_LIMITS,
  composeDocPrompt,
  type DocType,
} from './generated-doc-text.ts';
import {
  validateAttachmentIds,
  stageAttachmentsToWorkDir,
  buildAttachmentPromptBlock,
  linkAttachmentsToParent,
  deleteAttachmentsForParent,
  getAttachmentsView,
} from './ai-attachments.ts';
import { createWorkDir } from './workflows/working-copies.ts';

import { getMemberRow, getProjectRow } from './project-access.ts';
export { DOC_TYPES, DOC_TYPE_LABELS, DOC_LIMITS, type DocType };

// ── Helpers ───────────────────────────────────────────────────────────────────

async function requireProjectAccess(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
  level: 'viewer' | 'editor' = 'viewer',
): Promise<Row | null> {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const project = await getProjectRow(projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (req.user.is_admin) return project;
  const member = await getMemberRow(projectId, req.user.id);
  if (!member) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (level === 'editor' && String(member.role) === 'viewer') {
    sendJson(res, 403, { error: 'Editors and above can create documents' });
    return null;
  }
  return project;
}

function docView(d: Row, version?: Row | null) {
  const attIds = parseJson<string[]>(String(d.attachment_ids ?? '[]'), []);
  const status = String(d.status ?? 'ready');
  return {
    id: d.id,
    project_id: d.project_id,
    name: d.name,
    doc_type: d.doc_type,
    sources: parseJson<Record<string, unknown>>(String(d.sources_json ?? '{}'), {}),
    diagram_style: d.diagram_style ?? 'mermaid',
    diagram_cloud: d.diagram_cloud ?? null,
    lead_agent: d.lead_agent ?? null,
    trust_all_tools: Boolean(d.trust_all_tools),
    audience: d.audience ?? null,
    latest_version_id: d.latest_version_id ?? null,
    stale: Boolean(d.stale),
    status,
    error: d.error ?? null,
    retryable: status === 'failed',
    workflow_id: version?.workflow_id ?? null,
    created_by: d.created_by ?? null,
    created_at: d.created_at,
    latest_version: version ? versionView(version) : null,
    attachments: attIds.length > 0 ? getAttachmentsView(String(d.project_id), attIds) : [],
  };
}

function versionView(v: Row) {
  return {
    id: v.id,
    doc_id: v.doc_id,
    version_num: v.version_num,
    md_path: v.md_path ?? null,
    docx_path: v.docx_path ?? null,
    warnings: v.warnings ?? null,
    workflow_id: v.workflow_id ?? null,
    created_at: v.created_at,
  };
}

function getDoc(docId: string, projectId: string): Row {
  const d = one<Row>('SELECT * FROM generated_docs WHERE id = ? AND project_id = ?', docId, projectId);
  if (!d) throw notFound('Document not found');
  return d;
}

function latestVersion(docId: string): Row | null {
  return one<Row>('SELECT * FROM generated_doc_versions WHERE doc_id = ? ORDER BY version_num DESC LIMIT 1', docId) ?? null;
}

async function startDocRun(
  projectId: string,
  docId: string,
  goal: string,
  userId: string,
  leadAgent?: string | null,
  trustAllTools?: boolean,
  preconfig?: { workflowId?: string; workDir?: string | null },
): Promise<string> {
  const workflowId = preconfig?.workflowId ?? newId('w_');
  const ts = now();

  insert('p6_workflows', {
    id: workflowId,
    project_id: projectId,
    goal,
    status: 'pending',
    engine: 'demo',
    trust_tools: trustAllTools ? 1 : 0,
    lead_agent: leadAgent ?? null,
    workspace_id: null,
    output_files_enabled: 0,
    repo_ids: '[]',
    iteration_count: 0,
    max_iterations: 1,
    work_dir: preconfig?.workDir ?? null,
    created_by: userId,
    created_at: ts,
    updated_at: ts,
  });

  // Mark the doc as generating so startup recovery can flip it to failed on crash
  update('generated_docs', docId, { status: 'generating', error: null, workflow_id: workflowId });

  emit(projectId, { type: 'workflow.created', workflowId });

  setTimeout(async () => {
    try {
      const { startRun } = await import('./workflows/driver.ts');
      await startRun(workflowId);
    } catch (e) {
      console.error('[generated-docs] Failed to start run:', e);
    }
  }, 0);

  return workflowId;
}

// ── processDocOutput ──────────────────────────────────────────────────────────

/**
 * Called by the agent runner on completion. Scans workDir for markdown output.
 * Creates a generated_doc_versions row.
 */
export async function processDocOutput(workflowId: string, runId: string, workDir: string): Promise<void> {
  // Find the generated_doc linked to this workflow
  const d = one<Row>(
    "SELECT gd.* FROM generated_docs gd JOIN p6_workflows w ON w.id = ? WHERE w.project_id = gd.project_id",
    workflowId,
  );
  if (!d) return;

  // Look for a markdown file in the workDir
  let mdPath: string | null = null;
  let docxPath: string | null = null;

  try {
    if (fs.existsSync(workDir)) {
      const files = fs.readdirSync(workDir);
      const mdFile = files.find((f) => f.endsWith('.md'));
      const docxFile = files.find((f) => f.endsWith('.docx'));
      if (mdFile) mdPath = path.join(workDir, mdFile);
      if (docxFile) docxPath = path.join(workDir, docxFile);
    }
  } catch { /* best effort */ }

  // Get next version number
  const lastVersion = one<{ max_v: number }>(
    'SELECT COALESCE(MAX(version_num), 0) AS max_v FROM generated_doc_versions WHERE doc_id = ?',
    String(d.id),
  );
  const versionNum = (lastVersion?.max_v ?? 0) + 1;

  const versionId = newId('gdv_');
  const ts = now();

  insert('generated_doc_versions', {
    id: versionId,
    doc_id: String(d.id),
    version_num: versionNum,
    md_path: mdPath,
    docx_path: docxPath,
    warnings: null,
    workflow_id: workflowId,
    created_at: ts,
  });

  update('generated_docs', String(d.id), {
    latest_version_id: versionId,
    stale: 0,
    status: 'ready',
    error: null,
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerGeneratedDocRoutes(): void {
  // GET /api/projects/:id/generated-docs
  router.get('/api/projects/:id/generated-docs', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id);
    if (!project) return;

    const docs = all<Row>(
      'SELECT * FROM generated_docs WHERE project_id = ? ORDER BY created_at DESC',
      String(project.id),
    );

    const result = docs.map((d) => {
      const v = d.latest_version_id
        ? one<Row>('SELECT * FROM generated_doc_versions WHERE id = ?', String(d.latest_version_id))
        : null;
      return docView(d, v);
    });

    sendJson(res, 200, {
      docs: result,
      doc_types: DOC_TYPES.map((id) => ({ id, label: DOC_TYPE_LABELS[id] })),
      limits: { perProject: DOC_LIMITS.perProject },
    });
  });

  // POST /api/projects/:id/generated-docs
  router.post('/api/projects/:id/generated-docs', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id, 'editor');
    if (!project) return;

    const body = req.body as Record<string, unknown>;
    const name = str(body.name as string, 'Name', { max: DOC_LIMITS.titleChars });
    const docType = body.docType as string;
    if (!DOC_TYPES.includes(docType as DocType)) {
      throw badRequest(`doc_type must be one of: ${DOC_TYPES.join(', ')}`);
    }

    const sources = (typeof body.sources === 'object' && body.sources !== null)
      ? body.sources as { repoIds?: string[]; docIds?: string[]; diagramIds?: string[] }
      : {};
    const diagramStyle = (body.diagramStyle as string) ?? 'mermaid';
    const diagramCloud = (body.diagramCloud as string | undefined) ?? null;
    const audience = str((body.audience as string) ?? '', 'audience', { max: DOC_LIMITS.audienceChars, optional: true });
    const leadAgent = str((body.leadAgent as string) ?? '', 'leadAgent', { max: 200, optional: true }) || null;
    const trustAllTools = Boolean(body.trustAllTools);
    const rawAttachmentIds = Array.isArray(body.attachmentIds) ? (body.attachmentIds as unknown[]).map(String) : [];

    // Validate attachment IDs
    let attachmentRows: Row[] = [];
    if (rawAttachmentIds.length > 0) {
      const { error, rows } = validateAttachmentIds(String(project.id), rawAttachmentIds);
      if (error) throw badRequest(error);
      attachmentRows = rows!;
    }

    // Check per-project limit
    const count = (one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM generated_docs WHERE project_id = ?',
      String(project.id),
    )?.n ?? 0);
    if (count >= DOC_LIMITS.perProject) {
      throw badRequest(`A project can hold at most ${DOC_LIMITS.perProject} generated documents`);
    }

    // Build the goal/prompt
    let goal = composeDocPrompt({
      type: docType as DocType,
      title: name,
      audience: audience ?? '',
      repos: [],
      knowledge: Boolean(sources.docIds?.length),
      decisions: false,
      diagrams: [],
    });

    // Pre-stage attachment files if provided
    let preWorkflowId: string | undefined;
    let preWorkDir: string | null = null;
    if (attachmentRows.length > 0) {
      preWorkflowId = newId('w_');
      const projectDir = path.join(config.dataDir, 'projects', String(project.slug));
      preWorkDir = await createWorkDir(preWorkflowId, projectDir);
      const staged = await stageAttachmentsToWorkDir(attachmentRows, preWorkDir);
      goal += buildAttachmentPromptBlock(staged);
    }

    const id = newId('gd_');
    const ts = now();

    insert('generated_docs', {
      id,
      project_id: String(project.id),
      name,
      doc_type: docType,
      sources_json: JSON.stringify(sources),
      diagram_style: diagramStyle,
      diagram_cloud: diagramCloud,
      lead_agent: leadAgent,
      trust_all_tools: trustAllTools ? 1 : 0,
      audience: audience || null,
      latest_version_id: null,
      stale: 0,
      attachment_ids: JSON.stringify(rawAttachmentIds),
      created_by: req.user!.id,
      created_at: ts,
    });

    const workflowId = await startDocRun(
      String(project.id),
      id,
      goal,
      req.user!.id,
      leadAgent,
      trustAllTools,
      { workflowId: preWorkflowId, workDir: preWorkDir },
    );

    // Link attachments to this document
    if (rawAttachmentIds.length > 0) {
      await linkAttachmentsToParent(rawAttachmentIds, 'doc', id);
    }

    const d = one<Row>('SELECT * FROM generated_docs WHERE id = ?', id)!;
    sendJson(res, 200, { doc: docView(d, null), workflowId });
  });

  // GET /api/projects/:id/generated-docs/:docId
  router.get('/api/projects/:id/generated-docs/:docId', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id);
    if (!project) return;

    const d = getDoc(req.params.docId, String(project.id));
    const v = latestVersion(String(d.id));
    sendJson(res, 200, { doc: docView(d, v) });
  });

  // DELETE /api/projects/:id/generated-docs/:docId
  router.delete('/api/projects/:id/generated-docs/:docId', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id, 'editor');
    if (!project) return;

    const d = getDoc(req.params.docId, String(project.id));
    await deleteAttachmentsForParent('doc', String(d.id));
    dbRun('DELETE FROM generated_docs WHERE id = ?', String(d.id));
    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/generated-docs/:docId/refresh
  router.post('/api/projects/:id/generated-docs/:docId/refresh', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id, 'editor');
    if (!project) return;

    const d = getDoc(req.params.docId, String(project.id));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawAttachmentIds = Array.isArray(body.attachmentIds) ? (body.attachmentIds as unknown[]).map(String) : null;

    // Determine effective attachment IDs
    let effectiveAttachmentIds: string[];
    if (rawAttachmentIds !== null) {
      if (rawAttachmentIds.length > 0) {
        const { error } = validateAttachmentIds(String(project.id), rawAttachmentIds);
        if (error) { sendJson(res, 400, { error }); return; }
      }
      // Replace old attachments
      const oldIds = parseJson<string[]>(String(d.attachment_ids ?? '[]'), []);
      if (oldIds.length > 0) await deleteAttachmentsForParent('doc', String(d.id));
      effectiveAttachmentIds = rawAttachmentIds;
      update('generated_docs', String(d.id), { attachment_ids: JSON.stringify(rawAttachmentIds) });
    } else {
      effectiveAttachmentIds = parseJson<string[]>(String(d.attachment_ids ?? '[]'), []);
    }

    let attachmentRows: Row[] = [];
    if (effectiveAttachmentIds.length > 0) {
      const { rows } = validateAttachmentIds(String(project.id), effectiveAttachmentIds);
      attachmentRows = rows ?? [];
    }

    let goal = composeDocPrompt({
      type: String(d.doc_type) as DocType,
      title: String(d.name),
      audience: String(d.audience ?? ''),
      repos: [],
      knowledge: false,
      decisions: false,
      diagrams: [],
    });

    let preWorkflowId: string | undefined;
    let preWorkDir: string | null = null;
    if (attachmentRows.length > 0) {
      preWorkflowId = newId('w_');
      const projectDir = path.join(config.dataDir, 'projects', String(project.slug));
      preWorkDir = await createWorkDir(preWorkflowId, projectDir);
      const staged = await stageAttachmentsToWorkDir(attachmentRows, preWorkDir);
      goal += buildAttachmentPromptBlock(staged);
    }

    const workflowId = await startDocRun(
      String(project.id),
      String(d.id),
      goal,
      req.user!.id,
      d.lead_agent ? String(d.lead_agent) : null,
      Boolean(d.trust_all_tools),
      { workflowId: preWorkflowId, workDir: preWorkDir },
    );

    if (rawAttachmentIds !== null && rawAttachmentIds.length > 0) {
      linkAttachmentsToParent(rawAttachmentIds, 'doc', String(d.id));
    }

    sendJson(res, 200, { workflowId });
  });

  // POST /api/projects/:id/generated-docs/:docId/retry — retry a failed generation
  router.post('/api/projects/:id/generated-docs/:docId/retry', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id, 'editor');
    if (!project) return;

    const d = getDoc(req.params.docId, String(project.id));
    const status = String(d.status ?? 'ready');
    if (status !== 'failed') {
      sendJson(res, 409, { error: 'Document is not in a failed state' });
      return;
    }

    const effectiveAttachmentIds = parseJson<string[]>(String(d.attachment_ids ?? '[]'), []);

    let attachmentRows: Row[] = [];
    if (effectiveAttachmentIds.length > 0) {
      const { rows } = validateAttachmentIds(String(project.id), effectiveAttachmentIds);
      attachmentRows = rows ?? [];
    }

    let goal = composeDocPrompt({
      type: String(d.doc_type) as DocType,
      title: String(d.name),
      audience: String(d.audience ?? ''),
      repos: [],
      knowledge: false,
      decisions: false,
      diagrams: [],
    });

    let preWorkflowId: string | undefined;
    let preWorkDir: string | null = null;
    if (attachmentRows.length > 0) {
      preWorkflowId = newId('w_');
      const projectDir = path.join(config.dataDir, 'projects', String(project.slug));
      preWorkDir = await createWorkDir(preWorkflowId, projectDir);
      const staged = await stageAttachmentsToWorkDir(attachmentRows, preWorkDir);
      goal += buildAttachmentPromptBlock(staged);
    }

    const workflowId = await startDocRun(
      String(project.id),
      String(d.id),
      goal,
      req.user!.id,
      d.lead_agent ? String(d.lead_agent) : null,
      Boolean(d.trust_all_tools),
      { workflowId: preWorkflowId, workDir: preWorkDir },
    );

    if (effectiveAttachmentIds.length > 0) {
      linkAttachmentsToParent(effectiveAttachmentIds, 'doc', String(d.id));
    }

    const updated = getDoc(String(d.id), String(project.id));
    const v = latestVersion(String(d.id));
    sendJson(res, 202, { doc: docView(updated, v) });
  });

  // GET /api/projects/:id/generated-docs/:docId/versions
  router.get('/api/projects/:id/generated-docs/:docId/versions', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id);
    if (!project) return;

    const d = getDoc(req.params.docId, String(project.id));
    const versions = all<Row>(
      'SELECT * FROM generated_doc_versions WHERE doc_id = ? ORDER BY version_num DESC',
      String(d.id),
    );

    sendJson(res, 200, { versions: versions.map(versionView) });
  });

  // GET /api/projects/:id/generated-docs/:docId/download
  router.get('/api/projects/:id/generated-docs/:docId/download', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id);
    if (!project) return;

    const d = getDoc(req.params.docId, String(project.id));
    const format = (req.query.get('format') ?? 'md') as 'md' | 'docx';

    if (!d.latest_version_id) {
      sendJson(res, 404, { error: 'No version available yet' });
      return;
    }

    const v = one<Row>('SELECT * FROM generated_doc_versions WHERE id = ?', String(d.latest_version_id));
    if (!v) {
      sendJson(res, 404, { error: 'Version not found' });
      return;
    }

    const filePath = format === 'docx' ? v.docx_path : v.md_path;
    if (!filePath || !fs.existsSync(String(filePath))) {
      sendJson(res, 404, { error: `No ${format.toUpperCase()} file available` });
      return;
    }

    const buf = fs.readFileSync(String(filePath));
    const mime = format === 'docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'text/markdown';
    const ext = format === 'docx' ? '.docx' : '.md';
    const filename = `${String(d.name).replace(/[^a-z0-9_-]/gi, '_')}${ext}`;

    const res2 = res as any;
    res2.writeHead(200, {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buf.length,
    });
    res2.end(buf);
  });
}
