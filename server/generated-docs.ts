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
import { persistFile, restoreFile, syncTreeDown } from './durable-files.ts';
import { parseManifest, shotBoard, boardCounts, buildGuideHtml, shotPath, type ShotRow } from './guide-bundle.ts';
import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getGeneratedDocRepository } from './repositories/generated-docs-data.ts';
import { getSessionsRepository } from './repositories/sessions.ts';
import type { Row } from './db.ts';
import { newId, now, badRequest, notFound, str, parseJson } from './util.ts';
import { emit } from './events.ts';
import { config } from './config.ts';
import {
  DOC_TYPES,
  DOC_TYPE_LABELS,
  DOC_LIMITS,
  composeDocPrompt,
  GUIDE_LIMITS,
  type DocType,
  type DocGuide,
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
import { buildDocxReport } from './docgen.ts';
import { loadGuideAccounts, setGuideRun } from './guide-accounts.ts';
import { assertNotBlocked } from './testing/ssrf.ts';
import { resolveCreateAi, type CreateAi } from './create-ai.ts';
import { repoContext, stageKnowledgeDocs, type DocSources } from './create-context.ts';

import { getMemberRow, getProjectRow } from './project-access.ts';
export { DOC_TYPES, DOC_TYPE_LABELS, DOC_LIMITS, type DocType };

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * The user guide options of a request: the address of the system, the test account roles to sign in with and any extra hosts the
 * sign-in uses. Only for the user guide type, and only when the person asked for screenshots. Checked here (the address is a public
 * web address, the roles exist in the project, the engine has the browser); nothing secret is kept, only role names and hosts.
 */
export async function parseGuide(raw: unknown, docType: string, projectId: string, engine: string): Promise<DocGuide | undefined> {
  if (docType !== 'user-guide' || !raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (o.screenshots !== true) return undefined;

  const address = typeof o.url === 'string' ? o.url.trim() : '';
  let url: URL;
  try { url = new URL(address); } catch { throw badRequest('Give the address of the system, for example https://app.example.com'); }
  if (!/^https?:$/.test(url.protocol) || address.length > GUIDE_LIMITS.urlChars || url.username || url.password) throw badRequest('The address must be a web address (https://...) without a user name or password in it');
  // The browser runs in AWS and reaches the internet only: a private or local address would never open.
  try { await assertNotBlocked(url.href, false); } catch { throw badRequest('That address cannot be reached from the cloud browser (it is a local, private or blocked address). Use an address on the internet.'); }

  const known = await loadGuideAccounts(projectId);
  const roles: string[] = [];
  for (const r of Array.isArray(o.roles) ? o.roles : []) {
    const match = typeof r === 'string' ? known.find((a) => a.role.toLowerCase() === r.trim().toLowerCase()) : undefined;
    if (!match) throw badRequest(`The test account "${String(r).slice(0, 60)}" does not exist in this project. Add it under Test accounts first.`);
    if (!roles.includes(match.role)) roles.push(match.role);
  }
  if (roles.length > GUIDE_LIMITS.roles) throw badRequest(`Choose at most ${GUIDE_LIMITS.roles} test accounts`);

  const hosts = [url.hostname.toLowerCase()];
  for (const h of Array.isArray(o.hosts) ? o.hosts : []) {
    const host = typeof h === 'string' ? h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || host.length > 253) throw badRequest(`"${String(h).slice(0, 80)}" is not a host name (for example login.example.com)`);
    if (!hosts.includes(host)) hosts.push(host);
  }
  if (hosts.length > GUIDE_LIMITS.hosts) throw badRequest(`At most ${GUIDE_LIMITS.hosts} hosts`);

  // The screenshots need the AgentCore browser, which only the Kiro and Claude cloud runners have (and only when the deployment turned it on).
  if (engine !== 'demo' && (process.env.PORTAL_AGENTCORE_BROWSER !== '1' || (engine !== 'kiro' && engine !== 'claude-code'))) {
    throw badRequest(process.env.PORTAL_AGENTCORE_BROWSER !== '1'
      ? 'Screenshots need the cloud browser, which is not turned on in this portal (deploy with -c agentcoreBrowser=true).'
      : 'Screenshots need a Kiro or Claude model: only those have the cloud browser. Choose one, or turn screenshots off.');
  }
  return { url: url.href, screenshots: true, roles, hosts, ...(o.manualSignIn === true ? { manualSignIn: true } : {}) };
}

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

async function docView(d: Row, version?: Row | null) {
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
    workflow_id: d.workflow_id ?? version?.workflow_id ?? null,
    created_by: d.created_by ?? null,
    created_at: d.created_at,
    latest_version: version ? versionView(version) : null,
    attachments: attIds.length > 0 ? await getAttachmentsView(String(d.project_id), attIds) : [],
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

/** The pictures under screenshots/ next to a document (a user guide's screenshots), at most 200. */
function listScreenshots(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 200 || e.isSymbolicLink()) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(abs, depth + 1);
      else if (e.isFile() && /\.(png|jpe?g)$/i.test(e.name)) out.push(abs);
    }
  };
  walk(path.join(dir, 'screenshots'), 0);
  return out;
}

