/**
 * Images and Mermaid diagrams for `make-doc` (NEW-8).
 *
 * - Image files (PNG, JPEG, SVG) are read from inside the base folder only, checked by content, and size-limited.
 * - Mermaid and SVG are rasterised to PNG by an optional headless Chromium-family browser (Chromium, Chrome or
 *   Edge) that runs Mermaid's own bundle from node_modules with securityLevel "strict", no network and a
 *   throw-away profile. When no browser is found or the render fails, callers get a `fallback` reason instead
 *   of an exception, so a document is still produced (the diagram becomes a code block with a note).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const IMAGE_LIMITS = { fileBytes: 15 * 1024 * 1024, mermaidChars: 20_000, mermaidPerDoc: 40, imagesPerDoc: 200, pixels: 8000, renderMs: 60_000 };

export interface Raster {
  type: 'png' | 'jpg';
  data: Buffer;
  pxW: number;
  pxH: number;
  /** Device pixels per CSS pixel; natural display size is px / density. */
  density: number;
}

export type Prepared = { ok: true; image: Raster } | { ok: false; reason: string };

export class ImageError extends Error {}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

function within(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + path.sep);
}

/** Resolve an image path inside baseDir only (also through symlinks). */
export function safeInputPath(baseDir: string, p: unknown, what: string): string {
  if (typeof p !== 'string' || !p.trim()) throw new ImageError(`${what} must be a file path`);
  const root = fs.realpathSync(path.resolve(baseDir));
  const abs = path.resolve(root, p);
  if (!within(root, abs)) throw new ImageError(`${what} must be inside ${root}`);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new ImageError(`${what}: file not found (${p})`);
  }
  if (!within(root, real)) throw new ImageError(`${what} must be inside ${root}`);
  if (!fs.statSync(real).isFile()) throw new ImageError(`${what} is not a file`);
  return real;
}

