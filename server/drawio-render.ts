/**
 * Drawing icon diagrams (draw.io files) as SVG and PNG, offline.
 *
 * The renderer is the official draw.io viewer bundle (viewer-static.min.js, its shape library and its stencil library,
 * installed by the "Icon diagrams" tool pack, drawio-pack.ts) run inside the same optional headless Chromium, Chrome or
 * Edge as the Mermaid renderer (docimage.ts): a throw-away profile, no network, no host name resolution, a page whose
 * content security policy allows only the local viewer files, and diagrams that were checked by validateDrawio first.
 * The viewer's own `Graph.getSvg` produces the SVG (with the real AWS, Azure, GCP and Kubernetes icons); the page then
 * draws that SVG on a canvas for the PNG, as docimage.ts does for Mermaid.
 *
 * Icon image files (`image=img/lib/azure2/...`) are put into the XML as data URIs on the way in, from the pack's image
 * folder; the stored diagram is never changed. An icon whose file is not installed is left blank and reported as a note.
 *
 * Nothing here throws: every item gets its own result, with the reason when it could not be drawn.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { browserArgs, findBrowser, IMAGE_LIMITS } from './docimage.ts';
import { DrawioError, validateDrawio } from './drawio.ts';
import { RENDERER_FILES, rendererDir, rendererFilesProblem } from './drawio-pack.ts';

export type DrawioRender =
  | { ok: true; png: Buffer; svg: string; pxW: number; pxH: number; density: number; notes: string[] }
  | { ok: false; reason: string };

export const DRAWIO_RENDER = { perRun: 20, scale: 2, imageBytes: 200_000, imagesTotalBytes: 3_000_000, renderMs: 90_000 };

/** Why icon diagrams cannot be drawn on this server, or null when the viewer files and a browser were found. */
export function drawioRendererProblem(): string | null {
  const files = rendererFilesProblem();
  if (files) return `${files}. An admin can install the Icon diagrams pack under Settings > Tools.`;
  if (!findBrowser()) return 'no headless browser was found (install Chromium or Chrome, or set DOC_BROWSER to its path)';
  return null;
}

