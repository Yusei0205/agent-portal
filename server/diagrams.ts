/**
 * Architecture diagrams API (P8).
 *
 * A project holds Mermaid (text) or Icon (draw.io) architecture diagrams drawn from its repositories
 * by an agent session. Each diagram has a history of versions; the latest is stored in the project's
 * git repository under docs/diagrams/.
 *
 * Routes:
 *   GET    /api/projects/:id/diagrams                               — list diagrams
 *   POST   /api/projects/:id/diagrams                               — create + start generation
 *   GET    /api/projects/:id/diagrams/:did                          — get diagram with latest version
 *   DELETE /api/projects/:id/diagrams/:did                          — delete
 *   POST   /api/projects/:id/diagrams/:did/refresh                  — start a new generation run
 *   GET    /api/projects/:id/diagrams/:did/versions                 — list versions
 *   GET    /api/projects/:id/diagrams/:did/versions/:vid/download   — download source file
 */

import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, insert, run as dbRun, update } from './db.ts';
import type { Row } from './db.ts';
import { generateId, now, str, badRequest, notFound, parseJson, newId, slugify } from './util.ts';
import { config } from './config.ts';
import { emit } from './events.ts';
import {
  DIAGRAM_KINDS,
  DIAGRAM_LIMITS,
  DiagramError,
  KIND_LABELS,
  composeDiagramPrompt,
  validateMermaid,
  type DiagramKind,
} from './diagram-text.ts';
import {
  CLOUDS,
  CLOUD_LABELS,
  DEFAULT_CLOUD,
  DIAGRAM_STYLES,
  DRAWIO_LIMITS,
  DrawioError,
  STYLE_LABELS,
  validateDrawio,
  type Cloud,
  type DiagramStyle,
} from './drawio.ts';
import { composeIconDiagramPrompt, iconDiagramRules } from './drawio-text.ts';
import { drawioRendererProblem } from './drawio-render.ts';
import { styleChoices } from './diagram-icons.ts';
import { rendererProblem } from './docimage.ts';
import { getRepo } from './repos.ts';
import type { Repo } from './repos.ts';
import {
  validateAttachmentIds,
  stageAttachmentsToWorkDir,
  buildAttachmentPromptBlock,
  linkAttachmentsToParent,
  deleteAttachmentsForParent,
  getAttachmentsView,
} from './ai-attachments.ts';
import { createWorkDir } from './workflows/working-copies.ts';

export { DIAGRAM_KINDS, DIAGRAM_LIMITS, KIND_LABELS, type DiagramKind };

/** Where in the project's git repository the diagrams are kept. */
export const DIAGRAMS_DIR = 'docs/diagrams';

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireProjectAccess(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
  level: 'viewer' | 'editor' = 'viewer',
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
    'SELECT * FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    req.user.id,
  );
  if (!member) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (level === 'editor' && !['owner', 'editor'].includes(String(member.access))) {
    sendJson(res, 403, { error: 'You need editor access for this' });
    return null;
  }
  return project;
}

function readKind(v: unknown): DiagramKind {
  if (!DIAGRAM_KINDS.includes(v as DiagramKind)) {
    throw badRequest(`Kind must be one of: ${DIAGRAM_KINDS.join(', ')}`);
  }
  return v as DiagramKind;
}

function readStyle(v: unknown): DiagramStyle | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (!DIAGRAM_STYLES.includes(v as DiagramStyle)) {
    throw badRequest(`Style must be one of: ${DIAGRAM_STYLES.join(', ')}`);
  }
  return v as DiagramStyle;
}

function readCloud(v: unknown): Cloud | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (!CLOUDS.includes(v as Cloud)) {
    throw badRequest(`Cloud must be one of: ${CLOUDS.join(', ')}`);
  }
  return v as Cloud;
}

function uniqueSlug(projectId: string, title: string): string {
  const base = slugify(title) || 'diagram';
  let slug = base;
  for (let n = 2; one('SELECT 1 FROM diagrams WHERE project_id = ? AND slug = ?', projectId, slug); n++) {
    slug = `${base}-${n}`;
  }
  return slug;
}

