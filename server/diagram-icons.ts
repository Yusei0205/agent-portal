/**
 * Icon diagrams (draw.io, FR-DIAG-9): the file and rendering side that diagrams.ts uses.
 *
 *   - finding the `.drawio` file a diagram session wrote in its run folder,
 *   - the cache of pictures (PNG and SVG) drawn from a stored version, in DATA_DIR/diagram-renders/<project>/,
 *   - putting a stored diagram where `make-doc` can read it (a project file), for documents and decks,
 *   - what the server can do right now (the tool pack for drawing, the viewer files and a browser for pictures).
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './config.ts';
import { withLock } from './util.ts';
import { DiagramError, NoDiagramError } from './diagram-text.ts';
import { DRAWIO_LIMITS, STYLE_LABELS } from './drawio.ts';
import { DRAWIO_FILE, parseDiagramFileReply } from './drawio-text.ts';
import { drawioRendererProblem, renderDrawio } from './drawio-render.ts';
import { DRAWIO_PACK_HINT, drawioPackState } from './drawio-pack.ts';
import { rendererProblem } from './docimage.ts';
import { all } from './db.ts';
import { repoDir, type Repo } from './repos.ts';
import { detectCloud } from './drawio-cloud.ts';
import { DEFAULT_CLOUD, type Cloud } from './drawio.ts';

/* ------------------------------------------------------------------ */
/* What the server can do                                              */
/* ------------------------------------------------------------------ */

export interface StyleInfo {
  id: 'mermaid' | 'icon';
  label: string;
  /** Can a diagram be drawn in this style now? */
  available: boolean;
  /** Why not (null when it can). The UI shows it next to the disabled choice. */
  reason: string | null;
  /** Can pictures (PNG, SVG) and previews be made from it now? A diagram is stored and downloadable either way. */
  preview: { available: boolean; reason: string | null };
}

/** The drawing styles and what each needs, for the diagram list. */
export async function styleChoices(): Promise<StyleInfo[]> {
  const mermaidProblem = rendererProblem();
  const tool = drawioPackState().tool;
  const previewProblem = drawioRendererProblem();
  return [
    { id: 'mermaid', label: STYLE_LABELS.mermaid, available: true, reason: null, preview: { available: mermaidProblem === null, reason: mermaidProblem } },
    {
      id: 'icon',
      label: STYLE_LABELS.icon,
      available: tool.ok,
      reason: tool.ok ? null : `${tool.reason}. ${DRAWIO_PACK_HINT}.`,
      preview: { available: previewProblem === null, reason: previewProblem },
    },
  ];
}

/** The cloud to use when the person did not say: what the given repositories (or all of the project's) point to, else AWS. */
export function cloudFor(projectId: string, repoIds?: string[]): { cloud: Cloud; detected: boolean; signals: string[] } {
  try {
    const repos = all<Repo>('SELECT * FROM repos WHERE project_id = ?', projectId).filter((r) => !repoIds || repoIds.includes(r.id));
    const g = detectCloud(repos.map((r) => repoDir(r)));
    return { cloud: g.cloud, detected: g.detected, signals: g.signals };
  } catch {
    return { cloud: DEFAULT_CLOUD, detected: false, signals: [] };
  }
}

/* ------------------------------------------------------------------ */
/* The file a session wrote                                            */
/* ------------------------------------------------------------------ */

function findDrawioFiles(base: string): { rel: string; mtime: number }[] {
  const out: { rel: string; mtime: number }[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 6 || !fs.existsSync(dir) || out.length > 200) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'vault', 'repos'].includes(e.name) || e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r, depth + 1);
      else if (e.isFile() && /\.drawio$/i.test(e.name)) out.push({ rel: r, mtime: fs.statSync(path.join(dir, e.name)).mtimeMs });
    }
  };
  walk(base, '', 0);
  return out;
}

/**
 * The draw.io file a finished run wrote: the one its reply named ("Diagram file: ..."), else diagram.drawio, else the newest
 * .drawio in its run folder. A follow-up shares the first run's folder, so only files written since it began count.
 * Throws NoDiagramError when there is none (a follow-up then changes nothing) and DiagramError when it cannot be read.
 */