/** Put the icon image files a diagram uses into its styles as data URIs. Returns the new XML and the files that were not found. */
export function inlineIconImages(xml: string, root = path.join(rendererDir(), 'img', 'lib')): { xml: string; missing: string[] } {
  const missing: string[] = [];
  const cache = new Map<string, string | null>();
  let total = 0;
  const out = xml.replace(/image=img\/lib\/([\w.-]+(?:\/[\w.-]+)+)\.(svg|png)(?=[;"])/g, (whole, rel: string, ext: string) => {
    const key = `${rel}.${ext}`;
    if (!cache.has(key)) {
      let data: string | null = null;
      try {
        const file = path.resolve(root, ...rel.split('/')) + `.${ext}`;
        if (file.startsWith(path.resolve(root) + path.sep) && fs.statSync(file).isFile() && fs.statSync(file).size <= DRAWIO_RENDER.imageBytes && total + fs.statSync(file).size <= DRAWIO_RENDER.imagesTotalBytes) {
          const buf = fs.readFileSync(file);
          total += buf.length;
          data = `data:image/${ext === 'svg' ? 'svg+xml' : 'png'},${buf.toString('base64')}`;
        }
      } catch {
        data = null;
      }
      cache.set(key, data);
      if (!data) missing.push(key);
    }
    const d = cache.get(key);
    return d ? `image=${d}` : whole;
  });
  return { xml: out, missing: [...new Set(missing)] };
}

function pageHtml(items: string[], dir: string): string {
  const url = (name: string) => pathToFileURL(path.join(dir, name)).href;
  const data = JSON.stringify({ items, scale: DRAWIO_RENDER.scale, maxPx: IMAGE_LIMITS.pixels }).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, ' ');
  const scripts = RENDERER_FILES.map((f) => `<script src="${url(f.name)}"></script>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src file: 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<script>var STENCIL_PATH='stencils',SHAPES_PATH='shapes',IMAGE_PATH='images',STYLE_PATH='styles',RESOURCES_PATH='resources',mxLoadResources=false,mxLoadStylesheets=false,mxBasePath='mxgraph',DRAWIO_BASE_URL='.';</script>
${scripts}</head><body style="margin:0;background:#fff"><script id="data" type="application/json">${data}</script>
<script>
(async () => {
  const { items, scale, maxPx } = JSON.parse(document.getElementById('data').textContent);
  const out = [];
  for (let i = 0; i < items.length; i++) {
    let g = null;
    try {
      const doc = mxUtils.parseXml(items[i]);
      const node = doc.documentElement.getElementsByTagName('diagram')[0].getElementsByTagName('mxGraphModel')[0];
      const div = document.createElement('div');
      div.style.cssText = 'position:absolute;left:0;top:0;width:800px;height:600px;overflow:hidden';
      document.body.appendChild(div);
      g = new Graph(div);
      g.setEnabled(false);
      new mxCodec(node.ownerDocument).decode(node, g.getModel());
      const el = g.getSvg('#ffffff', 1, 12);
      const w = parseFloat(el.getAttribute('width')), h = parseFloat(el.getAttribute('height'));
      if (!(w > 0 && h > 0)) throw new Error('the diagram has no size');
      if (w > maxPx || h > maxPx) throw new Error('the diagram is too large to draw');
      el.querySelectorAll('script').forEach((n) => n.remove());
      el.querySelectorAll('*').forEach((n) => {
        for (const a of Array.from(n.attributes)) {
          const name = a.name.toLowerCase();
          if (name.startsWith('on')) n.removeAttribute(a.name);
          else if ((name === 'href' || name === 'xlink:href') && !/^(#|data:image\\/)/i.test(a.value)) n.removeAttribute(a.name);
        }
      });
      if (!el.getAttribute('xmlns')) el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const svg = new XMLSerializer().serializeToString(el);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('the SVG could not be drawn')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
      const k = Math.min(scale, maxPx / w, maxPx / h);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(w * k)); c.height = Math.max(1, Math.ceil(h * k));
      const x = c.getContext('2d');
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
      x.drawImage(img, 0, 0, c.width, c.height);
      out.push({ ok: true, png: c.toDataURL('image/png').split(',')[1], svg, w: c.width, h: c.height, density: k });
      div.remove();
    } catch (e) {
      out.push({ ok: false, reason: String((e && e.message) || e).slice(0, 300) });
    }
    try { if (g) g.destroy(); } catch (e) {}
  }
  const pre = document.createElement('pre'); pre.id = 'result'; pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
})();
</script></body></html>`;
}

/**
 * Draw draw.io diagrams to SVG and PNG in one browser run. Each diagram is checked by validateDrawio first, so a file
 * that is not a valid icon diagram comes back as a reason and never reaches the browser.
 */
export async function renderDrawio(inputs: { xml: string }[]): Promise<DrawioRender[]> {
  if (!inputs.length) return [];
  const problem = drawioRendererProblem();
  if (problem) return inputs.map(() => ({ ok: false as const, reason: problem }));
  const results: DrawioRender[] = new Array(inputs.length);
  const todo: { at: number; xml: string; notes: string[] }[] = [];
  inputs.forEach((it, at) => {
    try {
      const checked = validateDrawio(it.xml);
      const inl = inlineIconImages(checked.xml);
      todo.push({ at, xml: inl.xml, notes: inl.missing.length ? [`${inl.missing.length} icon image file${inl.missing.length === 1 ? ' is' : 's are'} not in the installed image library, so ${inl.missing.length === 1 ? 'that icon is' : 'those icons are'} blank: ${inl.missing.slice(0, 3).join(', ')}${inl.missing.length > 3 ? ', ...' : ''}`] : [] });
    } catch (e: any) {
      results[at] = { ok: false, reason: e instanceof DrawioError ? e.message : String(e?.message ?? e).slice(0, 200) };
    }
  });
  const batch = todo.slice(0, DRAWIO_RENDER.perRun);
  for (const t of todo.slice(DRAWIO_RENDER.perRun)) results[t.at] = { ok: false, reason: `only ${DRAWIO_RENDER.perRun} diagrams are drawn at a time` };
  if (!batch.length) return results;
  const exe = findBrowser()!;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drawio-render-'));
  try {
    const page = path.join(tmp, 'page.html');
    fs.writeFileSync(page, pageHtml(batch.map((t) => t.xml), rendererDir()));
    const args = browserArgs(tmp, pathToFileURL(page).href, Math.min(50_000, 10_000 + batch.length * 5000));
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(exe, args, { timeout: DRAWIO_RENDER.renderMs, maxBuffer: 512 * 1024 * 1024, windowsHide: true }, (err, so) => (err && !so ? reject(err) : resolve(String(so))));
    });
    const m = /<pre id="result">([\s\S]*?)<\/pre>/.exec(stdout);
    if (!m) throw new Error('the browser produced no result (the viewer files may not have loaded)');
    const unescaped = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const res = JSON.parse(unescaped) as { ok: boolean; png?: string; svg?: string; w?: number; h?: number; density?: number; reason?: string }[];
    batch.forEach((t, i) => {
      const r = res[i];
      if (!r) results[t.at] = { ok: false, reason: 'the browser stopped before this diagram' };
      else if (!r.ok) results[t.at] = { ok: false, reason: r.reason ?? 'the diagram could not be drawn' };
      else results[t.at] = { ok: true, png: Buffer.from(r.png!, 'base64'), svg: r.svg!, pxW: r.w!, pxH: r.h!, density: r.density ?? DRAWIO_RENDER.scale, notes: t.notes };
    });
  } catch (e: any) {
    const why = e?.killed ? 'the browser timed out' : `the browser failed (${String(e?.message ?? e).split('\n')[0].slice(0, 200)})`;
    for (const t of batch) results[t.at] = { ok: false, reason: why };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the temp folder is cleaned by the system eventually */
    }
  }
  return results;
}
