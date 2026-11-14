/**
 * Code map: a searchable, viewable graph of each repository's code.
 *
 * The runner builds the graph with graphify when someone presses Build graph on the Repositories page (see code-graph.ts and
 * agent/runner-graph-build.ts) and sends it back as one
 * `code-graph` event (gzip + base64). The portal keeps the latest graph per repository next to the project's other files
 * (durable, so it survives a restart) and answers searches and neighbourhood questions itself, so the browser never has
 * to download a whole graph.
 *
 * A repository has a map per branch (see code-graph.ts). Every route below takes `?branch=`; without it the repository's
 * default branch is meant.
 *
 * Routes (viewer access):
 *   GET /api/projects/:id/code-map                              repositories, whether each has a map, and the branches that have one
 *   GET /api/projects/:id/code-map/:repoId/overview             the biggest communities and best-connected items
 *   GET /api/projects/:id/code-map/:repoId/search?q=            items whose name or file matches
 *   GET /api/projects/:id/code-map/:repoId/node?id=             one item with its neighbours and the links among them
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { config } from './config.ts';
import { persistFile, restoreFile, forgetFile, existsDurable } from './durable-files.ts';
import { getGitReposRepository } from './repositories/git-repos.ts';
import { getMemberRow, getProjectRow } from './project-access.ts';
import { badRequest, notFound, now } from './util.ts';
import type { CompactGraph, CompactNode } from './agent/runner-graph.ts';
import { getCodeGraphStatus, graphBuildUnavailable, resolveGraphId, listCodeGraphs } from './code-graph.ts';
import { graphStem, validBranch } from './graph-id.ts';

export const CODE_MAP_LIMITS = { nodes: 5000, links: 30_000, rawBytes: 32 * 1024 * 1024 } as const;

// ── Which repository a runner's folder name is ────────────────────────────────

/** The runner names a repository by its folder; this remembers which repository (and project) each one was built for. `graphId` names the graph of the branch the run cloned (see graph-id.ts). */
export interface RunnerRepoOwner { repoId: string; projectId: string; repoName: string; graphId?: string }
const owners = new Map<string, RunnerRepoOwner>();
const ownerKey = (name: string, url: string, branch?: string): string => `${name}\n${url}\n${branch ?? ''}`;

export function rememberRunnerRepo(name: string, url: string, owner: RunnerRepoOwner, branch?: string): void {
  owners.set(ownerKey(name, url, branch), owner);
  if (owners.size > 5000) owners.delete(owners.keys().next().value as string);
}

// ── Storage ───────────────────────────────────────────────────────────────────

export interface CodeMapMeta {
  repoId: string;
  repoName: string;
  builtAt: string;
  nodes: number;
  links: number;
  truncated: boolean;
  communities: Record<string, string>;
}
interface StoredMap extends CodeMapMeta { graph: { nodes: CompactNode[]; links: { s: string; t: string; r: string }[] } }

/** The file a graph's map is kept in; `id` is a graph id (a repository id, or `<repoId>@<branch>`). */
async function mapFile(projectId: string, id: string): Promise<string | null> {
  const project = await getProjectRow(projectId);
  if (!project) return null;
  const { repo, branch } = graphStem(id);
  return path.join(config.dataDir, 'projects', String(project.slug), 'code-map', `${repo}${branch ? `@${branch}` : ''}.json`);
}

/** Removes a graph's map (a branch graph that was dropped). */
export async function forgetCodeMap(projectId: string, id: string): Promise<void> {
  const file = await mapFile(projectId, id);
  if (!file) return;
  cache.delete(file);
  try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
  await forgetFile(file);
}

/** Checks the shape of a graph that came from a runner (an older or broken image must not be able to store rubbish). */
export function validateGraph(raw: unknown): CompactGraph | null {
  const g = raw as Partial<CompactGraph> | null;
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.links)) return null;
  if (g.nodes.length === 0 || g.nodes.length > CODE_MAP_LIMITS.nodes || g.links.length > CODE_MAP_LIMITS.links) return null;
  const ok = g.nodes.every((n) => n && typeof n.i === 'string' && typeof n.l === 'string' && typeof n.f === 'string' && typeof n.c === 'number');
  if (!ok || !g.links.every((e) => e && typeof e.s === 'string' && typeof e.t === 'string' && typeof e.r === 'string')) return null;
  return { nodes: g.nodes, links: g.links, communities: g.communities && typeof g.communities === 'object' ? g.communities : {}, truncated: Boolean(g.truncated) };
}