function getDiagramRow(projectId: string, diagramId: string): Row {
  const d = one<Row>('SELECT * FROM diagrams WHERE project_id = ? AND id = ?', projectId, diagramId);
  if (!d) throw notFound('Diagram not found');
  return d;
}

function projectDir(project: Row): string {
  return path.join(config.dataDir, 'projects', String(project.slug));
}

function notifyProject(projectId: string, event: string, data: object): void {
  try {
    emit(String(projectId), { type: event, ...data });
  } catch {
    // events are best-effort
  }
}

function pngCapability(): { png: boolean; pngReason: string | null } {
  const reason = rendererProblem();
  return { png: reason === null, pngReason: reason };
}

function iconExportCapability(): { drawio: boolean; png: boolean; svg: boolean; previewReason: string | null } {
  const reason = drawioRendererProblem();
  return { drawio: true, png: reason === null, svg: reason === null, previewReason: reason };
}

function diagramView(d: Row): object {
  const attIds = parseJson<string[]>(String(d.attachment_ids ?? '[]'), []);
  return {
    id: d.id,
    project_id: d.project_id,
    title: d.title,
    slug: d.slug,
    kind: d.kind,
    kind_label: KIND_LABELS[d.kind as DiagramKind] ?? d.kind,
    style: d.style ?? 'mermaid',
    style_label: STYLE_LABELS[(d.style ?? 'mermaid') as DiagramStyle],
    cloud: d.cloud || null,
    cloud_label: d.cloud ? (CLOUD_LABELS[d.cloud as Cloud] ?? d.cloud) : null,
    focus: d.focus ?? '',
    repo_ids: parseJson<string[]>(d.repo_ids as string, []),
    status: d.status,
    error: d.error ?? null,
    retryable: String(d.status) === 'error',
    version: d.version ?? 0,
    stale: Boolean(d.stale),
    pending_workflow_id: d.pending_workflow_id ?? null,
    lead_agent: d.lead_agent ?? '',
    trust_tools: Boolean(d.trust_tools),
    created_by: d.created_by ?? null,
    created_at: d.created_at,
    updated_at: d.updated_at,
    attachments: attIds.length > 0 ? getAttachmentsView(String(d.project_id), attIds) : [],
  };
}

function versionView(v: Row): object {
  return {
    diagram_id: v.diagram_id,
    version: v.version,
    format: v.format ?? 'mermaid',
    style: v.style ?? 'mermaid',
    cloud: v.cloud || null,
    description: v.description ?? '',
    citations: parseJson<string[]>(v.citations as string, []),
    mermaid: v.mermaid ?? '',
    drawio: v.format === 'drawio' ? (v.drawio ?? null) : null,
    workflow_id: v.workflow_id ?? null,
    run_id: v.run_id ?? null,
    created_by: v.created_by ?? null,
    created_at: v.created_at,
  };
}

// ── Diagram generation ────────────────────────────────────────────────────────

/** Build the agent goal prompt for a diagram. */
export function buildDiagramPrompt(
  d: Row,
  repos: Repo[],
): string {
  const style = (d.style ?? 'mermaid') as DiagramStyle;
  const kind = d.kind as DiagramKind;
  const focus = String(d.focus ?? '');
  const cloud = (d.cloud || DEFAULT_CLOUD) as Cloud;

  // Build PromptRepo objects — repositories in our schema don't have a slug field,
  // so we derive one from the name for the prompt.
  const promptRepos = repos.map((r) => ({
    name: r.name,
    slug: r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    default_branch: r.default_branch ?? 'main',
  }));

  if (style === 'icon') {
    return composeIconDiagramPrompt(kind, String(d.title), promptRepos, cloud, focus);
  }
  return composeDiagramPrompt(kind, String(d.title), promptRepos, focus);
}

