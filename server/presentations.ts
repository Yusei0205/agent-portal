/**
 * Presentations API (P9, NEW-7).
 *
 * Routes:
 *   GET    /api/projects/:id/presentations               — list
 *   POST   /api/projects/:id/presentations               — create + start agent session
 *   GET    /api/projects/:id/presentations/:presId       — get
 *   DELETE /api/projects/:id/presentations/:presId       — delete
 *   POST   /api/projects/:id/presentations/:presId/refresh — re-run
 *   GET    /api/projects/:id/presentations/:presId/download — download .pptx
 */
import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, insert, run as dbRun, update } from './db.ts';
import type { Row } from './db.ts';
import { newId, now, badRequest, notFound, str } from './util.ts';
import {
  PRESENTATION_SOURCES,
  PRESENTATION_LIMITS,
  composePresentationPrompt,
  readSlideCount,
  templateBlock,
  type PresentationSourceKind,
} from './presentation-text.ts';
import { pptxSlides } from './convert.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireProjectAccess(
  req: PortalRequest,
  res: any,
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
  if (level === 'editor' && String(member.role) === 'viewer') {
    sendJson(res, 403, { error: 'Editors and above can create presentations' });
    return null;
  }
  return project;
}

function presView(p: Row) {
  return {
    id: p.id,
    project_id: p.project_id,
    name: p.name,
    source_kind: p.source_kind,
    source_ref: p.source_ref ?? null,
    topic: p.topic ?? null,
    slide_count: p.slide_count ?? 12,
    audience: p.audience ?? null,
    diagram_style: p.diagram_style ?? 'mermaid',
    diagram_cloud: p.diagram_cloud ?? null,
    lead_agent: p.lead_agent ?? null,
    trust_all_tools: Boolean(p.trust_all_tools),
    pptx_path: p.pptx_path ?? null,
    preview_json: p.preview_json ? JSON.parse(String(p.preview_json)) : null,
    workflow_id: p.workflow_id ?? null,
    stale: Boolean(p.stale),
    created_by: p.created_by ?? null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

function getPresentation(presId: string, projectId: string): Row {
  const p = one<Row>('SELECT * FROM presentations WHERE id = ? AND project_id = ?', presId, projectId);
  if (!p) throw notFound('Presentation not found');
  return p;
}

async function startPresRun(
  projectId: string,
  presId: string,
  goal: string,
  userId: string,
  leadAgent?: string | null,
  trustAllTools?: boolean,
): Promise<string> {
  const workflowId = newId('w_');
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
    created_by: userId,
    created_at: ts,
    updated_at: ts,
  });

  setTimeout(async () => {
    try {
      const { startRun } = await import('./workflows/driver.ts');
      await startRun(workflowId);
    } catch (e) {
      console.error('[presentations] Failed to start run:', e);
    }
  }, 0);

  return workflowId;
}

function buildSourceBlock(p: Row): string {
  const kind = String(p.source_kind) as PresentationSourceKind;
  switch (kind) {
    case 'topic':
      return `Topic: ${String(p.topic ?? '')}`;
    case 'document':
      return `Source: a generated document (id: ${String(p.source_ref ?? '')}).`;
    case 'session':
      return `Source: a previous session (id: ${String(p.source_ref ?? '')}).`;
    case 'diagram':
      return `Source: an architecture diagram (id: ${String(p.source_ref ?? '')}).`;
    default:
      return '';
  }
}

// ── processPresentationOutput ─────────────────────────────────────────────────

/**
 * Called by the agent runner on completion. Scans workDir for .pptx file,
 * generates slide preview JSON, saves to presentations.preview_json.
 */