export async function storeCodeGraph(owner: RunnerRepoOwner, encoded: string): Promise<boolean> {
  let raw: unknown;
  try {
    raw = JSON.parse(zlib.gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: CODE_MAP_LIMITS.rawBytes }).toString('utf8'));
  } catch { return false; }
  const graph = validateGraph(raw);
  if (!graph) return false;
  const file = await mapFile(owner.projectId, owner.graphId ?? owner.repoId);
  if (!file) return false;
  const stored: StoredMap = {
    repoId: owner.repoId, repoName: owner.repoName, builtAt: now(), nodes: graph.nodes.length, links: graph.links.length,
    truncated: graph.truncated, communities: graph.communities, graph: { nodes: graph.nodes, links: graph.links },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stored));
  cache.delete(file);
  await persistFile(file, 'application/json').catch(() => { /* kept locally; the next build stores it again */ });
  return true;
}

/**
 * Called for every event a runner streams. Takes the `code-graph` ones (returns true: do not pass them on) and stores them.
 * `payload.repos` is the repository list the run was started with, which says which repository a folder name is.
 */
export async function takeRunnerEvent(payload: Record<string, unknown>, ev: unknown): Promise<boolean> {
  const e = ev as { type?: string; repo?: unknown; encoding?: unknown; data?: unknown };
  if (e?.type !== 'code-graph') return false;
  try {
    if (e.encoding !== 'gzip-base64' || typeof e.data !== 'string' || typeof e.repo !== 'string') return true;
    const list = Array.isArray(payload.repos) ? payload.repos as { name?: string; url?: string; branch?: string }[] : [];
    const spec = list.find((r) => r?.name === e.repo);
    const owner = spec ? owners.get(ownerKey(String(spec.name), String(spec.url ?? ''), String((spec as { branch?: string }).branch ?? ''))) : undefined;
    if (owner) await storeCodeGraph(owner, e.data);
  } catch (err) {
    console.warn('[code-map] could not store a code graph:', err instanceof Error ? err.message : err);
  }
  return true;
}

// ── Reading and querying ──────────────────────────────────────────────────────

interface Loaded {
  meta: CodeMapMeta;
  byId: Map<string, CompactNode>;
  adj: Map<string, { other: string; r: string; dir: 'out' | 'in' }[]>;
  links: { s: string; t: string; r: string }[];
  degree: Map<string, number>;
}
const cache = new Map<string, { mtime: number; value: Loaded }>();

async function load(projectId: string, id: string): Promise<Loaded | null> {
  const file = await mapFile(projectId, id);
  if (!file) return null;
  if (!fs.existsSync(file)) await restoreFile(file).catch(() => false);
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.value;
  let stored: StoredMap;
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredMap; } catch { return null; }
  const { graph, ...meta } = stored;
  const byId = new Map(graph.nodes.map((n) => [n.i, n]));
  const adj = new Map<string, { other: string; r: string; dir: 'out' | 'in' }[]>();
  const degree = new Map<string, number>();
  const add = (a: string, v: { other: string; r: string; dir: 'out' | 'in' }): void => { const l = adj.get(a); if (l) l.push(v); else adj.set(a, [v]); degree.set(a, (degree.get(a) ?? 0) + 1); };
  for (const e of graph.links) { add(e.s, { other: e.t, r: e.r, dir: 'out' }); add(e.t, { other: e.s, r: e.r, dir: 'in' }); }
  const value: Loaded = { meta, byId, adj, links: graph.links, degree };
  cache.set(file, { mtime: st.mtimeMs, value });
  if (cache.size > 8) cache.delete(cache.keys().next().value as string);
  return value;
}

const view = (m: Loaded, n: CompactNode): CompactNode & { d: number } => ({ ...n, d: m.degree.get(n.i) ?? 0 });
const norm = (s: string): string => s.toLowerCase().replace(/\(\)$/, '');