/** Start a workflow+run to generate (or regenerate) a diagram. */
async function startDiagramGeneration(
  diagramId: string,
  userId: string,
  attachmentRows: Row[] = [],
): Promise<{ workflowId: string }> {
  const d = one<Row>('SELECT * FROM diagrams WHERE id = ?', diagramId);
  if (!d) throw notFound('Diagram not found');

  // Gather repos
  const repoIds = parseJson<string[]>(d.repo_ids as string, []);
  const repos: Repo[] = [];
  for (const id of repoIds) {
    const r = one<Repo>('SELECT * FROM repositories WHERE id = ?', id);
    if (!r) throw badRequest('A repository of this diagram was removed. Create the diagram again.');
    repos.push(r);
  }
  if (!repos.length) throw badRequest('The diagram has no repositories');

  let goal = buildDiagramPrompt(d, repos);

  // Build rules for the agent
  const style = (d.style ?? 'mermaid') as DiagramStyle;
  const rules = style === 'icon' ? iconDiagramRules(String(d.title)) : '';

  // Create workflow
  const workflowId = newId('w_');
  const ts = now();

  // Pre-stage attachment files if provided
  let preWorkDir: string | null = null;
  if (attachmentRows.length > 0) {
    const project = one<Row>('SELECT slug FROM projects WHERE id = ?', String(d.project_id));
    if (project) {
      const projectDir = path.join(config.dataDir, 'projects', String(project.slug));
      preWorkDir = await createWorkDir(workflowId, projectDir);
      const staged = await stageAttachmentsToWorkDir(attachmentRows, preWorkDir);
      goal += buildAttachmentPromptBlock(staged);
    }
  }

  insert('p6_workflows', {
    id: workflowId,
    project_id: String(d.project_id),
    goal,
    status: 'pending',
    engine: 'demo',
    trust_tools: Number(d.trust_tools ?? 0),
    lead_agent: d.lead_agent ? String(d.lead_agent) : null,
    workspace_id: null,
    output_files_enabled: 0,
    repo_ids: String(d.repo_ids),
    iteration_count: 0,
    max_iterations: 1,
    work_dir: preWorkDir,
    created_by: userId,
    created_at: ts,
    updated_at: ts,
  });

  // Mark diagram as generating
  update('diagrams', String(d.id), {
    status: 'generating',
    error: null,
    pending_workflow_id: workflowId,
    workflow_id: workflowId,
    updated_at: ts,
  });

  notifyProject(String(d.project_id), 'diagrams.updated', { id: d.id });
  notifyProject(String(d.project_id), 'workflow.created', { id: workflowId });

  // Kick off the workflow asynchronously
  setTimeout(async () => {
    try {
      const { startRun } = await import('./workflows/driver.ts');
      await startRun(workflowId);
    } catch {
      // runner errors are non-fatal here; status will stay 'generating'
    }
  }, 0);

  return { workflowId };
}

/**
 * Process the output of a completed diagram workflow. Scans the work directory for
 * .mmd or .drawio files written by the agent. Creates a diagram_versions row.
 * Should be called by the agent runner on workflow completion.
 */
