/**
 * Images and Mermaid diagram rendering stubs.
 * Full implementation will be added in P9; this provides the exports needed by diagram-text.ts and drawio-render.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const IMAGE_LIMITS = {
  fileBytes: 15 * 1024 * 1024,
  mermaidChars: 20_000,
  mermaidPerDoc: 40,
  imagesPerDoc: 200,
  pixels: 8000,
  renderMs: 60_000,
};

export class ImageError extends Error {}

export interface Raster {
  type: 'png' | 'jpg';
  data: Buffer;
  pxW: number;
  pxH: number;
  density: number;
}

export type Prepared = { ok: true; image: Raster } | { ok: false; reason: string };

/**
 * Validate a Mermaid source string: check size and basic structure.
 * Does not render; just validates what can be done server-side.
 */
export function checkMermaidSource(input: unknown, label = 'Diagram'): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new ImageError(`${label} is empty`);
  }
  const source = input.replace(/\r\n?/g, '\n').trim();
  if (source.length > IMAGE_LIMITS.mermaidChars) {
    throw new ImageError(`${label} is too long (${source.length} chars; max ${IMAGE_LIMITS.mermaidChars})`);
  }
  return source;
}

// ── Browser detection ─────────────────────────────────────────────────────────

const BROWSERS = [
  process.env.DOC_BROWSER,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

export function findBrowser(): string | null {
  for (const b of BROWSERS) {
    if (b && fs.existsSync(b)) return b;
  }
  return null;
}

export function browserArgs(tmpDir: string, pageUrl: string, timeoutMs: number): string[] {
  return [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-setuid-sandbox',
    '--no-first-run',
    '--no-zygote',
    `--user-data-dir=${tmpDir}`,
    '--disable-web-security',
    '--allow-file-access-from-files',
    `--virtual-time-budget=${timeoutMs}`,
    '--run-all-compositor-stages-before-draw',
    '--disable-extensions',
    '--disable-default-apps',
    '--host-resolver-rules=MAP * ~NOTFOUND',
    `--dump-dom`,
    pageUrl,
  ];
}

/** Why PNG rendering is not available, or null when it is. */
export function rendererProblem(): string | null {
  if (!findBrowser()) return 'no headless browser was found (install Chromium or Chrome, or set DOC_BROWSER to its path)';
  return null;
}

export type MermaidRenderResult = { ok: true; image: Raster } | { ok: false; reason: string };

/** Render Mermaid diagrams to PNG (requires headless browser). */
export async function renderToPng(inputs: { kind: 'mermaid'; source: string }[]): Promise<MermaidRenderResult[]> {
  const problem = rendererProblem();
  if (problem) return inputs.map(() => ({ ok: false as const, reason: problem }));

  const exe = findBrowser()!;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mermaid-render-'));
  try {
    const pageContent = buildMermaidPage(inputs.map((i) => i.source));
    const page = path.join(tmp, 'page.html');
    fs.writeFileSync(page, pageContent);
    const args = browserArgs(tmp, pathToFileURL(page).href, IMAGE_LIMITS.renderMs);

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(exe, args, { timeout: IMAGE_LIMITS.renderMs, maxBuffer: 512 * 1024 * 1024, windowsHide: true }, (err, so) =>
        err && !so ? reject(err) : resolve(String(so)),
      );
    });

    const m = /<pre id="result">([\s\S]*?)<\/pre>/.exec(stdout);
    if (!m) return inputs.map(() => ({ ok: false as const, reason: 'browser produced no result' }));

    const unescaped = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const res = JSON.parse(unescaped) as { ok: boolean; png?: string; w?: number; h?: number; reason?: string }[];

    return inputs.map((_, i) => {
      const r = res[i];
      if (!r) return { ok: false as const, reason: 'browser stopped before this diagram' };
      if (!r.ok) return { ok: false as const, reason: r.reason ?? 'could not render' };
      return {
        ok: true as const,
        image: {
          type: 'png' as const,
          data: Buffer.from(r.png!, 'base64'),
          pxW: r.w ?? 800,
          pxH: r.h ?? 600,
          density: 2,
        },
      };
    });
  } catch (e: unknown) {
    const why = (e as { killed?: boolean })?.killed ? 'browser timed out' : String((e as { message?: string })?.message ?? e);
    return inputs.map(() => ({ ok: false as const, reason: why }));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function buildMermaidPage(sources: string[]): string {
  const data = JSON.stringify({ sources, scale: 2, maxPx: IMAGE_LIMITS.pixels }).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8">
<script src="${pathToFileURL(path.resolve('node_modules/mermaid/dist/mermaid.min.js')).href}"></script>
</head><body style="margin:0;background:#fff">
<script id="data" type="application/json">${data}</script>
<script>
(async () => {
  const { sources, scale, maxPx } = JSON.parse(document.getElementById('data').textContent);
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  const out = [];
  for (let i = 0; i < sources.length; i++) {
    try {
      const id = 'mmd-' + i;
      const div = document.createElement('div');
      div.id = id;
      document.body.appendChild(div);
      const { svg } = await mermaid.render(id + '-svg', sources[i]);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
      const w = img.naturalWidth, h = img.naturalHeight;
      const k = Math.min(scale, maxPx / w, maxPx / h);
      const c = document.createElement('canvas');
      c.width = Math.ceil(w * k); c.height = Math.ceil(h * k);
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      x.drawImage(img, 0, 0, c.width, c.height);
      out.push({ ok: true, png: c.toDataURL('image/png').split(',')[1], w: c.width, h: c.height });
    } catch (e) {
      out.push({ ok: false, reason: String(e?.message || e).slice(0, 300) });
    }
  }
  const pre = document.createElement('pre'); pre.id = 'result'; pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
})();
</script></body></html>`;
}
