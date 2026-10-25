/**
 * The "Icon diagrams" tool pack (FR-PROV-7, FR-DIAG-9): where its files live on disk and what is installed.
 *
 * The pack holds three things, all installed by an admin from Settings > Tools (tool-packs.ts) and all pinned:
 *
 *   mcp/            the official draw.io MCP server (@drawio/mcp, an exact version) installed with npm and no install
 *                   scripts. Only its two read-only lookup tools are ever given to an agent (see ALLOWED_TOOLS).
 *   shape-index.json  the ~10,000 shape styles of its search_shapes tool. The package does not ship it (it downloads it
 *                   from a CDN on first use), so the pack downloads it once, checks its SHA-256 and the server reads the
 *                   local copy: no network at run time.
 *   renderer/       the official draw.io viewer bundle and its shape and stencil libraries (three JavaScript files from
 *                   the jgraph/drawio release, SHA-256 checked) plus, best effort, the Azure icon images. The headless
 *                   browser of docimage.ts draws diagrams from them offline (drawio-render.ts).
 *
 * `pack.json` is written last, so a half-finished install never looks installed. Everything is injectable for tests
 * through ICON_DIAGRAMS_DIR (the pack folder) and DRAWIO_RENDERER_DIR (the renderer folder only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './config.ts';

export const DRAWIO_PACK_ID = 'drawio';

/** Pinned versions: changed deliberately, with the new checksums, never "latest". */
export const DRAWIO_PIN = {
  mcpPackage: '@drawio/mcp',
  mcpVersion: '1.10.0',
  /** npm's own integrity value of that tarball; checked against the lockfile npm wrote. */
  mcpIntegrity: 'sha512-WvMLOe/ELqJ58K3Rrv4Vp6NXfliOGXPDsMgcXN6d7qDqg0vmCTL306s4wnDQcM3I4n48Pl0B97eO0Dx+q/XzIQ==',
  /** The drawio-mcp commit whose shape-search/search-index.json is used (the one the 1.10.0 release was cut from). */
  indexCommit: 'c9cc979ea66d440a0735ef3a4289962af11ee2de',
  indexSha256: 'd32fe548100b0c73fbbbc66609e294a2dd766b1e52406774ba68f6a8449c5186',
  /** The jgraph/drawio release the renderer files come from. */
  viewerTag: 'v32.6.1',
};

export interface RendererFile {
  /** Name on disk inside the renderer folder. */
  name: string;
  /** Path inside src/main/webapp of the jgraph/drawio repository. */
  source: string;
  sha256: string;
}

export const RENDERER_FILES: RendererFile[] = [
  { name: 'viewer-static.min.js', source: 'js/viewer-static.min.js', sha256: '0c12ccf10dcaf0d0ef40ca60a5bc881ba27b57e076797ee39bce46602371f769' },
  { name: 'shapes.min.js', source: 'js/shapes-14-6-5.min.js', sha256: '7641614ce721412ec70d6e5a0db7e9ca51118d547828e0308af7c42ed5bcf104' },
  { name: 'stencils.min.js', source: 'js/stencils.min.js', sha256: 'b6acdcf854ae27368cbc3108564d93de1eec91090126d2ebca9a69664bbecb3d' },
];

/** Icon image folders (draw.io `image=img/lib/...` styles) the pack tries to install; others are refused by the checks. */
export const IMAGE_LIBS = ['azure2'] as const;

/** The only tools of the draw.io MCP server an agent may call: lookups. The others open a browser or read any local file. */
export const DRAWIO_ALLOWED_TOOLS = ['search_shapes', 'get_drawio_reference'] as const;

export const DRAWIO_INTEGRATION_NAME = 'Icon diagrams';
export const DRAWIO_PACK_HINT = 'An admin can install the Icon diagrams pack under Settings › Tools';
/** Stable id of the shared integration, created when the pack is installed. */
export const BUILTIN_DRAWIO_ID = 'in_drawio_builtin__v1';

export function packDir(): string {
  return process.env.ICON_DIAGRAMS_DIR ? path.resolve(process.env.ICON_DIAGRAMS_DIR) : dataPath('tools', 'icon-diagrams');
}
export const mcpPrefix = (): string => path.join(packDir(), 'mcp');
export const mcpEntry = (): string => path.join(mcpPrefix(), 'node_modules', '@drawio', 'mcp', 'src', 'index.js');
export const shapeIndexFile = (): string => path.join(packDir(), 'shape-index.json');
export const mcpCacheDir = (): string => path.join(packDir(), 'cache');
export const manifestFile = (): string => path.join(packDir(), 'pack.json');
export const rendererDir = (): string => (process.env.DRAWIO_RENDERER_DIR ? path.resolve(process.env.DRAWIO_RENDERER_DIR) : path.join(packDir(), 'renderer'));

export interface PackManifest {
  mcp: string;
  indexSha256: string;
  viewerTag: string;
  images: string[];
  installedAt: string;
}

export function readManifest(): PackManifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile(), 'utf8'));
    return m && typeof m === 'object' ? (m as PackManifest) : null;
  } catch {
    return null;
  }
}

export interface PartState {
  ok: boolean;
  reason: string;
}

export interface DrawioPackState {
  /** The MCP server and the shape index: what an agent needs to draw. */
  tool: PartState;
  /** The viewer bundle: what the portal needs to show and export pictures. Only the files; the browser is checked by drawio-render.ts. */
  renderer: PartState;
}

const fileOk = (f: string): boolean => {
  try {
    return fs.statSync(f).isFile() && fs.statSync(f).size > 0;
  } catch {
    return false;
  }
};

export function rendererFilesProblem(): string | null {
  const dir = rendererDir();
  const missing = RENDERER_FILES.filter((f) => !fileOk(path.join(dir, f.name))).map((f) => f.name);
  return missing.length ? `the draw.io viewer files are not installed (${missing.join(', ')} missing in ${dir})` : null;
}

export function drawioPackState(): DrawioPackState {
  const m = readManifest();
  const missing: string[] = [];
  if (!m) missing.push('the install record (pack.json)');
  if (!fileOk(mcpEntry())) missing.push('the draw.io MCP server');
  if (!fileOk(shapeIndexFile())) missing.push('the shape index');
  const tool: PartState = missing.length
    ? { ok: false, reason: `Icon diagrams tool pack is not installed (${missing.join(', ')} missing)` }
    : { ok: true, reason: `draw.io MCP ${m!.mcp} and its shape index are installed` };
  const rp = rendererFilesProblem();
  const renderer: PartState = rp ? { ok: false, reason: rp } : { ok: true, reason: `draw.io viewer ${m?.viewerTag ?? 'files'} installed` };
  return { tool, renderer };
}