export async function processDiagramOutput(
  workflowId: string,
  runId: string,
  workDir: string,
): Promise<void> {
  const d = one<Row>('SELECT * FROM diagrams WHERE workflow_id = ? OR pending_workflow_id = ?', workflowId, workflowId);
  if (!d) return;

  const style = (d.style ?? 'mermaid') as DiagramStyle;
  const ts = now();
  const currentVersion = Number(d.version) || 0;

  try {
    if (style === 'icon') {
      // Look for .drawio file in workDir
      const drawioFile = findDrawioFile(workDir);
      if (!drawioFile) {
        update('diagrams', String(d.id), {
          status: currentVersion > 0 ? 'ready' : 'error',
          error: 'No .drawio file found in run folder',
          pending_workflow_id: null,
          updated_at: ts,
        });
        return;
      }
      const xml = fs.readFileSync(drawioFile, 'utf8');
      let info;
      try {
        info = validateDrawio(xml);
      } catch (e: unknown) {
        update('diagrams', String(d.id), {
          status: currentVersion > 0 ? 'ready' : 'error',
          error: e instanceof DrawioError ? e.message : `Invalid draw.io file: ${String((e as { message?: string })?.message ?? e)}`,
          pending_workflow_id: null,
          updated_at: ts,
        });
        return;
      }
      const newVersion = currentVersion + 1;
      insert('diagram_versions', {
        diagram_id: String(d.id),
        version: newVersion,
        format: 'drawio',
        style: 'icon',
        cloud: String(d.cloud ?? ''),
        mermaid: '',
        drawio: info.xml,
        description: '',
        citations: '[]',
        sources: '[]',
        source_hash: '',
        workflow_id: workflowId,
        run_id: runId,
        created_by: d.created_by ? String(d.created_by) : null,
        created_at: ts,
      });
      update('diagrams', String(d.id), {
        version: newVersion,
        format: 'drawio',
        status: 'ready',
        error: null,
        pending_workflow_id: null,
        updated_at: ts,
      });
    } else {
      // Mermaid: look for .mmd file
      const mmdFile = findMermaidFile(workDir);
      const mmdSource = mmdFile ? fs.readFileSync(mmdFile, 'utf8') : null;

      // Try to get mermaid from run result if no file found
      const run = one<Row>('SELECT * FROM p6_runs WHERE id = ?', runId);
      const result = String(run?.status === 'done' ? (run.result ?? '') : (mmdSource ?? ''));

      // Try to extract from a mermaid fence in the result
      let mermaidSource = mmdSource ?? '';
      if (!mermaidSource) {
        const fenced = /```mermaid\s*\r?\n([\s\S]*?)```/i.exec(result);
        if (fenced) mermaidSource = fenced[1].trim();
      }
      if (!mermaidSource) {
        update('diagrams', String(d.id), {
          status: currentVersion > 0 ? 'ready' : 'error',
          error: 'No Mermaid diagram found in agent output',
          pending_workflow_id: null,
          updated_at: ts,
        });
        return;
      }

      let validated: { source: string; type: string };
      try {
        validated = await validateMermaid(mermaidSource);
      } catch (e: unknown) {
        update('diagrams', String(d.id), {
          status: currentVersion > 0 ? 'ready' : 'error',
          error: e instanceof DiagramError ? e.message : `Invalid Mermaid: ${String((e as { message?: string })?.message ?? e)}`,
          pending_workflow_id: null,
          updated_at: ts,
        });
        return;
      }

      const newVersion = currentVersion + 1;
      insert('diagram_versions', {
        diagram_id: String(d.id),
        version: newVersion,
        format: 'mermaid',
        style: 'mermaid',
        cloud: '',
        mermaid: validated.source,
        drawio: null,
        description: '',
        citations: '[]',
        sources: '[]',
        source_hash: '',
        workflow_id: workflowId,
        run_id: runId,
        created_by: d.created_by ? String(d.created_by) : null,
        created_at: ts,
      });
      update('diagrams', String(d.id), {
        version: newVersion,
        format: 'mermaid',
        status: 'ready',
        error: null,
        pending_workflow_id: null,
        updated_at: ts,
      });
    }

    notifyProject(String(d.project_id), 'diagrams.updated', { id: d.id });
  } catch (e: unknown) {
    update('diagrams', String(d.id), {
      status: currentVersion > 0 ? 'ready' : 'error',
      error: String((e as { message?: string })?.message ?? e).slice(0, 600),
      pending_workflow_id: null,
      updated_at: now(),
    });
  }
}

/** Set a diagram's stale flag and emit an SSE event. */
export function markDiagramStale(diagramId: string): void {
  const d = one<Row>('SELECT * FROM diagrams WHERE id = ?', diagramId);
  if (!d) return;
  update('diagrams', String(d.id), { stale: 1, updated_at: now() });
  notifyProject(String(d.project_id), 'diagrams.updated', { id: d.id, stale: true });
}

// ── File scanning helpers ─────────────────────────────────────────────────────

function findMermaidFile(workDir: string): string | null {
  if (!workDir || !fs.existsSync(workDir)) return null;
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 5) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'repos'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full, depth + 1);
        if (found) return found;
      } else if (entry.isFile() && /\.mmd$/i.test(entry.name)) {
        return full;
      }
    }
    return null;
  };
  return walk(workDir, 0);
}