/** Items whose name or file matches the query, best match first. Exported for tests. */
export function searchNodes(nodes: Iterable<CompactNode>, degree: Map<string, number>, query: string, limit = 30): CompactNode[] {
  const q = norm(query.trim());
  if (!q) return [];
  const scored: { n: CompactNode; score: number }[] = [];
  for (const n of nodes) {
    if (n.k === 'external') continue;
    const l = norm(n.l);
    const f = n.f.toLowerCase();
    let score = 0;
    if (l === q) score = 100;
    else if (l.startsWith(q)) score = 70;
    else if (l.includes(q)) score = 50;
    else if (f.includes(q)) score = 20;
    else continue;
    scored.push({ n, score: score + Math.min(15, Math.log2(1 + (degree.get(n.i) ?? 0)) * 3) + (n.k === 'file' ? -5 : 0) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.n);
}

/** An item's own neighbours as the Code map shows them beside it: the few best connected, and how many more there are. */
export interface NodeKids { nodes: (CompactNode & { d: number; r: string; dir: 'out' | 'in' })[]; more: number }

/**
 * One item, its neighbours (most connected first), the links among all of them, and for each neighbour up to `kids` of its own
 * neighbours (the small items drawn beside it). An item that is already shown as a neighbour, or as the middle one, is not repeated
 * as somebody's kid, and different neighbours prefer different kids. Exported for tests.
 */
export function neighbourhood(m: Pick<Loaded, 'byId' | 'adj' | 'degree' | 'links'>, id: string, max = 60, kids = 3): { nodes: (CompactNode & { d: number })[]; links: { s: string; t: string; r: string }[]; more: number; children: Record<string, NodeKids> } | null {
  const center = m.byId.get(id);
  if (!center) return null;
  const all = m.adj.get(id) ?? [];
  const seen = new Set<string>([id]);
  const picked: string[] = [];
  for (const a of [...all].sort((x, y) => (m.degree.get(y.other) ?? 0) - (m.degree.get(x.other) ?? 0))) {
    if (seen.has(a.other) || !m.byId.has(a.other)) continue;
    seen.add(a.other);
    if (picked.length < max) picked.push(a.other);
  }
  const keep = new Set([id, ...picked]);
  const links: { s: string; t: string; r: string }[] = [];
  for (const k of keep) {
    for (const a of m.adj.get(k) ?? []) if (a.dir === 'out' && keep.has(a.other)) links.push({ s: k, t: a.other, r: a.r });
  }
  const nodes = [...keep].map((k) => { const n = m.byId.get(k)!; return { ...n, d: m.degree.get(k) ?? 0 }; });

  const children: Record<string, NodeKids> = {};
  const taken = new Set<string>();
  for (const p of picked) {
    const options: NodeKids['nodes'] = [];
    const once = new Set<string>();
    for (const a of m.adj.get(p) ?? []) {
      const n = m.byId.get(a.other);
      if (!n || keep.has(a.other) || once.has(a.other) || n.k === 'external') continue;
      once.add(a.other);
      options.push({ ...n, d: m.degree.get(a.other) ?? 0, r: a.r, dir: a.dir });
    }
    options.sort((x, y) => (taken.has(x.i) ? 1 : 0) - (taken.has(y.i) ? 1 : 0) || y.d - x.d);
    const chosen = options.slice(0, kids);
    for (const c of chosen) taken.add(c.i);
    children[p] = { nodes: chosen, more: Math.max(0, options.length - chosen.length) };
  }
  return { nodes, links: links.slice(0, 400), more: Math.max(0, seen.size - 1 - picked.length), children };
}

// ── Routes ────────────────────────────────────────────────────────────────────

async function projectFor(req: PortalRequest, res: PortalResponse): Promise<string | null> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return null; }
  const project = await getProjectRow(req.params.id);
  if (!project) { sendJson(res, 404, { error: 'Project not found' }); return null; }
  if (!req.user.is_admin && !(await getMemberRow(req.params.id, req.user.id))) { sendJson(res, 404, { error: 'Project not found' }); return null; }
  return String(project.id);
}