function pngSize(b: Buffer): { w: number; h: number } | null {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function jpegSize(b: Buffer): { w: number; h: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function looksLikeSvg(b: Buffer): boolean {
  return /<svg[\s>]/i.test(b.subarray(0, 4096).toString('utf8'));
}

function checkPixels(w: number, h: number, what: string): void {
  if (!(w > 0 && h > 0)) throw new ImageError(`${what}: cannot read the image size`);
  if (w > IMAGE_LIMITS.pixels || h > IMAGE_LIMITS.pixels) throw new ImageError(`${what}: image is larger than ${IMAGE_LIMITS.pixels} pixels on a side`);
}

export type Loaded = { kind: 'raster'; image: Raster } | { kind: 'svg'; text: string };

/** Read and validate an image file. PNG and JPEG come back as-is; SVG comes back as text to be rasterised. */
export function loadImageFile(baseDir: string, p: unknown, what: string): Loaded {
  const abs = safeInputPath(baseDir, p, what);
  const ext = path.extname(abs).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.svg'].includes(ext)) throw new ImageError(`${what}: only .png, .jpg, .jpeg and .svg images are supported`);
  if (fs.statSync(abs).size > IMAGE_LIMITS.fileBytes) throw new ImageError(`${what}: image is larger than ${IMAGE_LIMITS.fileBytes / 1024 / 1024} MB`);
  const data = fs.readFileSync(abs);
  if (ext === '.svg') {
    if (!looksLikeSvg(data)) throw new ImageError(`${what}: the file is not an SVG image`);
    return { kind: 'svg', text: data.toString('utf8') };
  }
  const png = pngSize(data);
  const jpg = png ? null : jpegSize(data);
  const size = png ?? jpg;
  if (!size) throw new ImageError(`${what}: the file is not a valid PNG or JPEG image`);
  checkPixels(size.w, size.h, what);
  return { kind: 'raster', image: { type: png ? 'png' : 'jpg', data, pxW: size.w, pxH: size.h, density: 1 } };
}

/* ------------------------------------------------------------------ */
/* Headless rendering                                                  */
/* ------------------------------------------------------------------ */

function findMermaidBundle(): string | null {
  const starts = [path.dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const s of starts) {
    let dir = s;
    for (let i = 0; i < 6; i++) {
      const f = path.join(dir, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
      if (fs.existsSync(f)) return f;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

/** Find a Chromium-family browser: DOC_BROWSER, a Playwright download, or a system install. */
export function findBrowser(): string | null {
  const env = process.env.DOC_BROWSER || process.env.CHROME_PATH;
  if (env) return fs.existsSync(env) ? env : null;
  const home = os.homedir();
  const pw = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(home, 'AppData', 'Local', 'ms-playwright'), path.join(home, '.cache', 'ms-playwright'), path.join(home, 'Library', 'Caches', 'ms-playwright')].filter(Boolean) as string[];
  for (const base of pw) {
    for (const prefix of ['chromium_headless_shell-', 'chromium-']) {
      let dirs: string[] = [];
      try {
        dirs = fs.readdirSync(base).filter((n) => n.startsWith(prefix)).sort().reverse();
      } catch {}
      for (const d of dirs) {
        const root = path.join(base, d);
        for (const rel of ['chrome-headless-shell-win64/chrome-headless-shell.exe', 'chrome-headless-shell-linux/chrome-headless-shell', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
          const f = path.join(root, rel);
          if (fs.existsSync(f)) return f;
        }
      }
    }
  }
  const fixed = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return fixed.find((f) => fs.existsSync(f)) ?? null;
}

export interface RenderItem {
  kind: 'mermaid' | 'svg';
  source: string;
}
type RenderOut = { ok: true; image: Raster } | { ok: false; reason: string };

const SCALE = 2;

function pageHtml(items: RenderItem[], bundleUrl: string): string {
  const data = JSON.stringify({ items, scale: SCALE }).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, ' ');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src file: 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">
<script src="${bundleUrl}"></script></head><body style="margin:0;background:#fff"><div id="stage" style="position:absolute;left:0;top:0"></div><script id="data" type="application/json">${data}</script>
<script>
(async () => {
  const { items, scale } = JSON.parse(document.getElementById('data').textContent);
  const out = [];
  try { mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: 'Arial, sans-serif' }); } catch (e) {}
  for (let i = 0; i < items.length; i++) {
    try {
      let svg = items[i].source;
      if (items[i].kind === 'mermaid') {
        const r = await mermaid.render('d' + i, svg, document.getElementById('stage'));
        svg = r.svg;
      }
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const el = doc.documentElement;
      if (!el || el.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new Error('not valid SVG');
      let w = 0, h = 0;
      const vb = (el.getAttribute('viewBox') || '').trim().split(/[\\s,]+/).map(Number);
      if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { w = vb[2]; h = vb[3]; }
      const aw = parseFloat(el.getAttribute('width') || ''), ah = parseFloat(el.getAttribute('height') || '');
      if (aw > 0 && ah > 0 && !/%/.test(el.getAttribute('width') + el.getAttribute('height'))) { w = aw; h = ah; }
      if (!(w > 0 && h > 0)) throw new Error('the SVG has no width and height or viewBox');
      el.setAttribute('width', String(w)); el.setAttribute('height', String(h));
      if (!el.getAttribute('xmlns')) el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      el.querySelectorAll('script, foreignObject script').forEach((n) => n.remove());
      const text = new XMLSerializer().serializeToString(el);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('the SVG could not be drawn')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text); });
      const c = document.createElement('canvas');
      c.width = Math.ceil(w * scale); c.height = Math.ceil(h * scale);
      if (c.width > 8000 || c.height > 8000) throw new Error('the diagram is too large');
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      out.push({ ok: true, png: c.toDataURL('image/png').split(',')[1], w: c.width, h: c.height });
    } catch (e) {
      out.push({ ok: false, reason: String((e && e.message) || e).slice(0, 300) });
    }
  }
  const pre = document.createElement('pre'); pre.id = 'result'; pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
})();
</script></body></html>`;
}

function probe(): { exe: string | null; bundle: string | null } {
  return { exe: findBrowser(), bundle: findMermaidBundle() };
}

/** Why rendering is unavailable, or null when a browser and the Mermaid bundle were found. */
export function rendererProblem(): string | null {
  const p = probe();
  if (!p.exe) return 'no headless browser was found (install Chromium or Chrome, or set DOC_BROWSER to its path)';
  if (!p.bundle) return 'the Mermaid bundle (node_modules/mermaid/dist/mermaid.min.js) was not found';
  return null;
}

/** Render diagrams/SVGs to PNG in one browser run. Never throws: each item gets its own result. */
export async function renderToPng(items: RenderItem[]): Promise<RenderOut[]> {
  if (!items.length) return [];
  const problem = rendererProblem();
  if (problem) return items.map(() => ({ ok: false as const, reason: problem }));
  const { exe, bundle } = probe();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-render-'));
  try {
    const page = path.join(tmp, 'page.html');
    fs.writeFileSync(page, pageHtml(items, pathToFileURL(bundle!).href));
    const args = [
      '--headless',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--hide-scrollbars',
      `--user-data-dir=${path.join(tmp, 'profile')}`,
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--allow-file-access-from-files',
      `--virtual-time-budget=${Math.min(50_000, 8000 + items.length * 4000)}`,
      '--dump-dom',
    ];
    if (process.env.DOC_BROWSER_NO_SANDBOX === '1' || (typeof process.getuid === 'function' && process.getuid() === 0)) args.push('--no-sandbox');
    args.push(pathToFileURL(page).href);
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(exe!, args, { timeout: IMAGE_LIMITS.renderMs, maxBuffer: 512 * 1024 * 1024, windowsHide: true }, (err, so) => (err && !so ? reject(err) : resolve(String(so))));
    });
    const m = /<pre id="result">([\s\S]*?)<\/pre>/.exec(stdout);
    if (!m) throw new Error('the browser produced no result');
    const unescaped = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const res = JSON.parse(unescaped) as { ok: boolean; png?: string; w?: number; h?: number; reason?: string }[];
    return items.map((_, i): RenderOut => {
      const r = res[i];
      if (!r) return { ok: false, reason: 'the browser stopped before this item' };
      if (!r.ok) return { ok: false, reason: r.reason ?? 'render failed' };
      return { ok: true, image: { type: 'png', data: Buffer.from(r.png!, 'base64'), pxW: r.w!, pxH: r.h!, density: SCALE } };
    });
  } catch (e: any) {
    const why = e?.killed ? 'the browser timed out' : `the browser failed (${String(e?.message ?? e).split('\n')[0].slice(0, 200)})`;
    return items.map(() => ({ ok: false as const, reason: why }));
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  }
}

export function checkMermaidSource(src: unknown, what: string): string {
  if (typeof src !== 'string' || !src.trim()) throw new ImageError(`${what} must be Mermaid text`);
  if (src.length > IMAGE_LIMITS.mermaidChars) throw new ImageError(`${what} is too long (max ${IMAGE_LIMITS.mermaidChars} characters)`);
  if (src.includes('\0')) throw new ImageError(`${what} contains invalid characters`);
  return src;
}