export function readIconFile(projectRoot: string, workDir: string | undefined, reply: string, followUp: boolean, startedAt: string): { xml: string; rel: string } {
  if (!workDir) throw new DiagramError('The session left no run folder, so there is no diagram file to read.');
  const base = path.resolve(projectRoot, workDir);
  if (base !== path.resolve(projectRoot) && !base.startsWith(path.resolve(projectRoot) + path.sep)) throw new DiagramError('The session run folder is outside the project.');
  const since = followUp ? Date.parse(startedAt) - 1000 : 0;
  const found = findDrawioFiles(base).filter((f) => !(since && f.mtime < since));
  const said = parseDiagramFileReply(reply).path;
  let rel: string | null = null;
  if (said) {
    for (const cand of [path.resolve(projectRoot, said), path.resolve(base, said)]) {
      if (cand.startsWith(base + path.sep) && /\.drawio$/i.test(cand) && fs.existsSync(cand) && fs.statSync(cand).isFile() && fs.statSync(cand).mtimeMs >= since) rel = path.relative(base, cand).replace(/\\/g, '/');
    }
  }
  rel = rel ?? found.find((f) => f.rel === DRAWIO_FILE)?.rel ?? found.sort((a, b) => b.mtime - a.mtime)[0]?.rel ?? null;
  if (!rel) {
    throw new NoDiagramError(
      followUp
        ? `The follow-up wrote no new ${DRAWIO_FILE} in the run folder, so nothing was changed.`
        : `The agent did not write a draw.io file (${DRAWIO_FILE}) in its run folder. Ask it to draw the diagram and save it as ${DRAWIO_FILE}.`,
    );
  }
  const file = path.join(base, rel);
  const size = fs.statSync(file).size;
  if (size > DRAWIO_LIMITS.bytes * 2) throw new DiagramError(`The diagram file is too large (${Math.round(size / 1000)} KB, max ${Math.round(DRAWIO_LIMITS.bytes / 1000)} KB). Draw fewer icons or split it into several diagrams.`);
  return { xml: fs.readFileSync(file, 'utf8'), rel };
}

/* ------------------------------------------------------------------ */
/* Pictures of a stored version                                        */
/* ------------------------------------------------------------------ */

const rendersDir = (projectId: string) => dataPath('diagram-renders', projectId);

export type IconPicture = { ok: true; png: Buffer; svg: string; notes: string[] } | { ok: false; reason: string };

/**
 * PNG and SVG of one stored version, drawn on first use and kept (a version never changes). One browser run at a time.
 * Never throws; a server with no pack files or no browser answers with the reason.
 */
export async function iconPicture(projectId: string, diagramId: string, version: number, xml: string): Promise<IconPicture> {
  const dir = rendersDir(projectId);
  const png = path.join(dir, `${diagramId}-v${version}.png`);
  const svg = path.join(dir, `${diagramId}-v${version}.svg`);
  try {
    if (fs.existsSync(png) && fs.existsSync(svg)) return { ok: true, png: fs.readFileSync(png), svg: fs.readFileSync(svg, 'utf8'), notes: [] };
  } catch {
    /* draw it again */
  }
  const problem = drawioRendererProblem();
  if (problem) return { ok: false, reason: problem };
  const [res] = await withLock('diagram-render', () => renderDrawio([{ xml }]));
  if (!res.ok) return { ok: false, reason: res.reason };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(png, res.png);
    fs.writeFileSync(svg, res.svg);
  } catch {
    /* the picture is still returned; it will be drawn again next time */
  }
  return { ok: true, png: res.png, svg: res.svg, notes: res.notes };
}

/** Forget the pictures of a diagram (when it is deleted). */
export function clearIconPictures(projectId: string, diagramId: string): void {
  try {
    const dir = rendersDir(projectId);
    for (const f of fs.readdirSync(dir)) if (f.startsWith(`${diagramId}-v`)) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    /* nothing to clear */
  }
}

/* ------------------------------------------------------------------ */
/* For documents and decks                                             */
/* ------------------------------------------------------------------ */

/**
 * Put one stored version where make-doc can read it, as a file inside the project folder, and return its path relative
 * to the project folder (what an `image` element or Markdown image takes). The current version is the project's
 * docs/diagrams/<slug>.drawio (the file kept in git); an older one goes to .portal/diagram-versions/.
 */
export function stageIconFile(projectRoot: string, diagramsDir: string, slug: string, version: number, current: boolean, xml: string): string {
  const rel = current ? `${diagramsDir}/${slug}.drawio` : `.portal/diagram-versions/${slug}-v${version}.drawio`;
  const abs = path.join(projectRoot, ...rel.split('/'));
  try {
    const text = xml.replace(/\s+$/, '') + '\n';
    if (!fs.existsSync(abs) || fs.readFileSync(abs, 'utf8') !== text) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
  } catch {
    /* the reader reports a missing file as a warning */
  }
  return rel;
}