export async function processPresentationOutput(workflowId: string, runId: string, workDir: string): Promise<void> {
  // Find the presentation linked to this workflow
  const p = one<Row>(
    'SELECT * FROM presentations WHERE workflow_id = ?',
    workflowId,
  );
  if (!p) return;

  let pptxPath: string | null = null;
  let previewJson: string | null = null;

  try {
    if (fs.existsSync(workDir)) {
      const files = fs.readdirSync(workDir);
      const pptxFile = files.find((f) => f.endsWith('.pptx'));
      if (pptxFile) {
        pptxPath = path.join(workDir, pptxFile);

        // Generate slide preview
        try {
          const slides = await pptxSlides(pptxPath);
          previewJson = JSON.stringify(slides);
        } catch (e) {
          console.error('[presentations] Failed to generate preview:', e);
        }
      }
    }
  } catch { /* best effort */ }

  const ts = now();
  update('presentations', String(p.id), {
    pptx_path: pptxPath,
    preview_json: previewJson,
    stale: 0,
    updated_at: ts,
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerPresentationRoutes(): void {
  // GET /api/projects/:id/presentations
  router.get('/api/projects/:id/presentations', async (req: PortalRequest, res: any) => {
    const project = requireProjectAccess(req, res, req.params.id);
    if (!project) return;

    const rows = all<Row>(
      'SELECT * FROM presentations WHERE project_id = ? ORDER BY created_at DESC',
      String(project.id),
    );

    sendJson(res, 200, {
      presentations: rows.map(presView),
      source_kinds: [...PRESENTATION_SOURCES],
      limits: { perProject: PRESENTATION_LIMITS.perProject, slidesMin: PRESENTATION_LIMITS.slidesMin, slidesMax: PRESENTATION_LIMITS.slidesMax },
    });
  });

  // POST /api/projects/:id/presentations
  router.post('/api/projects/:id/presentations', async (req: PortalRequest, res: any) => {
    const project = requireProjectAccess(req, res, req.params.id, 'editor');
    if (!project) return;

    const body = req.body as Record<string, unknown>;
    const name = str(body.name as string, 'Name', { max: PRESENTATION_LIMITS.titleChars });
    const sourceKind = body.sourceKind as string;
    if (!PRESENTATION_SOURCES.includes(sourceKind as PresentationSourceKind)) {
      throw badRequest(`sourceKind must be one of: ${PRESENTATION_SOURCES.join(', ')}`);
    }
    const sourceRef = str((body.sourceRef as string) ?? '', 'sourceRef', { max: 200, optional: true }) || null;
    const topic = str((body.topic as string) ?? '', 'topic', { max: PRESENTATION_LIMITS.topicChars, optional: true }) || null;

    if (sourceKind === 'topic' && !topic) {
      throw badRequest('topic is required when sourceKind is "topic"');
    }
    if (sourceKind !== 'topic' && !sourceRef) {
      throw badRequest('sourceRef is required when sourceKind is not "topic"');
    }

    let slideCount: number;
    try {
      slideCount = readSlideCount(body.slideCount);
    } catch {
      slideCount = PRESENTATION_LIMITS.slidesDefault;
    }

    const audience = str((body.audience as string) ?? '', 'audience', { max: PRESENTATION_LIMITS.audienceChars, optional: true }) || null;
    const diagramStyle = (body.diagramStyle as string) ?? 'mermaid';
    const leadAgent = str((body.leadAgent as string) ?? '', 'leadAgent', { max: 200, optional: true }) || null;
    const trustAllTools = Boolean(body.trustAllTools);

    // Check per-project limit
    const count = (one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM presentations WHERE project_id = ?',
      String(project.id),
    )?.n ?? 0);
    if (count >= PRESENTATION_LIMITS.perProject) {
      throw badRequest(`A project can hold at most ${PRESENTATION_LIMITS.perProject} presentations`);
    }

    const id = newId('pres_');
    const ts = now();

    // We need to build the goal before inserting so we can pass the row data
    const tempRow: Row = {
      id, project_id: String(project.id), name, source_kind: sourceKind,
      source_ref: sourceRef, topic, slide_count: slideCount,
      audience, diagram_style: diagramStyle, lead_agent: leadAgent,
      trust_all_tools: trustAllTools ? 1 : 0,
    } as unknown as Row;

    const sourceBlock = buildSourceBlock(tempRow);
    const tplBlock = templateBlock({ mode: 'none' });

    const goal = composePresentationPrompt({
      kind: sourceKind as PresentationSourceKind,
      title: name,
      audience: audience ?? '',
      slides: slideCount,
      source: sourceBlock,
      template: tplBlock,
    });

    insert('presentations', {
      id,
      project_id: String(project.id),
      name,
      source_kind: sourceKind,
      source_ref: sourceRef,
      topic,
      slide_count: slideCount,
      audience,
      diagram_style: diagramStyle,
      diagram_cloud: null,
      lead_agent: leadAgent,
      trust_all_tools: trustAllTools ? 1 : 0,
      pptx_path: null,
      preview_json: null,
      workflow_id: null,
      stale: 0,
      created_by: req.user!.id,
      created_at: ts,
      updated_at: ts,
    });

    const workflowId = await startPresRun(
      String(project.id),
      id,
      goal,
      req.user!.id,
      leadAgent,
      trustAllTools,
    );

    // Link the workflow to the presentation
    update('presentations', id, { workflow_id: workflowId, updated_at: now() });

    const p = one<Row>('SELECT * FROM presentations WHERE id = ?', id)!;
    sendJson(res, 200, { presentation: presView(p), workflowId });
  });

  // GET /api/projects/:id/presentations/:presId
  router.get('/api/projects/:id/presentations/:presId', async (req: PortalRequest, res: any) => {
    const project = requireProjectAccess(req, res, req.params.id);
    if (!project) return;

    const p = getPresentation(req.params.presId, String(project.id));
    sendJson(res, 200, { presentation: presView(p) });
  });

  // DELETE /api/projects/:id/presentations/:presId
  router.delete('/api/projects/:id/presentations/:presId', async (req: PortalRequest, res: any) => {
    const project = requireProjectAccess(req, res, req.params.id, 'editor');
    if (!project) return;

    const p = getPresentation(req.params.presId, String(project.id));
    dbRun('DELETE FROM presentations WHERE id = ?', String(p.id));
    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/presentations/:presId/refresh
  router.post('/api/projects/:id/presentations/:presId/refresh', async (req: PortalRequest, res: any) => {
    const project = requireProjectAccess(req, res, req.params.id, 'editor');
    if (!project) return;

    const p = getPresentation(req.params.presId, String(project.id));

    const sourceBlock = buildSourceBlock(p);
    const tplBlock = templateBlock({ mode: 'none' });

    const goal = composePresentationPrompt({
      kind: String(p.source_kind) as PresentationSourceKind,
      title: String(p.name),
      audience: String(p.audience ?? ''),
      slides: Number(p.slide_count ?? 12),
      source: sourceBlock,
      template: tplBlock,
    });

    const workflowId = await startPresRun(
      String(project.id),
      String(p.id),
      goal,
      req.user!.id,
      p.lead_agent ? String(p.lead_agent) : null,
      Boolean(p.trust_all_tools),
    );

    update('presentations', String(p.id), { workflow_id: workflowId, updated_at: now() });
    sendJson(res, 200, { workflowId });
  });

  // GET /api/projects/:id/presentations/:presId/download
  router.get('/api/projects/:id/presentations/:presId/download', async (req: PortalRequest, res: any) => {
    const project = requireProjectAccess(req, res, req.params.id);
    if (!project) return;

    const p = getPresentation(req.params.presId, String(project.id));

    if (!p.pptx_path || !fs.existsSync(String(p.pptx_path))) {
      sendJson(res, 404, { error: 'No PPTX file available yet' });
      return;
    }

    const buf = fs.readFileSync(String(p.pptx_path));
    const filename = `${String(p.name).replace(/[^a-z0-9_-]/gi, '_')}.pptx`;

    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buf.length,
    });
    res.end(buf);
  });
}