async function loadFor(req: PortalRequest, projectId: string): Promise<Loaded> {
  const repo = await getGitReposRepository().getByIdForProject(req.params.repoId, projectId);
  if (!repo) throw notFound('Repository not found');
  const def = repo.default_branch ? String(repo.default_branch) : '';
  const asked = req.query.get('branch');
  if (asked && !validBranch(asked)) throw badRequest('That is not a valid branch name.');
  const branch = asked || def;
  const id = resolveGraphId(req.params.repoId, branch, def) ?? (asked ? null : req.params.repoId);
  const m = id ? await load(projectId, id) : null;
  if (!m) throw notFound(asked ? `No code map for the branch ${asked} yet` : 'No code map for this repository yet');
  return m;
}

export function registerCodeMapRoutes(): void {
  router.get('/api/projects/:id/code-map', async (req: PortalRequest, res: PortalResponse) => {
    const projectId = await projectFor(req, res);
    if (!projectId) return;
    const repos = await getGitReposRepository().listByProject(projectId);
    const out = [];
    for (const r of repos) {
      const def = r.default_branch ? String(r.default_branch) : '';
      const id = resolveGraphId(String(r.id), def, def) ?? String(r.id);
      const m = await load(projectId, id);
      // The branches that have a graph; whether each has a map is told from its file, without reading it.
      const branches = [];
      for (const g of listCodeGraphs(String(r.id), def)) {
        const file = await mapFile(projectId, g.id);
        branches.push({ branch: g.branch, state: g.status.state, nodes: g.status.nodes ?? 0, builtAt: g.status.state === 'ready' ? g.status.at : null, hasMap: file ? await existsDurable(file) : false, isDefault: g.branch === def });
      }
      out.push({
        id: r.id, name: r.name, hasMap: Boolean(m), builtAt: m?.meta.builtAt ?? null, nodes: m?.meta.nodes ?? 0, links: m?.meta.links ?? 0, truncated: m?.meta.truncated ?? false,
        graph: getCodeGraphStatus(id), defaultBranch: def, branches,
      });
    }
    sendJson(res, 200, { repos: out, buildUnavailable: graphBuildUnavailable() });
  });

  router.get('/api/projects/:id/code-map/:repoId/overview', async (req: PortalRequest, res: PortalResponse) => {
    const projectId = await projectFor(req, res);
    if (!projectId) return;
    const m = await loadFor(req, projectId);
    const bySize = new Map<number, CompactNode[]>();
    for (const n of m.byId.values()) if (n.k !== 'external') { const l = bySize.get(n.c); if (l) l.push(n); else bySize.set(n.c, [n]); }
    const communities = [...bySize.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12).map(([c, list]) => ({
      id: c, name: m.meta.communities[String(c)] ?? `Group ${c}`, size: list.length,
      top: list.sort((a, b) => (m.degree.get(b.i) ?? 0) - (m.degree.get(a.i) ?? 0)).slice(0, 5).map((n) => view(m, n)),
    }));
    const top = [...m.byId.values()].filter((n) => n.k === 'function' || n.k === 'class').sort((a, b) => (m.degree.get(b.i) ?? 0) - (m.degree.get(a.i) ?? 0)).slice(0, 12).map((n) => view(m, n));
    sendJson(res, 200, { meta: m.meta, communities, top });
  });

  router.get('/api/projects/:id/code-map/:repoId/search', async (req: PortalRequest, res: PortalResponse) => {
    const projectId = await projectFor(req, res);
    if (!projectId) return;
    const q = String(req.query.get('q') ?? '').slice(0, 120);
    if (q.trim().length < 1) throw badRequest('Type something to search for');
    const m = await loadFor(req, projectId);
    sendJson(res, 200, { results: searchNodes(m.byId.values(), m.degree, q).map((n) => view(m, n)) });
  });

  router.get('/api/projects/:id/code-map/:repoId/node', async (req: PortalRequest, res: PortalResponse) => {
    const projectId = await projectFor(req, res);
    if (!projectId) return;
    const m = await loadFor(req, projectId);
    const out = neighbourhood(m, String(req.query.get('id') ?? ''));
    if (!out) throw notFound('Item not found in the code map');
    sendJson(res, 200, { ...out, centerId: String(req.query.get('id')) });
  });
}