function findDrawioFile(workDir: string): string | null {
  if (!workDir || !fs.existsSync(workDir)) return null;
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 5) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'repos'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full, depth + 1);
        if (found) return found;
      } else if (entry.isFile() && /\.drawio$/i.test(entry.name)) {
        return full;
      }
    }
    return null;
  };
  return walk(workDir, 0);
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerDiagramRoutes(): void {
  // GET /api/projects/:id/diagrams — list all diagrams
  router.get('/api/projects/:id/diagrams', async (req: PortalRequest, res: PortalResponse) => {
    const project = requireProjectAccess(req, res, req.params.id);
    if (!project) return;

    const rows = all<Row>('SELECT * FROM diagrams WHERE project_id = ? ORDER BY updated_at DESC', String(project.id));
    const stylesInfo = await styleChoices();

    sendJson(res, 200, {
      diagrams: rows.map(diagramView),
      kinds: DIAGRAM_KINDS.map((id) => ({ id, label: KIND_LABELS[id] })),
      styles: stylesInfo,
      clouds: CLOUDS.map((id) => ({ id, label: CLOUD_LABELS[id] })),
      defaultCloud: DEFAULT_CLOUD,
      export: pngCapability(),
      exportIcon: iconExportCapability(),
      limits: {
        mermaidChars: DIAGRAM_LIMITS.mermaidChars,
        repos: DIAGRAM_LIMITS.repos,
        focusChars: DIAGRAM_LIMITS.focusChars,
        perProject: DIAGRAM_LIMITS.perProject,
        drawioBytes: DRAWIO_LIMITS.bytes,
        drawioCells: DRAWIO_LIMITS.cells,
        drawioIcons: DRAWIO_LIMITS.icons,
      },
    });
  });

  // POST /api/projects/:id/diagrams — create + start generation
  router.post('/api/projects/:id/diagrams', async (req: PortalRequest, res: PortalResponse) => {
    const project = requireProjectAccess(req, res, req.params.id, 'editor');
    if (!project) return;

    const body = req.body as Record<string, unknown>;
    const kind = readKind(body.kind);
    const name = str(body.name, 'Name', { max: DIAGRAM_LIMITS.titleChars, optional: true }).trim();
    const style = readStyle(body.style) ?? 'mermaid';
    const cloud = readCloud(body.cloud);
    const focus = str(body.focus, 'Focus', { max: DIAGRAM_LIMITS.focusChars, optional: true }).trim();
    const leadAgent = str(body.leadAgent as string ?? '', 'Lead agent', { max: 200, optional: true }).trim();
    const trustAllTools = Boolean(body.trustAllTools);
    const rawAttachmentIds = Array.isArray(body.attachmentIds) ? (body.attachmentIds as unknown[]).map(String) : [];

    if (cloud && style !== 'icon') throw badRequest('A cloud only applies to the icon style');

    // Validate repo IDs
    const rawRepoIds = Array.isArray(body.repoIds) ? body.repoIds : body.repoId ? [body.repoId] : [];
    const repoIds = [...new Set((rawRepoIds as unknown[]).map(String))];
    if (!repoIds.length) throw badRequest('Pick at least one repository');
    if (repoIds.length > DIAGRAM_LIMITS.repos) throw badRequest(`Pick at most ${DIAGRAM_LIMITS.repos} repositories`);

    // Validate repos belong to this project
    const repos: Repo[] = [];
    for (const id of repoIds) {
      const r = one<Repo>('SELECT * FROM repositories WHERE id = ?', id);
      if (!r) throw badRequest(`Repository ${id} not found`);
      if (String(r.project_id) !== String(project.id)) throw badRequest('That repository belongs to another project');
      repos.push(r);
    }

    // Check per-project limit
    const count = one<{ n: number }>('SELECT COUNT(*) AS n FROM diagrams WHERE project_id = ?', String(project.id))?.n ?? 0;
    if (count >= DIAGRAM_LIMITS.perProject) {
      throw badRequest(`A project can hold at most ${DIAGRAM_LIMITS.perProject} diagrams. Delete one first.`);
    }

    // Build title
    const repoNames = repos.map((r) => r.name);
    const title = name || `${KIND_LABELS[kind]}: ${repoNames.join(', ')}`.slice(0, DIAGRAM_LIMITS.titleChars);

    // Validate attachment IDs before inserting the diagram
    let attachmentRows: Row[] = [];
    if (rawAttachmentIds.length > 0) {
      const { error, rows } = validateAttachmentIds(String(project.id), rawAttachmentIds);
      if (error) throw badRequest(error);
      attachmentRows = rows!;
    }

    const id = newId('dg_');
    const ts = now();

    insert('diagrams', {
      id,
      project_id: String(project.id),
      kind,
      title,
      slug: uniqueSlug(String(project.id), title),
      focus,
      repo_ids: JSON.stringify(repoIds),
      style,
      format: style === 'icon' ? 'drawio' : 'mermaid',
      cloud: cloud ?? (style === 'icon' ? DEFAULT_CLOUD : ''),
      status: 'generating',
      error: null,
      version: 0,
      source_hash: '',
      stale: 0,
      pending_workflow_id: null,
      lead_agent: leadAgent,
      trust_tools: trustAllTools ? 1 : 0,
      workflow_id: null,
      attachment_ids: JSON.stringify(rawAttachmentIds),
      created_by: req.user!.id,
      created_at: ts,
      updated_at: ts,
    });

    let workflowId: string;
    try {
      const gen = await startDiagramGeneration(id, req.user!.id, attachmentRows);
      workflowId = gen.workflowId;
    } catch (e) {
      dbRun('DELETE FROM diagrams WHERE id = ?', id);
      throw e;
    }

    // Link attachments to this diagram
    if (rawAttachmentIds.length > 0) {
      await linkAttachmentsToParent(rawAttachmentIds, 'diagram', id);
    }

    const diagram = one<Row>('SELECT * FROM diagrams WHERE id = ?', id)!;
    sendJson(res, 200, {
      diagram: diagramView(diagram),
      workflowId,
    });
  });

  // GET /api/projects/:id/diagrams/:did — get diagram
  router.get('/api/projects/:id/diagrams/:did', (req: PortalRequest, res: PortalResponse) => {
    const project = requireProjectAccess(req, res, req.params.id);
    if (!project) return;

    const d = getDiagramRow(String(project.id), req.params.did);
    const versions = all<Row>('SELECT * FROM diagram_versions WHERE diagram_id = ? ORDER BY version DESC', String(d.id));
    const latest = versions[0] ?? null;

    sendJson(res, 200, {
      diagram: {
        ...diagramView(d),
        mermaid: latest?.format === 'mermaid' ? (latest.mermaid ?? '') : '',
        drawio: latest?.format === 'drawio' ? (latest.drawio ?? null) : null,
      },
      latestVersion: latest ? versionView(latest) : null,
      export: pngCapability(),
      exportIcon: iconExportCapability(),
    });
  });

  // DELETE /api/projects/:id/diagrams/:did
  router.delete('/api/projects/:id/diagrams/:did', async (req: PortalRequest, res: PortalResponse) => {
    const project = requireProjectAccess(req, res, req.params.id, 'editor');
    if (!project) return;

    const d = getDiagramRow(String(project.id), req.params.did);
    await deleteAttachmentsForParent('diagram', String(d.id));
    dbRun('DELETE FROM diagrams WHERE id = ?', String(d.id));

    notifyProject(String(project.id), 'diagrams.updated', { id: d.id });
    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/diagrams/:did/refresh — redraw diagram
  router.post('/api/projects/:id/diagrams/:did/refresh', async (req: PortalRequest, res: PortalResponse) => {
    const project = requireProjectAccess(req, res, req.params.id, 'editor');
    if (!project) return;

    const d = getDiagramRow(String(project.id), req.params.did);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const style = readStyle(body.style);
    const cloud = readCloud(body.cloud);
    const rawAttachmentIds = Array.isArray(body.attachmentIds)
      ? (body.attachmentIds as unknown[]).map(String)
      : null; // null = use existing

    if (style) {
      update('diagrams', String(d.id), { style, cloud: cloud ?? (style === 'icon' ? DEFAULT_CLOUD : ''), updated_at: now() });
    } else if (cloud) {
      update('diagrams', String(d.id), { cloud, updated_at: now() });
    }

    // Determine which attachment IDs to use: new ones (if provided) or existing
    let effectiveAttachmentIds: string[];
    if (rawAttachmentIds !== null) {
      if (rawAttachmentIds.length > 0) {
        const { error } = validateAttachmentIds(String(project.id), rawAttachmentIds);
        if (error) { sendJson(res, 400, { error }); return; }
      }
      // Replace: unlink old attachments, link new ones
      const oldIds = parseJson<string[]>(String(d.attachment_ids ?? '[]'), []);
      if (oldIds.length > 0) await deleteAttachmentsForParent('diagram', String(d.id));
      effectiveAttachmentIds = rawAttachmentIds;
      update('diagrams', String(d.id), { attachment_ids: JSON.stringify(rawAttachmentIds), updated_at: now() });
    } else {
      effectiveAttachmentIds = parseJson<string[]>(String(d.attachment_ids ?? '[]'), []);
    }

    // Reload updated diagram row and resolve attachment rows
    const dUpdated = getDiagramRow(String(project.id), req.params.did);
    let attachmentRows: Row[] = [];
    if (effectiveAttachmentIds.length > 0) {
      const { rows } = validateAttachmentIds(String(project.id), effectiveAttachmentIds);
      attachmentRows = rows ?? [];
    }

    const gen = await startDiagramGeneration(String(dUpdated.id), req.user!.id, attachmentRows);

    // Link new attachment IDs (if replaced)
    if (rawAttachmentIds !== null && rawAttachmentIds.length > 0) {
      linkAttachmentsToParent(rawAttachmentIds, 'diagram', String(dUpdated.id));
    }

    const updated = one<Row>('SELECT * FROM diagrams WHERE id = ?', String(dUpdated.id))!;
    sendJson(res, 200, {
      diagram: diagramView(updated),
      workflowId: gen.workflowId,
    });
  });

  // POST /api/projects/:id/diagrams/:did/retry — retry a failed (error) generation
  router.post('/api/projects/:id/diagrams/:did/retry', async (req: PortalRequest, res: PortalResponse) => {
    const project = requireProjectAccess(req, res, req.params.id, 'editor');
    if (!project) return;

    const d = getDiagramRow(String(project.id), req.params.did);
    if (String(d.status) !== 'error') {
      sendJson(res, 409, { error: 'Diagram is not in an error state' });
      return;
    }

    const effectiveAttachmentIds = parseJson<string[]>(String(d.attachment_ids ?? '[]'), []);
    let attachmentRows: Row[] = [];
    if (effectiveAttachmentIds.length > 0) {
      const { rows } = validateAttachmentIds(String(project.id), effectiveAttachmentIds);
      attachmentRows = rows ?? [];
    }

    const gen = await startDiagramGeneration(String(d.id), req.user!.id, attachmentRows);

    const updated = one<Row>('SELECT * FROM diagrams WHERE id = ?', String(d.id))!;
    sendJson(res, 202, { diagram: diagramView(updated), workflowId: gen.workflowId });
  });

  // GET /api/projects/:id/diagrams/:did/versions — list versions
  router.get('/api/projects/:id/diagrams/:did/versions', (req: PortalRequest, res: PortalResponse) => {
    const project = requireProjectAccess(req, res, req.params.id);
    if (!project) return;

    const d = getDiagramRow(String(project.id), req.params.did);
    const versions = all<Row>('SELECT * FROM diagram_versions WHERE diagram_id = ? ORDER BY version DESC', String(d.id));

    sendJson(res, 200, { versions: versions.map(versionView) });
  });

  // GET /api/projects/:id/diagrams/:did/versions/:vid/download — download source
  router.get('/api/projects/:id/diagrams/:did/versions/:vid/download', (req: PortalRequest, res: PortalResponse) => {
    const project = requireProjectAccess(req, res, req.params.id);
    if (!project) return;

    const d = getDiagramRow(String(project.id), req.params.did);
    const vid = Number(req.params.vid);
    const v = one<Row>('SELECT * FROM diagram_versions WHERE diagram_id = ? AND version = ?', String(d.id), vid);
    if (!v) throw notFound('Version not found');

    const format = (req.query.get('format') || v.format || 'mermaid') as string;
    const base = `${d.slug}-v${vid}`;

    if (format === 'drawio' || v.format === 'drawio') {
      const xml = String(v.drawio ?? '');
      const buf = Buffer.from(xml, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/vnd.jgraph.mxfile; charset=utf-8',
        'Content-Disposition': `attachment; filename="${base}.drawio"`,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    } else {
      const mmd = String(v.mermaid ?? '');
      const buf = Buffer.from(mmd, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${base}.mmd"`,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    }
  });
}