/** A guide's Markdown, its pictures (relative paths) and the shot board built from them. Null when the version has no Markdown. */
async function guideBoard(v: Row): Promise<{ dir: string; md: string; files: string[]; rows: ShotRow[] } | null> {
  const mdFile = v.md_path ? String(v.md_path) : '';
  if (!mdFile || !(await restoreFile(mdFile))) return null;
  const dir = path.dirname(mdFile);
  const md = fs.readFileSync(mdFile, 'utf8');
  // On the cloud portal each instance has its own disk: bring the pictures and the manifest in first.
  await syncTreeDown(path.join(dir, 'screenshots'));
  const files = listScreenshots(dir).map((abs) => shotPath(path.relative(dir, abs).split(path.sep).join('/').replace(/^screenshots\//, '')));
  const manifestFile = path.join(dir, 'screenshots', 'manifest.jsonl');
  const manifest = fs.existsSync(manifestFile) ? parseManifest(fs.readFileSync(manifestFile, 'utf8')).shots : [];
  return { dir, md, files, rows: shotBoard(md, files, manifest) };
}

async function getDoc(docId: string, projectId: string): Promise<Row> {
  const d = (await getGeneratedDocRepository().getById(docId, projectId)) as unknown as Row | null;
  if (!d) throw notFound('Document not found');
  return d;
}

async function latestVersion(docId: string): Promise<Row | null> {
  return ((await getGeneratedDocRepository().getLatestVersion(docId)) as unknown as Row | null) ?? null;
}

/**
 * The prompt and the staged inputs of a document run: the chosen repositories (cloned by the runner), chosen
 * project documents (Markdown under docs/md/) and attachments (under attachments/).
 */
async function prepareDocRun(
  project: Row,
  doc: { type: DocType; title: string; audience: string },
  sources: DocSources,
  attachmentRows: Row[],
): Promise<{ goal: string; preWorkflowId?: string; preWorkDir: string | null; repoIds: string[]; guide?: DocGuide }> {
  const { repoIds, promptRepos } = await repoContext(String(project.id), sources.repoIds, DOC_LIMITS.repos);
  const wantDocs = (sources.docIds?.length ?? 0) > 0;
  let preWorkflowId: string | undefined;
  let preWorkDir: string | null = null;
  let stagedAttachments: Awaited<ReturnType<typeof stageAttachmentsToWorkDir>> = [];
  let stagedDocs = 0;
  if (attachmentRows.length > 0 || wantDocs) {
    preWorkflowId = newId('w_');
    const projectDir = path.join(config.dataDir, 'projects', String(project.slug));
    preWorkDir = await createWorkDir(preWorkflowId, projectDir);
    if (attachmentRows.length > 0) stagedAttachments = await stageAttachmentsToWorkDir(attachmentRows, preWorkDir);
    if (wantDocs) stagedDocs = await stageKnowledgeDocs(String(project.id), String(project.slug), sources.docIds, preWorkDir);
  }
  let goal = composeDocPrompt({
    type: doc.type,
    title: doc.title,
    audience: doc.audience,
    description: sources.description,
    repos: promptRepos,
    knowledge: stagedDocs > 0,
    decisions: false,
    diagrams: [],
    guide: sources.guide,
  });
  if (stagedAttachments.length) goal += buildAttachmentPromptBlock(stagedAttachments);
  return { goal, preWorkflowId, preWorkDir, repoIds, guide: sources.guide?.screenshots ? sources.guide : undefined };
}

async function startDocRun(
  projectId: string,
  docId: string,
  goal: string,
  userId: string,
  leadAgent?: string | null,
  trustAllTools?: boolean,
  preconfig?: { workflowId?: string; workDir?: string | null; repoIds?: string[]; guide?: DocGuide },
  ai?: CreateAi,
): Promise<string> {
  const workflowId = preconfig?.workflowId ?? newId('w_');
  const ts = now();
  const aiChoice = ai ?? await resolveCreateAi(userId, {});

  const sessions = getSessionsRepository();
  await sessions.createWorkflow({
    id: workflowId,
    project_id: projectId,
    goal,
    status: 'pending',
    engine: aiChoice.engine,
    // A one-shot cloud run cannot ask for approval, and the agent has to write the file.
    trust_tools: aiChoice.engine === 'demo' ? (trustAllTools ? 1 : 0) : 1,
    lead_agent: leadAgent ?? null,
    workspace_id: null,
    output_files_enabled: 0,
    repo_ids: JSON.stringify(preconfig?.repoIds ?? []),
    iteration_count: 0,
    max_iterations: 1,
    credential_id: aiChoice.credential_id,
    model: aiChoice.model,
    created_by: userId,
    created_at: ts,
    updated_at: ts,
  });
  if (preconfig?.workDir) await sessions.updateWorkflow(workflowId, { work_dir: preconfig.workDir });
  // A user guide with screenshots: which test account roles this run may sign in with (the runner gets the accounts when it starts).
  if (preconfig?.guide?.screenshots) await setGuideRun(workflowId, { roles: preconfig.guide.roles, hosts: preconfig.guide.hosts, manualSignIn: preconfig.guide.manualSignIn === true });

  // Mark the doc as generating so startup recovery can flip it to failed on crash
  await getGeneratedDocRepository().update(docId, { status: 'generating', error: null, workflow_id: workflowId });

  emit(projectId, { type: 'workflow.created', workflowId });

  setTimeout(async () => {
    try {
      // Repositories first: the agent starts only once every chosen repository is on the runner.
      const prepError = await (await import('./agent/repo-prep.ts')).prepareReposBeforeRun(workflowId);
      if (prepError) {
        await getGeneratedDocRepository().update(docId, { status: 'failed', error: prepError });
        await sessions.updateWorkflow(workflowId, { status: 'failed', updated_at: now() });
        emit(projectId, { type: 'workflow.updated', workflowId, status: 'failed' });
        return;
      }
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
  const wf = await getSessionsRepository().getWorkflowById(workflowId);
  if (!wf?.project_id) return;
  const d = ((await getGeneratedDocRepository().listByProject(wf.project_id)) as unknown as Row[])
    .find((x) => x.workflow_id === workflowId);
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

  // The agent writes Markdown; the Word file is built from it here.
  let warnings: string | null = null;
  if (mdPath && !docxPath) {
    try {
      // Pictures (a user guide's screenshots) are read from the folder of the Markdown file.
      const built = await buildDocxReport(fs.readFileSync(mdPath, 'utf8'), undefined, { baseDir: path.dirname(mdPath) });
      docxPath = path.join(path.dirname(mdPath), 'document.docx');
      fs.writeFileSync(docxPath, built.buffer);
      if (built.warnings.length) warnings = built.warnings.slice(0, 5).join(' ') + (built.warnings.length > 5 ? ` (${built.warnings.length - 5} more)` : '');
    } catch (e) {
      warnings = `The Word file could not be built (${String((e as { message?: string })?.message ?? e).slice(0, 200)}). The Markdown is available.`;
    }
  }
  if (!mdPath) {
    // Nothing to download: say so instead of showing a document that cannot be opened.
    await getGeneratedDocRepository().update(String(d.id), {
      status: 'failed',
      error: 'The agent finished without leaving a Markdown file. Try again, or choose a different model.',
    });
    return;
  }

  if (mdPath) await persistFile(mdPath, 'text/markdown');
  // The screenshots of a user guide stay with the document, for the Word file's pictures and for the zip download.
  for (const shot of listScreenshots(path.dirname(mdPath))) await persistFile(shot, 'image/png');
  // Where each picture came from (role, page, boxes), when the run wrote it: the shot board and the HTML guide use it.
  const manifestFile = path.join(path.dirname(mdPath), 'screenshots', 'manifest.jsonl');
  if (fs.existsSync(manifestFile)) await persistFile(manifestFile, 'application/x-ndjson');
  if (docxPath) await persistFile(docxPath);

  // Get next version number
  const versionNum = (await getGeneratedDocRepository().getMaxVersionNum(String(d.id))) + 1;

  const versionId = newId('gdv_');
  const ts = now();

  await getGeneratedDocRepository().createVersion({
    id: versionId,
    doc_id: String(d.id),
    version_num: versionNum,
    md_path: mdPath,
    docx_path: docxPath,
    warnings,
    workflow_id: workflowId,
    created_at: ts,
  });

  await getGeneratedDocRepository().update(String(d.id), {
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

    const docs = (await getGeneratedDocRepository().listByProject(String(project.id))) as unknown as Row[];

    const result = await Promise.all(docs.map(async (d) => {
      const v = d.latest_version_id
        ? await latestVersion(String(d.id))
        : null;
      return await docView(d, v);
    }));

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

    const rawSources = (typeof body.sources === 'object' && body.sources !== null)
      ? body.sources as { repoIds?: string[]; docIds?: string[]; diagramIds?: string[] }
      : {};
    const description = str((body.description as string) ?? '', 'description', { max: DOC_LIMITS.descriptionChars, optional: true });
    // Kept with the sources, so a refresh or retry writes from the same context.
    const sources: DocSources = { ...rawSources, ...(description ? { description } : {}) };
    const diagramStyle = (body.diagramStyle as string) ?? 'mermaid';
    const diagramCloud = (body.diagramCloud as string | undefined) ?? null;
    const audience = str((body.audience as string) ?? '', 'audience', { max: DOC_LIMITS.audienceChars, optional: true });
    const leadAgent = str((body.leadAgent as string) ?? '', 'leadAgent', { max: 200, optional: true }) || null;
    const trustAllTools = Boolean(body.trustAllTools);
    const rawAttachmentIds = Array.isArray(body.attachmentIds) ? (body.attachmentIds as unknown[]).map(String) : [];

    // Validate attachment IDs
    let attachmentRows: Row[] = [];
    if (rawAttachmentIds.length > 0) {
      const { error, rows } = await validateAttachmentIds(String(project.id), rawAttachmentIds);
      if (error) throw badRequest(error);
      attachmentRows = rows!;
    }

    // Check per-project limit
    const count = await getGeneratedDocRepository().countByProject(String(project.id));
    if (count >= DOC_LIMITS.perProject) {
      throw badRequest(`A project can hold at most ${DOC_LIMITS.perProject} generated documents`);
    }

    // Which sign-in and model run it (checked before anything is created), then the prompt and the staged inputs.
    const ai = await resolveCreateAi(req.user!.id, body);
    const guide = await parseGuide(body.guide, docType, String(project.id), ai.engine);
    if (guide) sources.guide = guide;
    const { goal, preWorkflowId, preWorkDir, repoIds } = await prepareDocRun(
      project,
      { type: docType as DocType, title: name, audience: audience ?? '' },
      sources,
      attachmentRows,
    );

    const id = newId('gd_');
    const ts = now();

    await getGeneratedDocRepository().create({
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
      { workflowId: preWorkflowId, workDir: preWorkDir ?? undefined, repoIds, guide },
      ai,
    );

    // Link attachments to this document
    if (rawAttachmentIds.length > 0) {
      await linkAttachmentsToParent(rawAttachmentIds, 'doc', id);
    }

    const d = (await getDoc(id, String(project.id)));
    sendJson(res, 200, { doc: await docView(d, null), workflowId });
  });

  // GET /api/projects/:id/generated-docs/:docId
  router.get('/api/projects/:id/generated-docs/:docId', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id);
    if (!project) return;

    const d = await getDoc(req.params.docId, String(project.id));
    const v = await latestVersion(String(d.id));
    sendJson(res, 200, { doc: await docView(d, v) });
  });

  // DELETE /api/projects/:id/generated-docs/:docId
  router.delete('/api/projects/:id/generated-docs/:docId', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id, 'editor');
    if (!project) return;

    const d = await getDoc(req.params.docId, String(project.id));
    await deleteAttachmentsForParent('doc', String(d.id));
    await getGeneratedDocRepository().delete(String(d.id));
    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/generated-docs/:docId/refresh
  router.post('/api/projects/:id/generated-docs/:docId/refresh', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id, 'editor');
    if (!project) return;

    const d = await getDoc(req.params.docId, String(project.id));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawAttachmentIds = Array.isArray(body.attachmentIds) ? (body.attachmentIds as unknown[]).map(String) : null;

    // Determine effective attachment IDs
    let effectiveAttachmentIds: string[];
    if (rawAttachmentIds !== null) {
      if (rawAttachmentIds.length > 0) {
        const { error } = await validateAttachmentIds(String(project.id), rawAttachmentIds);
        if (error) { sendJson(res, 400, { error }); return; }
      }
      // Replace old attachments
      const oldIds = parseJson<string[]>(String(d.attachment_ids ?? '[]'), []);
      if (oldIds.length > 0) await deleteAttachmentsForParent('doc', String(d.id));
      effectiveAttachmentIds = rawAttachmentIds;
      await getGeneratedDocRepository().update(String(d.id), { attachment_ids: JSON.stringify(rawAttachmentIds) });
    } else {
      effectiveAttachmentIds = parseJson<string[]>(String(d.attachment_ids ?? '[]'), []);
    }

    let attachmentRows: Row[] = [];
    if (effectiveAttachmentIds.length > 0) {
      const { rows } = await validateAttachmentIds(String(project.id), effectiveAttachmentIds);
      attachmentRows = rows ?? [];
    }

    const sources = parseJson<DocSources>(String(d.sources_json ?? '{}'), {});
    const ai = await resolveCreateAi(req.user!.id, body);
    const { goal, preWorkflowId, preWorkDir, repoIds, guide } = await prepareDocRun(
      project,
      { type: String(d.doc_type) as DocType, title: String(d.name), audience: String(d.audience ?? '') },
      sources,
      attachmentRows,
    );

    const workflowId = await startDocRun(
      String(project.id),
      String(d.id),
      goal,
      req.user!.id,
      d.lead_agent ? String(d.lead_agent) : null,
      Boolean(d.trust_all_tools),
      { workflowId: preWorkflowId, workDir: preWorkDir ?? undefined, repoIds, guide },
      ai,
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

    const d = await getDoc(req.params.docId, String(project.id));
    const status = String(d.status ?? 'ready');
    if (status !== 'failed') {
      sendJson(res, 409, { error: 'Document is not in a failed state' });
      return;
    }

    const effectiveAttachmentIds = parseJson<string[]>(String(d.attachment_ids ?? '[]'), []);

    let attachmentRows: Row[] = [];
    if (effectiveAttachmentIds.length > 0) {
      const { rows } = await validateAttachmentIds(String(project.id), effectiveAttachmentIds);
      attachmentRows = rows ?? [];
    }

    const sources = parseJson<DocSources>(String(d.sources_json ?? '{}'), {});
    const ai = await resolveCreateAi(req.user!.id, ((req.body ?? {}) as Record<string, unknown>));
    const { goal, preWorkflowId, preWorkDir, repoIds, guide } = await prepareDocRun(
      project,
      { type: String(d.doc_type) as DocType, title: String(d.name), audience: String(d.audience ?? '') },
      sources,
      attachmentRows,
    );

    const workflowId = await startDocRun(
      String(project.id),
      String(d.id),
      goal,
      req.user!.id,
      d.lead_agent ? String(d.lead_agent) : null,
      Boolean(d.trust_all_tools),
      { workflowId: preWorkflowId, workDir: preWorkDir ?? undefined, repoIds, guide },
      ai,
    );

    if (effectiveAttachmentIds.length > 0) {
      linkAttachmentsToParent(effectiveAttachmentIds, 'doc', String(d.id));
    }

    const updated = await getDoc(String(d.id), String(project.id));
    const v = await latestVersion(String(d.id));
    sendJson(res, 202, { doc: await docView(updated, v) });
  });

  // GET /api/projects/:id/generated-docs/:docId/versions
  router.get('/api/projects/:id/generated-docs/:docId/versions', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id);
    if (!project) return;

    const d = await getDoc(req.params.docId, String(project.id));
    const versions = (await getGeneratedDocRepository().listVersions(String(d.id))) as unknown as Row[];

    sendJson(res, 200, { versions: versions.map(versionView) });
  });

  // GET /api/projects/:id/generated-docs/:docId/shots — the shot board of a guide: which pictures are placed in the text,
  // which are not, which the text shows but are missing, and which could not be taken
  router.get('/api/projects/:id/generated-docs/:docId/shots', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id);
    if (!project) return;
    const d = await getDoc(req.params.docId, String(project.id));
    const v = await latestVersion(String(d.id));
    const board = v ? await guideBoard(v) : null;
    if (!board) { sendJson(res, 200, { shots: [], counts: boardCounts([]) }); return; }
    sendJson(res, 200, { shots: board.rows, counts: boardCounts(board.rows) });
  });

  // GET /api/projects/:id/generated-docs/:docId/download
  router.get('/api/projects/:id/generated-docs/:docId/download', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireProjectAccess(req, res, req.params.id);
    if (!project) return;

    const d = await getDoc(req.params.docId, String(project.id));
    const format = (req.query.get('format') ?? 'md') as 'md' | 'docx' | 'zip' | 'html';

    if (!d.latest_version_id) {
      sendJson(res, 404, { error: 'No version available yet' });
      return;
    }

    const v = await latestVersion(String(d.id));
    if (!v) {
      sendJson(res, 404, { error: 'Version not found' });
      return;
    }

    if (format === 'html') {
      // One page (index.html) with its screenshots/ folder, zipped: open index.html after unpacking.
      const board = await guideBoard(v);
      if (!board) { sendJson(res, 404, { error: 'No Markdown file available' }); return; }
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      zip.file('index.html', buildGuideHtml({ title: String(d.name), md: board.md, rows: board.rows, generatedAt: now() }));
      for (const row of board.rows) {
        if (row.status !== 'placed' && row.status !== 'unplaced') continue;
        const abs = path.resolve(board.dir, ...row.file.split('/'));
        if (!abs.startsWith(path.resolve(board.dir) + path.sep) || !fs.existsSync(abs)) continue;
        zip.file(row.file, fs.readFileSync(abs), { createFolders: false });
      }
      const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      (res as any).writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${String(d.name).replace(/[^a-z0-9_-]/gi, '_')}-guide.zip"`,
        'Content-Length': out.length,
      });
      (res as any).end(out);
      return;
    }

    if (format === 'zip') {
      // The Markdown with the screenshots it shows (and the Word file): a bare .md would lose its pictures.
      const mdFile = v.md_path ? String(v.md_path) : '';
      if (!mdFile || !(await restoreFile(mdFile))) { sendJson(res, 404, { error: 'No Markdown file available' }); return; }
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      const md = fs.readFileSync(mdFile, 'utf8');
      const dir = path.dirname(mdFile);
      zip.file('document.md', md);
      if (v.docx_path && (await restoreFile(String(v.docx_path)))) zip.file('document.docx', fs.readFileSync(String(v.docx_path)));
      for (const ref of new Set([...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => path.posix.normalize(m[1])))) {
        if (!/^screenshots\/.+\.(png|jpe?g)$/i.test(ref) || ref.split('/').includes('..')) continue;
        const abs = path.resolve(dir, ...ref.split('/'));
        if (!abs.startsWith(path.resolve(dir) + path.sep) || !(await restoreFile(abs))) continue;
        zip.file(ref, fs.readFileSync(abs), { createFolders: false });
      }
      const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      (res as any).writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${String(d.name).replace(/[^a-z0-9_-]/gi, '_')}.zip"`,
        'Content-Length': out.length,
      });
      (res as any).end(out);
      return;
    }

    const filePath = format === 'docx' ? v.docx_path : v.md_path;
    if (!filePath || !(await restoreFile(String(filePath)))) {
      sendJson(res, 404, { error: String(v.warnings ?? '').trim() || `No ${format.toUpperCase()} file available` });
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
