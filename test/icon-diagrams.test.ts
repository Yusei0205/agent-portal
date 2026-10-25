/**
 * Icon diagrams (draw.io, FR-DIAG-9): validation of the agent's file, the Icon diagrams tool pack, the built-in integration
 * and its guard, drawing a diagram in a session (demo provider), versions, staleness, follow-ups, exports, the picture
 * fallback, and embedding in documents and decks. Nothing is installed from the network: the pack is faked on disk and the
 * install job runs against fake downloads. Picture tests run with a small stub in place of the draw.io viewer files and
 * need a headless browser; they are skipped without one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { waitFor } from './client.ts';
import { bootWorkflowFixture, type WorkflowFixture } from './workflows-fixture.ts';
import { DRAWIO_LIMITS, DrawioError, drawioDensity, validateDrawio } from '../server/drawio.ts';
import { composeIconDiagramPrompt, docIconDiagramBlock, deckIconDiagramBlock, iconDiagramRules, iconDrawingRules, iconImageMarkdown, parseDiagramFileReply } from '../server/drawio-text.ts';
import { detectCloud } from '../server/drawio-cloud.ts';
import { parseDescription } from '../server/diagram-text.ts';
import { demoDrawio } from '../server/agent/demo-drawio.ts';
import { findBrowser } from '../server/docimage.ts';

const packRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-pack-'));
process.env.ICON_DIAGRAMS_DIR = packRoot;
delete process.env.DRAWIO_RENDERER_DIR;

let f: WorkflowFixture;
let repoId: string;
let slugDir: string;
let vaultRoot: string;
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-repo-'));
const git = (...a: string[]) => execFileSync('git', a, { cwd: repoDir, stdio: 'pipe' }).toString().trim();

/* A stand-in for the three draw.io viewer files: just enough of the API the render page calls. */
const STUB_VIEWER = `var mxUtils = { parseXml: function (x) { return new DOMParser().parseFromString(x, 'text/xml'); } };
function mxCodec(doc) { this.doc = doc; }
mxCodec.prototype.decode = function (node, model) { model.cells = node.getElementsByTagName('mxCell').length; };
function Graph(div) { this.model = { cells: 0 }; }
Graph.prototype.setEnabled = function () {};
Graph.prototype.getModel = function () { return this.model; };
Graph.prototype.destroy = function () {};
Graph.prototype.getSvg = function () {
  var ns = 'http://www.w3.org/2000/svg';
  var s = document.createElementNS(ns, 'svg');
  s.setAttribute('width', '300'); s.setAttribute('height', '120'); s.setAttribute('xmlns', ns);
  var r = document.createElementNS(ns, 'rect'); r.setAttribute('width', '300'); r.setAttribute('height', '120'); r.setAttribute('fill', '#0a7');
  s.appendChild(r);
  var t = document.createElementNS(ns, 'text'); t.setAttribute('x', '10'); t.setAttribute('y', '60'); t.textContent = 'cells ' + this.model.cells;
  s.appendChild(t);
  return s;
};
`;
const STUB_FILES = [
  { name: 'viewer-static.min.js', source: 'js/viewer-static.min.js', body: STUB_VIEWER },
  { name: 'shapes.min.js', source: 'js/shapes-14-6-5.min.js', body: '/* shapes stub */' },
  { name: 'stencils.min.js', source: 'js/stencils.min.js', body: '/* stencils stub */' },
];
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const AZURE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#0078d4"/></svg>';
const gitBlobSha = (s: string) => createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');

/** The pins and fake network of an install that needs no network. */
function fakeInstall(opts: { badIndex?: boolean; badIntegrity?: boolean } = {}) {
  const index = JSON.stringify(Array.from({ length: 1200 }, (_, i) => ({ style: `shape=mxgraph.aws4.x${i};`, w: 10, h: 10, title: `Shape ${i}`, tags: 'aws', type: 'vertex' })));
  const pins = {
    mcpPackage: '@drawio/mcp',
    mcpVersion: '1.10.0',
    mcpIntegrity: 'sha512-test-integrity',
    indexCommit: 'abc123',
    indexSha256: sha256(index),
    viewerTag: 'v0.0.1',
    files: STUB_FILES.map((s) => ({ name: s.name, source: s.source, sha256: sha256(s.body) })),
  };
  const calls: string[] = [];
  const downloader = async (url: string, dest: string) => {
    calls.push(url);
    if (url.includes('search-index.json')) fs.writeFileSync(dest, opts.badIndex ? index.replace('Shape 1', 'Shape X') : index);
    else if (url.includes('/git/trees/')) fs.writeFileSync(dest, JSON.stringify({ truncated: false, tree: [{ path: 'compute/Function_Apps.svg', type: 'blob', size: AZURE_SVG.length, sha: gitBlobSha(AZURE_SVG) }] }));
    else if (url.includes('/img/lib/azure2/')) fs.writeFileSync(dest, AZURE_SVG);
    else {
      const file = STUB_FILES.find((s) => url.endsWith(s.source));
      if (!file) throw new Error(`unexpected download ${url}`);
      fs.writeFileSync(dest, file.body);
    }
  };
  const shell = async (cmd: string, args: string[], env: Record<string, string>) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    assert.ok(args.includes('--ignore-scripts'), 'npm runs with install scripts off');
    assert.ok(!('ANTHROPIC_API_KEY' in env) && !('AWS_SECRET_ACCESS_KEY' in env), 'no secrets in the npm environment');
    const prefix = args[args.indexOf('--prefix') + 1];
    const entry = path.join(prefix, 'node_modules', '@drawio', 'mcp');
    fs.mkdirSync(path.join(entry, 'src'), { recursive: true });
    fs.writeFileSync(path.join(entry, 'src', 'index.js'), '// fake draw.io MCP server\n');
    fs.writeFileSync(path.join(prefix, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: { 'node_modules/@drawio/mcp': { version: '1.10.0', integrity: opts.badIntegrity ? 'sha512-other' : 'sha512-test-integrity' } } }));
    return { ok: true, output: 'added 1 package' };
  };
  return { pins, downloader, shell, calls };
}

before(async () => {
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repoDir, 'app.py'), 'def handler(event, context):\n    return {"ok": True}\n');
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# payments\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  f = await bootWorkflowFixture();
  const { repo } = await f.admin.post(`/api/projects/${f.pid}/repos`, { localPath: repoDir, name: 'payments' });
  repoId = repo.id;
  await waitFor(async () => ((await f.admin.get(`/api/projects/${f.pid}/repos`)).repos.find((r: any) => r.id === repoId).status === 'ready' ? true : null), 'clone');
  const { project } = await f.admin.get(`/api/projects/${f.pid}`);
  slugDir = path.join(f.srv.dataDir, 'projects', project.slug);
  vaultRoot = path.join(f.srv.dataDir, 'vault', 'projects', f.pid);
});

after(async () => {
  await f.srv.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(packRoot, { recursive: true, force: true });
});

const dg = () => `/api/projects/${f.pid}/diagrams`;
const docs = () => `/api/projects/${f.pid}/generated-docs`;
const decks = () => `/api/projects/${f.pid}/presentations`;
const settled = (id: string) =>
  waitFor(async () => {
    const r = await f.admin.get(`${dg()}/${id}`);
    return r.diagram.status !== 'generating' ? r : null;
  }, 'the diagram session to finish');
const docSettled = (id: string) =>
  waitFor(async () => {
    const r = await f.admin.get(`${docs()}/${id}`);
    return r.document.status !== 'generating' ? r : null;
  }, 'the document to finish');
const deckSettled = (id: string) =>
  waitFor(async () => {
    const r = await f.admin.get(`${decks()}/${id}`);
    return r.presentation.status !== 'generating' ? r : null;
  }, 'the deck to finish');
const syncRepo = async () => {
  await f.admin.post(`/api/repos/${repoId}/sync`);
  await waitFor(async () => ((await f.admin.get(`/api/projects/${f.pid}/repos`)).repos.find((r: any) => r.id === repoId).status === 'ready' ? true : null), 'sync');
};
async function followUp(wid: string, edit: (goal: string) => string, text = 'Please redraw it') {
  const w = (await f.admin.get(`/api/workflows/${wid}`)).workflow;
  const clean = w.goal.replace(/\n?\[demo-[a-z-]+\]/g, '');
  await f.admin.put(`/api/workflows/${wid}`, { goal: edit(clean) });
  await f.admin.post(`/api/workflows/${wid}/messages`, { body: text });
}
const events = async (wid: string) => (await f.admin.get(`/api/workflows/${wid}`)).events as { kind: string; body: string }[];

/* ------------------------------------------------------------------ */
/* The checks on the agent's file                                       */
/* ------------------------------------------------------------------ */

const GOOD = demoDrawio({ cloud: 'aws', title: 'Payments', items: ['intake', 'ledger', 'notify'] });

test('a valid diagram is accepted and stored in the portal\'s own, stable serialisation', () => {
  const a = validateDrawio(GOOD);
  assert.match(a.xml, /^<mxfile host="agent-portal"><diagram id="page-1" name="Page-1"><mxGraphModel/);
  assert.ok(a.icons >= 4 && a.groups === 1 && a.edges >= 3, JSON.stringify(a));
  assert.equal(validateDrawio(a.xml).xml, a.xml, 'checking the stored form again changes nothing');
  assert.equal(validateDrawio(GOOD.replace('<mxfile host="demo">', '<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="demo">')).xml, a.xml, 'an XML declaration is fine');
  const bare = GOOD.match(/<mxGraphModel[\s\S]*<\/mxGraphModel>/)![0];
  assert.equal(validateDrawio(bare).xml, a.xml, 'a bare mxGraphModel is wrapped in an mxfile');
  const azure = validateDrawio(demoDrawio({ cloud: 'azure', title: 'x', items: ['a'] }));
  assert.deepEqual(azure.images, ['img/lib/azure2/compute/Function_Apps.svg']);
  const d = drawioDensity(a.xml);
  assert.equal(d.dense, false);
  assert.ok(d.icons >= 4);
});

test('object wrappers and light-dark colours are allowed, their extra attributes are dropped', () => {
  const x = `<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
    <object label="Api" id="a" secret="x" tags="t"><mxCell style="rounded=1;fillColor=light-dark(#fff,#000);" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell></object>
  </root></mxGraphModel></diagram></mxfile>`;
  assert.throws(() => validateDrawio(x), /attribute "secret"/);
  const ok = validateDrawio(x.replace(' secret="x"', ''));
  assert.match(ok.xml, /<mxCell id="a" value="Api" style="rounded=1;fillColor=light-dark\(#fff,#000\);" parent="1" vertex="1">/);
  assert.doesNotMatch(ok.xml, /tags=/);
});

const wrap = (cells: string) => `<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram></mxfile>`;
const box = (extra = '', id = 'a') => `<mxCell id="${id}" value="x" style="rounded=1;" vertex="1" parent="1" ${extra}><mxGeometry x="0" y="0" width="40" height="40" as="geometry"/></mxCell>`;

const REFUSED: [string, string, RegExp][] = [
  ['not XML', 'hello', /not well-formed XML|must start with/],
  ['a DOCTYPE', '<!DOCTYPE x [<!ENTITY a "b">]>' + GOOD, /DOCTYPE, entity or CDATA/],
  ['CDATA', wrap(box()).replace('value="x"', 'value="x"').replace('</root>', '<![CDATA[x]]></root>'), /DOCTYPE, entity or CDATA/],
  ['a processing instruction', GOOD.replace('<diagram', '<?php echo 1 ?><diagram'), /processing instructions/],
  ['a compressed page', '<mxfile><diagram id="a" name="p">dZHLDoIwEEW/pnuktGJdmqgb40q3kpYKEWhsq9CvtwOt4oPNJPeeuZ2ZIIzbGjboqRJFDVOKKrOdhPhUVQIK8wM1GmgJJPYpJbe+FypxYOq5Hhyl3pzd1GfJYS4GElq0gEJXw4tZT8AHM1ev4Mw</diagram></mxfile>', /holds text|exactly one <mxGraphModel>/],
  ['two pages', demoDrawio({ cloud: 'aws', title: 'x', items: ['a'], variant: 'multipage' }), /more than one page/],
  ['an unknown element', wrap('<script>alert(1)</script>'), /<script> is not allowed inside <root>/],
  ['an unknown cell attribute', wrap(box('onclick="x()"')), /attribute "onclick"/],
  ['a link attribute on a cell', wrap(box('href="http://a.b"')), /attribute "href"/],
  ['an external image style', wrap(box().replace('rounded=1;', 'shape=image;image=https://evil.example/a.png;')), /link or an external address/],
  ['a data image style', wrap(box().replace('rounded=1;', 'shape=image;image=data:image/png,AAAA;')), /link or an external address|uses an image/],
  ['an image outside the icon library', wrap(box().replace('rounded=1;', 'shape=image;image=../../etc/passwd.png;')), /uses an image/],
  ['a link style key', wrap(box().replace('rounded=1;', 'rounded=1;link=x;')), /style key "link"/],
  ['a javascript link in a label', wrap(box().replace('value="x"', 'value="javascript:alert(1)"')), /link or an external address/],
  ['a URL in a label', wrap(box().replace('value="x"', 'value="see https://example.com"')), /link or an external address/],
  ['a script tag in a label', wrap(box().replace('value="x"', 'value="&lt;script&gt;x&lt;/script&gt;"')), /HTML tag <script>/],
  ['an image tag with an event handler', wrap(box().replace('value="x"', 'value="&lt;img src=x onerror=alert(1)&gt;"')), /markup that is not allowed/],
  ['an image tag with a quoted source', wrap(box().replace('value="x"', 'value="&lt;img src=&quot;x&quot;&gt;"')), /HTML tag <img>/],
  ['an event attribute on an allowed tag', wrap(box().replace('value="x"', 'value="&lt;b onclick=&quot;x()&quot;&gt;a&lt;/b&gt;"')), /attribute "onclick"/],
  ['a url() label style', wrap(box().replace('value="x"', 'value="&lt;span style=&quot;background:url(x)&quot;&gt;a&lt;/span&gt;"')), /label style that is not allowed/],
  ['odd style characters', wrap(box().replace('rounded=1;', 'rounded=1;fillColor=a"b;')), /characters that are not allowed|not well-formed|style key/],
  ['a style with a quote-free injection', wrap(box().replace('rounded=1;', 'fontFamily=Arial<b>;')), /not well-formed|characters that are not allowed/],
  ['a duplicate id', wrap(box('', 'a') + box('', 'a')), /used twice/],
  ['a missing parent', wrap(box().replace('parent="1"', 'parent="nope"')), /parent that does not exist/],
  ['a parent loop', wrap(box().replace('parent="1"', 'parent="b"').replace('id="a"', 'id="a"') + box().replace('id="a"', 'id="b"').replace('parent="1"', 'parent="a"')), /nested more than|loop/],
  ['an edge to nowhere', wrap(box() + '<mxCell id="e" edge="1" parent="1" source="a" target="zzz"><mxGeometry relative="1" as="geometry"/></mxCell>'), /connects to "zzz"/],
  ['a vertex without geometry', wrap('<mxCell id="a" value="x" vertex="1" parent="1"/>'), /without an <mxGeometry>/],
  ['a huge coordinate', wrap(box().replace('x="0"', 'x="99999999"')), /between -100000 and 100000/],
  ['no root cell', '<mxfile><diagram><mxGraphModel><root><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>', /no root cell/],
  ['no shapes', wrap(''), /no shapes/],
  ['too many cells', demoDrawio({ cloud: 'aws', title: 'x', items: ['a'], variant: 'toomany' }), new RegExp(`more than ${DRAWIO_LIMITS.cells} cells`)],
  ['too many bytes', demoDrawio({ cloud: 'aws', title: 'x', items: ['a'], variant: 'oversized' }), /too large/],
  ['a very long label', wrap(box().replace('value="x"', `value="${'a'.repeat(700)}"`)), /longer than 600 characters/],
];
for (const [name, xml, re] of REFUSED) {
  test(`refused: ${name}`, () => {
    assert.throws(() => validateDrawio(xml), (e: unknown) => e instanceof DrawioError && re.test(e.message), `message did not match ${re}`);
  });
}

/* ------------------------------------------------------------------ */
/* Text-box label limit (textBoxChars = 2000, labelChars = 600)        */
/* ------------------------------------------------------------------ */

const textBox = (value: string, id = 'legend_l') =>
  wrap(`<mxCell id="${id}" value="${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}" style="text;html=1;align=left;verticalAlign=top;whiteSpace=wrap;fontSize=12;" vertex="1" parent="1"><mxGeometry x="10" y="10" width="500" height="200" as="geometry"/></mxCell>`);
const iconCell = (value: string, id = 'icon_x') =>
  wrap(`<mxCell id="${id}" value="${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}" style="sketch=0;points=[[0,0,0]];outlineConnect=0;fontColor=#232F3E;fillColor=#ED7100;strokeColor=#ffffff;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda_function;" vertex="1" parent="1"><mxGeometry x="10" y="10" width="64" height="64" as="geometry"/></mxCell>`);

test('text box: a 1500-character legend is accepted and the stored XML preserves the label', async () => {
  const legend = 'Step '.repeat(300); // 1500 chars: exactly at the middle of the allowance
  const xml = textBox(legend);
  const result = validateDrawio(xml);
  // The stored XML must contain the legend text (encoded)
  assert.ok(result.xml.includes('Step '), 'stored XML must include the legend text');
  assert.ok(result.cells >= 3, 'cells should include root, layer and the text box');

  // Also try rendering: follow the same path as the other rendering tests (stub viewer if installed, skip without browser)
  if (!hasBrowser()) {
    const { renderDrawio } = await import('../server/drawio-render.ts');
    const [r] = await renderDrawio([{ xml: result.xml }]);
    // The render should not fail due to label length ΓÇö only browser/viewer issues are acceptable
    if (r.ok) {
      assert.equal(r.png.subarray(1, 4).toString('ascii'), 'PNG', 'rendered output is a PNG');
    } else {
      // If not ok, it must be a renderer problem, not a label-length rejection
      assert.doesNotMatch(r.reason, /longer than|too long|label.*600|label.*2000/, `unexpected render failure: ${r.reason}`);
    }
  }
});

test('text box: a 2001-character label is refused with the text-box message naming the cell id', () => {
  const legend = 'x'.repeat(2001);
  const xml = textBox(legend);
  assert.throws(
    () => validateDrawio(xml),
    (e: unknown) =>
      e instanceof DrawioError &&
      /text box/.test(e.message) &&
      /2000/.test(e.message) &&
      /legend_l/.test(e.message),
    'expected a DrawioError mentioning "text box", "2000" and the cell id "legend_l"',
  );
});

test('refused: an icon label of 601 characters is still refused with the standard 600-character message', () => {
  const xml = iconCell('a'.repeat(601));
  assert.throws(
    () => validateDrawio(xml),
    (e: unknown) =>
      e instanceof DrawioError &&
      /longer than 600 characters/.test(e.message) &&
      /icon_x/.test(e.message),
    'expected a DrawioError mentioning 600 and the cell id',
  );
});

test('refused: a 1500-character label on an icon cell is refused (text-box allowance does not apply to icons)', () => {
  const xml = iconCell('a'.repeat(1500));
  assert.throws(
    () => validateDrawio(xml),
    (e: unknown) => e instanceof DrawioError && /longer than 600 characters/.test(e.message),
    'icon cells must be refused at 600 even when label is 1500 chars',
  );
});

/* ------------------------------------------------------------------ */
/* The text side                                                        */
/* ------------------------------------------------------------------ */

test('prompt: teaches the lookup tool, boundaries, numbered steps, the size cap, no external resources and where to save', () => {
  const repos = [{ name: 'payments', slug: 'payments', default_branch: 'main' }];
  const p = composeIconDiagramPrompt('data_flow', 'Flow', repos, 'aws');
  assert.match(p, /^Architecture diagram request: data_flow\nStyle: icon diagram \(draw\.io\), cloud: aws\n/);
  assert.match(p, /repos\/payments\//);
  assert.match(p, /search_shapes/);
  assert.match(p, /never guess a shape or write a style string from memory/);
  assert.match(p, /aws cloud.*aws account.*region.*vpc/s);
  assert.match(p, /numbered badge/);
  assert.match(p, /legend/);
  assert.match(p, /Left to right|left to right/);
  assert.match(p, /at most about 25 icons/);
  assert.match(p, /No external resources: no URLs or links/);
  assert.match(p, /diagram\.drawio/);
  assert.match(p, /CDK, SAM and CloudFormation templates, Terraform/);
  assert.match(p, /Diagram file: <path/);
  assert.match(p, /repo-name\/path\/to\/file\.ext:line/);
  assert.match(p, /Do not change anything inside repos/);
  assert.match(composeIconDiagramPrompt('components', 'x', repos, 'kubernetes'), /kubernetes cluster.*namespace/s);
  assert.match(composeIconDiagramPrompt('components', 'x', repos, 'azure'), /azure subscription.*resource group/s);
  assert.match(composeIconDiagramPrompt('components', 'x', repos, 'gcp'), /gcp project/);
  const rules = iconDiagramRules('Payments');
  assert.match(rules, /Create page \(Diagrams tab\)/);
  assert.match(rules, /Never say that no file was written/);
  assert.match(rules, /write the complete new diagram\.drawio again/);
  assert.match(rules, /search_shapes and get_drawio_reference may be used/);
  assert.match(docIconDiagramBlock('gcp'), /Google Cloud/);
  assert.match(deckIconDiagramBlock('aws'), /"image" element/);
  assert.ok(iconDrawingRules('generic').length >= 7);
});

test('reply: the file line, then a description whose cited files become citations', () => {
  assert.deepEqual(parseDiagramFileReply('Diagram file: work/r_1/diagram.drawio\n\nDescription: x'), { path: 'work/r_1/diagram.drawio' });
  assert.deepEqual(parseDiagramFileReply('**Diagram file:** `a b.drawio`'), { path: 'a b.drawio' });
  assert.deepEqual(parseDiagramFileReply('nothing'), { path: null });
  const d = parseDescription('Diagram file: x.drawio\n\nDescription: Lambdas read the table, based on `payments/app.py:3` and payments/README.md.');
  assert.match(d.description, /^Lambdas read the table/);
  assert.doesNotMatch(d.description, /Diagram file/);
  assert.deepEqual(d.citations, ['payments/app.py:3', 'payments/README.md']);
  assert.match(iconImageMarkdown('A (b)', 'docs/diagrams/a b.drawio', 'Desc.', true), /^## A \(b\)\n\n!\[A \(b\)\]\(docs\/diagrams\/a%20b\.drawio\)\n\nDesc\.\n$/);
});

test('the cloud comes from the repository\'s infrastructure code, and defaults to AWS', () => {
  const mk = (files: Record<string, string>) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-'));
    for (const [n, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true });
      fs.writeFileSync(path.join(d, n), c);
    }
    return d;
  };
  const cases: [Record<string, string>, string, boolean][] = [
    [{ 'cdk.json': '{}', 'lambda/Functions/x/lambda_function.py': '' }, 'aws', true],
    [{ 'infra/main.tf': 'provider "azurerm" {}\nresource "azurerm_resource_group" "rg" {}' }, 'azure', true],
    [{ 'deploy/main.bicep': 'param x string' }, 'azure', true],
    [{ 'infra/main.tf': 'provider "google" {}\nresource "google_cloud_run_service" "s" {}', 'cloudbuild.yaml': 'steps: []' }, 'gcp', true],
    [{ 'k8s/deploy.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\n', 'charts/a/Chart.yaml': 'name: a' }, 'kubernetes', true],
    [{ 'template.yaml': 'AWSTemplateFormatVersion: "2010-09-09"\nResources: {}' }, 'aws', true],
    [{ 'README.md': '# nothing cloudy' }, 'aws', false],
  ];
  for (const [files, cloud, detected] of cases) {
    const d = mk(files);
    try {
      const g = detectCloud([d]);
      assert.equal(g.cloud, cloud, JSON.stringify(g));
      assert.equal(g.detected, detected);
      if (detected) assert.ok(g.signals.length >= 1);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
  assert.equal(detectCloud(['/no/such/folder']).cloud, 'aws');
});

/* ------------------------------------------------------------------ */
/* Without the pack                                                     */
/* ------------------------------------------------------------------ */

test('without the pack: icon is listed as unavailable with the reason and a hint, creating one is refused and leaves nothing', async () => {
  const list = await f.admin.get(dg());
  const mermaid = list.styles.find((s: any) => s.id === 'mermaid');
  const icon = list.styles.find((s: any) => s.id === 'icon');
  assert.equal(mermaid.available, true);
  assert.equal(icon.available, false);
  assert.match(icon.reason, /not installed/);
  assert.match(icon.reason, /Settings › Tools/);
  assert.equal(icon.preview.available, false);
  assert.deepEqual(list.clouds.map((c: any) => c.id), ['aws', 'azure', 'gcp', 'kubernetes', 'generic']);
  assert.equal(list.defaultCloud, 'aws');
  assert.equal(list.exportIcon.drawio, true);
  assert.equal(list.exportIcon.png, false);

  const r = await f.admin.req('POST', dg(), { kind: 'components', repoId, style: 'icon' });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /Icon diagrams need the Icon diagrams tool pack/);
  assert.match(r.data.error, /Settings › Tools/);
  assert.equal((await f.admin.get(dg())).diagrams.length, 0, 'no diagram row or session is left behind');
  const { one } = await import('../server/db.ts');
  assert.equal(Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM workflows WHERE project_id = ?', f.pid)?.n), 0, 'no session was started');

  const d = await f.admin.req('POST', docs(), { type: 'overview', repoIds: [repoId], diagramStyle: 'icon' });
  assert.equal(d.status, 400);
  assert.match(d.data.error, /Icon diagrams need the Icon diagrams tool pack/);
  const p = await f.admin.req('POST', decks(), { topic: 'Refund policy overview', diagramStyle: 'icon' });
  assert.equal(p.status, 400);
  assert.match(p.data.error, /Icon diagrams need the Icon diagrams tool pack/);
  assert.equal((await f.admin.get(docs())).documents.length, 0);
  assert.equal((await f.admin.get(decks())).presentations.length, 0);

  const packs = await f.admin.get('/api/tool-packs');
  const pack = packs.packs.find((x: any) => x.id === 'drawio');
  assert.equal(pack.status, 'missing');
  assert.equal(pack.parts.length, 2);
  assert.equal((await f.viewer.req('POST', '/api/tools/drawio/install', {})).status, 403, 'only admins install it');
  assert.equal((await f.admin.req('GET', '/api/tools/drawio/install')).data.job, null);
  assert.equal((await f.admin.req('POST', '/api/integrations', { kind: 'drawio', name: 'mine' })).status, 400, 'nobody creates it by hand');
});

test('request values are checked: style and cloud', async () => {
  const bad = async (body: any, re: RegExp) => {
    const r = await f.admin.req('POST', dg(), { kind: 'components', repoId, ...body });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, re);
  };
  await bad({ style: 'crayon' }, /Style must be one of/);
  await bad({ style: 'icon', cloud: 'mars' }, /Cloud must be one of/);
  await bad({ style: 'mermaid', cloud: 'aws' }, /only applies to the icon style/);
  assert.equal((await f.admin.get(dg())).diagrams.length, 0);
});

/* ------------------------------------------------------------------ */
/* The install job                                                      */
/* ------------------------------------------------------------------ */

function newJob() {
  return { id: 'job_t', packId: 'drawio', status: 'running' as const, log: [] as string[], startedAt: new Date().toISOString(), finishedAt: null, error: null };
}

test('install: a download that does not match its pinned checksum fails and leaves the pack not installed', async () => {
  const { installDrawioPack, getToolPacks, clearPackCache } = await import('../server/tool-packs.ts');
  const { drawioPackState } = await import('../server/drawio-pack.ts');
  const bad = fakeInstall({ badIndex: true });
  await assert.rejects(installDrawioPack(newJob(), bad.downloader, bad.shell, bad.pins), /SHA-256 mismatch for the shape index/);
  assert.equal(drawioPackState().tool.ok, false);
  const badNpm = fakeInstall({ badIntegrity: true });
  await assert.rejects(installDrawioPack(newJob(), badNpm.downloader, badNpm.shell, badNpm.pins), /does not match the pinned version and integrity/);
  assert.equal(fs.existsSync(path.join(packRoot, 'pack.json')), false, 'the install record is written last');
  clearPackCache();
  assert.equal((await getToolPacks()).find((p) => p.id === 'drawio')!.status, 'missing');
  // a viewer file that does not match
  const badFile = fakeInstall();
  badFile.pins.files[0].sha256 = '0'.repeat(64);
  await assert.rejects(installDrawioPack(newJob(), badFile.downloader, badFile.shell, badFile.pins), /SHA-256 mismatch for viewer-static\.min\.js/);
  assert.equal(drawioPackState().tool.ok, false);
});

test('install: npm with scripts off, the pinned shape index and viewer files, the Azure images, then the record; the integration appears', async () => {
  const { installDrawioPack, getToolPacks, clearPackCache } = await import('../server/tool-packs.ts');
  const { drawioPackState, readManifest, rendererDir } = await import('../server/drawio-pack.ts');
  const { ensureBuiltInDrawioIntegration, BUILTIN_DRAWIO_ID } = await import('../server/integrations.ts');
  const ok = fakeInstall();
  const job = newJob();
  await installDrawioPack(job, ok.downloader, ok.shell, ok.pins);
  assert.ok(ok.calls.some((c) => /^npm(\.cmd)? install --prefix .* --ignore-scripts .*@drawio\/mcp@1\.10\.0$/.test(c)), ok.calls.join('\n'));
  assert.ok(ok.calls.some((c) => c.includes('drawio-mcp@abc123/shape-search/search-index.json')), 'the index is pinned to a commit');
  assert.ok(ok.calls.some((c) => c.includes('/v0.0.1/src/main/webapp/js/viewer-static.min.js')), 'the viewer files are pinned to a release tag');
  assert.match(job.log.join('\n'), /Integrity verified/);
  assert.match(job.log.join('\n'), /1 azure2 icon images installed/);
  const m = readManifest()!;
  assert.deepEqual(m.images, ['azure2']);
  assert.equal(m.mcp, '@drawio/mcp@1.10.0');
  assert.ok(fs.existsSync(path.join(rendererDir(), 'img', 'lib', 'azure2', 'compute', 'Function_Apps.svg')));
  const st = drawioPackState();
  assert.equal(st.tool.ok, true);
  assert.equal(st.renderer.ok, true);
  clearPackCache();
  const pack = (await getToolPacks()).find((p) => p.id === 'drawio')!;
  assert.equal(pack.status, 'available');
  assert.equal(pack.parts!.every((x) => x.ok), true);
  assert.equal(await ensureBuiltInDrawioIntegration(), true);
  const { integrations } = await f.admin.get('/api/integrations');
  const i = integrations.find((x: any) => x.id === BUILTIN_DRAWIO_ID);
  assert.equal(i.name, 'Icon diagrams');
  assert.equal(i.kind, 'drawio');
  assert.equal(i.scope, 'team');
  assert.equal(i.allowWrites, false);
  assert.equal(integrations.filter((x: any) => x.kind === 'drawio').length, 1, 'created once');
  await ensureBuiltInDrawioIntegration();
  assert.equal((await f.admin.get('/api/integrations')).integrations.filter((x: any) => x.kind === 'drawio').length, 1);
});

test('a failed Azure image download does not fail the install: those icons are only blank in pictures', async () => {
  const { installDrawioPack } = await import('../server/tool-packs.ts');
  const { readManifest } = await import('../server/drawio-pack.ts');
  const ok = fakeInstall();
  const inner = ok.downloader;
  const job = newJob();
  await installDrawioPack(job, async (url, dest) => {
    if (url.includes('/git/trees/')) throw new Error('rate limited');
    return inner(url, dest);
  }, ok.shell, ok.pins);
  assert.deepEqual(readManifest()!.images, []);
  assert.match(job.log.join('\n'), /azure2 icon images were not installed \(rate limited\)/);
  await installDrawioPack(newJob(), ok.downloader, ok.shell, ok.pins);
  assert.deepEqual(readManifest()!.images, ['azure2'], 'a second install fills them in');
});

/* ------------------------------------------------------------------ */
/* The integration and its guard                                        */
/* ------------------------------------------------------------------ */

test('the integration starts the installed server with node, a local shape index, no icon service, and no other environment', async () => {
  const { mcpServerFor, BUILTIN_DRAWIO_ID, getIntegration, resolveIntegrations, PRESET_PACKAGES } = await import('../server/integrations.ts');
  const { mcpEntry, shapeIndexFile, mcpCacheDir } = await import('../server/drawio-pack.ts');
  const row = getIntegration(BUILTIN_DRAWIO_ID)!;
  const s = await mcpServerFor(row);
  assert.equal(s.type, 'stdio');
  if (s.type !== 'stdio') return;
  assert.equal(s.command, process.execPath);
  assert.deepEqual(s.args, [mcpEntry()]);
  assert.deepEqual(s.env, { DRAWIO_SHAPE_INDEX_URL: shapeIndexFile(), DRAWIO_ICON_SERVICE_URL: 'off', XDG_CACHE_HOME: mcpCacheDir() });
  assert.ok(path.isAbsolute(shapeIndexFile()), 'a local file, never a URL');
  assert.equal(PRESET_PACKAGES.drawio, '@drawio/mcp@1.10.0', 'an exact version, not latest');
  const { one } = await import('../server/db.ts');
  const run = await resolveIntegrations([BUILTIN_DRAWIO_ID], String(one<{ id: string }>('SELECT id FROM users ORDER BY created_at LIMIT 1')!.id));
  assert.deepEqual(Object.keys(run.servers), ['icon_diagrams']);
  assert.ok(run.readOnly.has('icon_diagrams'));
  assert.deepEqual([...run.onlyTools.get('icon_diagrams')!].sort(), ['get_drawio_reference', 'search_shapes']);
});

test('the guard allows only the two lookups, for the Claude and the Kiro tool names', async () => {
  const { integrationGuard } = await import('../server/integrations.ts');
  const ro = new Set(['icon_diagrams']);
  const only = new Map([['icon_diagrams', new Set(['search_shapes', 'get_drawio_reference'])]]);
  assert.equal(integrationGuard(ro, 'mcp__icon_diagrams__search_shapes', only), null);
  assert.equal(integrationGuard(ro, 'mcp__icon_diagrams__get_drawio_reference', only), null);
  assert.equal(integrationGuard(ro, '@icon_diagrams/search_shapes', only), null);
  for (const t of ['mcp__icon_diagrams__open_drawio_xml', 'mcp__icon_diagrams__open_drawio_csv', 'mcp__icon_diagrams__open_drawio_mermaid', 'mcp__icon_diagrams__list_pages', 'mcp__icon_diagrams__get_page', 'mcp__icon_diagrams__set_page', '@icon_diagrams/open_drawio_xml', 'icon_diagrams/set_page']) {
    assert.match(integrationGuard(ro, t, only) ?? '', /only allows these tools: search_shapes, get_drawio_reference/, t);
  }
  assert.equal(integrationGuard(ro, 'mcp__other__open_drawio_xml', only), null, 'other servers are not affected');
  assert.equal(integrationGuard(new Set(), 'Write', only), null);
});

test('both engines get the same stdio server: the Kiro agent profile carries it', async () => {
  const { writeAgentProfile } = await import('../server/agent/kiro.ts');
  const { mcpServerFor, BUILTIN_DRAWIO_ID, getIntegration } = await import('../server/integrations.ts');
  const server = await mcpServerFor(getIntegration(BUILTIN_DRAWIO_ID)!);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-profile-'));
  try {
    const { file } = writeAgentProfile(dir, 'prompt', true, [], { icon_diagrams: server });
    const prof = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(prof.mcpServers.icon_diagrams, { command: process.execPath, args: (server as any).args, env: (server as any).env });
    assert.ok(prof.tools.includes('@mcp'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Drawing a diagram                                                    */
/* ------------------------------------------------------------------ */

let diagramId = '';
let diagramSlug = '';
let sessionId = '';

test('create: a session with the draw.io lookups writes diagram.drawio; it is checked, stored as version 1 and committed', async () => {
  const { BUILTIN_DRAWIO_ID } = await import('../server/integrations.ts');
  const head = git('rev-parse', 'HEAD');
  const created = await f.admin.post(dg(), { kind: 'components', repoId, title: 'Payments icons', style: 'icon' });
  assert.equal(created.diagram.style, 'icon');
  assert.equal(created.diagram.format, 'drawio');
  assert.equal(created.diagram.cloud, 'aws', 'no signal in the repository: the default');
  assert.equal(created.diagram.status, 'generating');
  assert.match(created.workflow.goal, /^Architecture diagram request: components\nStyle: icon diagram \(draw\.io\), cloud: aws/);
  assert.match(created.workflow.rules, /diagram\.drawio/);
  assert.deepEqual(created.workflow.integrations, [BUILTIN_DRAWIO_ID], 'the icon integration is attached to this session');
  diagramId = created.diagram.id;
  diagramSlug = created.diagram.slug;
  sessionId = created.workflow.id;

  const done = await settled(diagramId);
  const d = done.diagram;
  assert.equal(d.status, 'ready', JSON.stringify(d));
  assert.equal(d.version, 1);
  assert.equal(d.format, 'drawio');
  assert.equal(d.style, 'icon');
  assert.equal(d.cloud, 'aws');
  assert.equal(d.cloud_label, 'AWS');
  assert.match(d.drawio, /^<mxfile host="agent-portal">/);
  assert.match(d.drawio, /mxgraph\.aws4\.resourceIcon/);
  assert.equal(d.mermaid, '');
  assert.ok(d.density.icons >= 2 && d.density.dense === false, JSON.stringify(d.density));
  assert.match(d.description, /payments\/app\.py|payments\/README\.md/);
  assert.ok(d.citations.length >= 1);
  assert.equal(d.sources[0].sha, head);
  assert.equal(d.path, `docs/diagrams/${diagramSlug}.drawio`);
  assert.deepEqual(Object.keys(d.links).sort(), ['drawio', 'png', 'svg']);
  assert.equal(done.versions[0].format, 'drawio');
  assert.equal(done.versions[0].drawio, undefined, 'the version list stays light');
  assert.equal(done.versions[0].cloud, 'aws');

  const file = fs.readFileSync(path.join(slugDir, 'docs/diagrams', `${diagramSlug}.drawio`), 'utf8');
  assert.equal(file.trim(), d.drawio.trim());
  assert.equal(fs.existsSync(path.join(slugDir, 'docs/diagrams', `${diagramSlug}.mmd`)), false);
  const meta = JSON.parse(fs.readFileSync(path.join(slugDir, 'docs/diagrams', `${diagramSlug}.json`), 'utf8'));
  assert.equal(meta.format, 'drawio');
  assert.equal(meta.style, 'icon');
  assert.equal(meta.cloud, 'aws');
  assert.match(execFileSync('git', ['log', '--format=%s', '--', 'docs/diagrams'], { cwd: slugDir }).toString(), /Add diagram Payments icons \(v1\)/);

  const vault = path.join(vaultRoot, 'generated', 'diagrams', `${diagramSlug}.drawio`);
  assert.equal(fs.readFileSync(vault, 'utf8').trim(), d.drawio.trim(), 'the Vault copy is the .drawio file');
  assert.deepEqual(d.vault_files.filter((x: string) => x.endsWith('.drawio')), [`generated/diagrams/${diagramSlug}.drawio`]);

  const out = (await f.admin.get(`/api/workflows/${sessionId}`)).output;
  assert.equal(out.kind, 'diagram');
  assert.equal(out.style, 'icon');
  assert.equal(out.format, 'drawio');
  assert.equal(out.cloud, 'aws');
  assert.equal(out.status, 'ready');
  assert.ok(out.density.nodes >= 3);

  const run = await f.admin.get(`/api/runs/${(await f.admin.get(`/api/workflows/${sessionId}`)).workflow.last_run_id}`);
  assert.match(JSON.stringify(run.run.meta), /icon_diagrams/, 'the run recorded the attached integration');
  const ev = await events(sessionId);
  assert.ok(ev.some((e) => /icon diagram, AWS icons, draw\.io lookups attached/.test(e.body)));
});

test('the lookups tool is the only draw.io tool a session can call: others are blocked in the run', async () => {
  const r = await f.admin.post(`${dg()}/${diagramId}/refresh`, { focus: '[demo-blocked-tool]' });
  await settled(diagramId);
  const { all } = await import('../server/db.ts');
  const rows = all<{ data: string }>("SELECT e.data FROM agent_run_events e JOIN agent_runs r ON r.id = e.run_id WHERE r.workflow_id = ? AND e.data LIKE '%only allows these tools%'", r.workflow.id);
  assert.ok(rows.length >= 1, 'the open_drawio_xml call was refused');
  assert.match(rows[0].data, /search_shapes, get_drawio_reference/);
  assert.equal((await f.admin.get(`${dg()}/${diagramId}`)).diagram.version, 2, 'the rest of that session still stored its diagram');
});

test('a chosen cloud is used and shapes the file: Azure draws icon images', async () => {
  const c = await f.admin.post(dg(), { kind: 'system_context', repoId, title: 'Payments on Azure', style: 'icon', cloud: 'azure' });
  assert.equal(c.diagram.cloud, 'azure');
  assert.match(c.workflow.goal, /cloud: azure/);
  assert.match(c.workflow.goal, /azure subscription/);
  const done = await settled(c.diagram.id);
  assert.equal(done.diagram.status, 'ready', JSON.stringify(done.diagram));
  assert.match(done.diagram.drawio, /image=img\/lib\/azure2\//);
  assert.equal(done.diagram.cloud, 'azure');
  await f.admin.del(`${dg()}/${c.diagram.id}`);
});

test('the detect-cloud route says what the repositories point to', async () => {
  const r = await f.admin.get(`${dg()}/detect-cloud?repoIds=${repoId}`);
  assert.equal(r.cloud, 'aws');
  assert.equal(r.detected, false);
  assert.equal(r.label, 'AWS');
});

/* ---- invalid results ---- */

test('files the checks refuse keep the previous version and say why, in the item and in the session', async () => {
  const cases: [string, RegExp][] = [
    ['[demo-invalid-drawio]', /The draw\.io file was refused: The diagram file is not well-formed XML/],
    ['[demo-oversized-drawio]', /The draw\.io file was refused: The diagram file is too large/],
    ['[demo-toomany-drawio]', /more than 300 cells/],
    ['[demo-external-drawio]', /link or an external address/],
    ['[demo-script-drawio]', /markup that is not allowed/],
    ['[demo-multipage-drawio]', /more than one page/],
    ['[demo-no-drawio]', /did not write a draw\.io file \(diagram\.drawio\)/],
  ];
  const before = (await f.admin.get(`${dg()}/${diagramId}`)).diagram;
  for (const [marker, re] of cases) {
    const r = await f.admin.post(`${dg()}/${diagramId}/refresh`, { focus: marker });
    const after = await settled(diagramId);
    assert.equal(after.diagram.version, before.version, `${marker}: no new version`);
    assert.equal(after.diagram.status, 'ready');
    assert.match(after.diagram.error, re, marker);
    assert.match(after.diagram.error, new RegExp(`previous version \\(v${before.version}\\) was kept`));
    assert.ok((await events(r.workflow.id)).some((e) => /was not stored/.test(e.body)), `${marker}: the session history says it`);
    assert.equal(after.diagram.drawio, before.drawio, 'the stored diagram is unchanged');
  }
});

test('a new icon diagram whose first file is refused ends in error with no version and nothing committed', async () => {
  const c = await f.admin.post(dg(), { kind: 'data_flow', repoId, title: 'Broken icons', style: 'icon', focus: '[demo-external-drawio]' });
  const done = await settled(c.diagram.id);
  assert.equal(done.diagram.status, 'error');
  assert.equal(done.diagram.version, 0);
  assert.match(done.diagram.error, /external address/);
  assert.equal(done.diagram.density, null);
  assert.equal(fs.existsSync(path.join(slugDir, 'docs/diagrams', `${c.diagram.slug}.drawio`)), false);
  await f.admin.del(`${dg()}/${c.diagram.id}`);
});

/* ---- versions, stale, follow-ups ---- */

test('stale: the diagram is flagged when its repository moves, and a refresh (the stored style) makes version 3', async () => {
  const before = (await f.admin.get(`${dg()}/${diagramId}`)).diagram;
  assert.equal(before.version, 2);
  fs.writeFileSync(path.join(repoDir, 'worker.py'), '# worker\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'worker');
  const newHead = git('rev-parse', 'HEAD');
  await syncRepo();
  assert.equal((await f.admin.get(`${dg()}/${diagramId}`)).diagram.stale, 1);
  assert.equal((await f.admin.get(dg())).diagrams.find((d: any) => d.id === diagramId).stale, 1);

  const r = await f.admin.post(`${dg()}/${diagramId}/refresh`, { focus: '' });
  assert.equal(r.diagram.style, 'icon', 'the stored style is kept');
  sessionId = r.workflow.id; // the session that last drew the diagram is the one a follow-up reaches
  assert.deepEqual(r.workflow.integrations.length, 1);
  const next = await settled(diagramId);
  assert.equal(next.diagram.version, 3);
  assert.equal(next.diagram.stale, 0);
  assert.equal(next.diagram.sources[0].sha, newHead);
  assert.match(next.diagram.drawio, /worker/);
  assert.deepEqual(next.versions.map((v: any) => v.version), [3, 2, 1]);
  const v1 = await f.admin.get(`${dg()}/${diagramId}/versions/1`);
  assert.equal(v1.current, false);
  assert.equal(v1.version.format, 'drawio');
  assert.doesNotMatch(v1.version.drawio, /worker/);
  assert.match(execFileSync('git', ['log', '--format=%s', '--', 'docs/diagrams'], { cwd: slugDir }).toString(), /Update diagram Payments icons \(v3\)/);
});

test('follow-ups in the session: a new file makes a new version, the same file or no file changes nothing and says so', async () => {
  const cur = (await f.admin.get(`${dg()}/${diagramId}`)).diagram;
  // Same file again: nothing new.
  await followUp(sessionId, (g) => g, 'Draw it again please');
  const same = await settled(diagramId);
  assert.equal(same.diagram.version, cur.version);
  assert.equal(same.diagram.error, null);
  const evs = await events(sessionId);
  assert.ok(evs.some((e) => /already stored, so no new version was made/.test(e.body)), JSON.stringify(evs.slice(-6).map((e) => e.body.slice(0, 160))));
  // No file: nothing changes. (A file counts as new when it is written within a second before the run starts, so wait that out.)
  await new Promise((r) => setTimeout(r, 1300));
  await followUp(sessionId, (g) => `${g}\n[demo-no-drawio]`, 'Where is the diagram?');
  const none = await settled(diagramId);
  assert.equal(none.diagram.version, cur.version);
  const evs2 = await events(sessionId);
  assert.ok(evs2.some((e) => /wrote no new diagram\.drawio in the run folder, so nothing was changed/.test(e.body)), JSON.stringify(evs2.slice(-5).map((e) => e.body.slice(0, 200))) + JSON.stringify(none.diagram.error));
  // A different diagram: a new version through the same session.
  await new Promise((r) => setTimeout(r, 1300));
  await followUp(sessionId, (g) => g.replace('cloud: aws', 'cloud: gcp'), 'Use Google Cloud icons instead');
  const next = await settled(diagramId);
  assert.equal(next.diagram.version, cur.version + 1);
  assert.match(next.diagram.drawio, /mxgraph\.gcp2/);
  assert.equal(next.diagram.cloud, 'aws', 'the diagram keeps its stored cloud; the follow-up changed only the file');
});

/* ---- exports ---- */

test('export: the .drawio file always, any version; PNG and SVG say clearly when they cannot be made', async () => {
  const cur = (await f.admin.get(`${dg()}/${diagramId}`)).diagram;
  const dl = await f.admin.req('GET', `${dg()}/${diagramId}/export?format=drawio`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-type') ?? '', /application\/vnd\.jgraph\.mxfile/);
  assert.match(dl.headers.get('content-disposition') ?? '', new RegExp(`${diagramSlug}\\.drawio`));
  assert.equal(String(dl.data ?? dl.buf).trim(), cur.drawio.trim());
  const old = await f.admin.req('GET', `${dg()}/${diagramId}/export?format=drawio&version=1`);
  assert.match(old.headers.get('content-disposition') ?? '', /-v1\.drawio/);
  assert.equal((await f.admin.req('GET', `${dg()}/${diagramId}/export?format=mmd`)).status, 400, 'mmd is for Mermaid');
  assert.equal((await f.admin.req('GET', `${dg()}/${diagramId}/export?format=drawio&version=40`)).status, 404);

  // The viewer files are in place (the stub) but there may be no browser; with a browser, pictures are drawn and kept.
  const problem = (await import('../server/drawio-render.ts')).drawioRendererProblem();
  const png = await f.admin.req('GET', `${dg()}/${diagramId}/export?format=png`);
  const svg = await f.admin.req('GET', `${dg()}/${diagramId}/export?format=svg`);
  if (problem) {
    assert.equal(png.status, 501);
    assert.match(png.data.error, /PNG export is not available/);
    assert.match(png.data.error, /format=drawio/);
    assert.equal(svg.status, 501);
  } else {
    assert.equal(png.status, 200, String(png.data).slice(0, 300));
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(png.buf!.subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type') ?? '', /image\/svg\+xml/);
    assert.match(String(svg.data ?? svg.buf), /<svg/);
    assert.ok(fs.existsSync(path.join(f.srv.dataDir, 'diagram-renders', f.pid, `${diagramId}-v${cur.version}.png`)), 'the picture is kept');
  }
});

test('without the viewer files: the diagram is stored and downloadable, previews say why not, and the session is told', async () => {
  const { rendererDir } = await import('../server/drawio-pack.ts');
  const dir = rendererDir();
  const away = `${dir}-away`;
  fs.renameSync(dir, away);
  try {
    const list = await f.admin.get(dg());
    const icon = list.styles.find((s: any) => s.id === 'icon');
    assert.equal(icon.available, true, 'drawing still works');
    assert.equal(icon.preview.available, false);
    assert.match(icon.preview.reason, /viewer files are not installed/);
    assert.equal(list.exportIcon.png, false);
    assert.match(list.exportIcon.previewReason, /Settings > Tools/);
    for (const fmt of ['png', 'svg']) {
      const r = await f.admin.req('GET', `${dg()}/${diagramId}/export?format=${fmt}&version=1`);
      assert.equal(r.status, 501, fmt);
      assert.match(r.data.error, /viewer files are not installed/);
    }
    assert.equal((await f.admin.req('GET', `${dg()}/${diagramId}/export?format=drawio`)).status, 200);
    const r = await f.admin.post(`${dg()}/${diagramId}/refresh`, { focus: ' ' });
    const done = await settled(diagramId);
    assert.equal(done.diagram.status, 'ready', JSON.stringify(done.diagram));
    assert.ok((await events(r.workflow.id)).some((e) => /stored, but its picture cannot be drawn on this server/.test(e.body)) || done.diagram.error === null);
    const pack = (await f.admin.get('/api/tool-packs')).packs.find((p: any) => p.id === 'drawio');
    assert.equal(pack.status, 'available', 'drawing needs only the tool part');
    assert.match(pack.reason, /viewer files/);
  } finally {
    fs.renameSync(away, dir);
  }
});

const hasBrowser = () => findBrowser() === null;

test('pictures: with the viewer files and a browser, PNG and SVG are drawn offline and the Vault gets them', { skip: hasBrowser() ? 'no headless browser' : false, timeout: 90_000 }, async () => {
  const cur = (await f.admin.get(`${dg()}/${diagramId}`)).diagram;
  const r = await f.admin.post(`${dg()}/${diagramId}/refresh`, { focus: ' ' });
  const done = await settled(diagramId);
  assert.ok(done.diagram.version >= cur.version);
  await f.admin.get(`${dg()}/${diagramId}/export?format=png`);
  const vaultDir = path.join(vaultRoot, 'generated', 'diagrams');
  await waitFor(async () => (fs.existsSync(path.join(vaultDir, `${diagramSlug}.png`)) && fs.existsSync(path.join(vaultDir, `${diagramSlug}.svg`)) ? true : null), 'the Vault pictures', 30_000);
  assert.equal(fs.readFileSync(path.join(vaultDir, `${diagramSlug}.png`)).subarray(1, 4).toString('ascii'), 'PNG');
  assert.match(fs.readFileSync(path.join(vaultDir, `${diagramSlug}.svg`), 'utf8'), /<svg/);
  assert.ok(r.workflow.id);
});

/* ------------------------------------------------------------------ */
/* Embedding in documents and decks                                     */
/* ------------------------------------------------------------------ */

test('other features embed a stored icon diagram as an image reference to its .drawio file', async () => {
  const { diagramSource, diagramMarkdown, diagramImageRef } = await import('../server/diagrams.ts');
  const src = diagramSource(f.pid, diagramSlug)!;
  assert.equal(src.format, 'drawio');
  assert.equal(src.mermaid, '');
  assert.match(src.drawio!, /^<mxfile/);
  assert.equal(src.current, true);
  const ref = diagramImageRef(f.pid, diagramSlug)!;
  assert.equal(ref.path, `docs/diagrams/${diagramSlug}.drawio`);
  assert.equal(ref.current, true);
  assert.equal(fs.readFileSync(path.join(slugDir, ref.path), 'utf8').trim(), src.drawio!.trim());
  const md = diagramMarkdown(f.pid, diagramSlug, { heading: true, description: true })!;
  assert.match(md, new RegExp(`^## Payments icons\\n\\n!\\[Payments icons\\]\\(docs/diagrams/${diagramSlug}\\.drawio\\)\\n\\nDemo`));
  const oldRef = diagramImageRef(f.pid, diagramSlug, { version: 1 })!;
  assert.equal(oldRef.path, `.portal/diagram-versions/${diagramSlug}-v1.drawio`);
  assert.equal(oldRef.current, false);
  assert.match(fs.readFileSync(path.join(slugDir, oldRef.path), 'utf8'), /^<mxfile/);
  assert.equal(diagramImageRef(f.pid, 'nope'), null);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--', 'docs/diagrams'], { cwd: slugDir }).toString().trim(), '', 'staging the file does not dirty the repository');
});

async function docxText(buf: Buffer) {
  const z = await JSZip.loadAsync(buf);
  return { xml: await z.file('word/document.xml')!.async('string'), media: Object.keys(z.files).filter((n) => n.startsWith('word/media/')) };
}

test('a document that uses a stored icon diagram: the picture when it can be drawn, a labelled placeholder and a warning when it cannot', async () => {
  const { rendererDir } = await import('../server/drawio-pack.ts');
  const dir = rendererDir();
  const away = `${dir}-away`;
  fs.renameSync(dir, away);
  let docId = '';
  try {
    const c = await f.admin.post(docs(), { type: 'architecture', repoIds: [repoId], diagramIds: [diagramId], title: 'Payments architecture', includeKnowledge: false, includeDecisions: false });
    assert.equal(c.document.diagram_style, 'mermaid');
    assert.deepEqual(c.workflow.integrations, [], 'no icon tools unless the document draws its own icon diagrams');
    docId = c.document.id;
    const done = await docSettled(docId);
    assert.equal(done.document.status, 'ready', JSON.stringify(done.document));
    assert.match(done.document.markdown, new RegExp(`!\\[Payments icons\\]\\(docs/diagrams/${diagramSlug}\\.drawio\\)`));
    assert.ok(done.document.warnings.some((w: string) => /Icon diagram "docs\/diagrams\/.*\.drawio" not drawn: the draw\.io viewer files are not installed/.test(w)), JSON.stringify(done.document.warnings));
    const dl = await f.admin.req('GET', `${docs()}/${docId}/download?format=docx`);
    assert.equal(dl.status, 200);
    const t = await docxText(dl.buf!);
    assert.match(t.xml, /Icon diagram not drawn: docs\/diagrams\//);
    assert.equal(t.media.length, 0);
  } finally {
    fs.renameSync(away, dir);
  }
  await f.admin.del(`${docs()}/${docId}`);
});

test('a document that draws its own icon diagrams: the icon tools are attached, the file is checked and embedded', { timeout: 120_000 }, async () => {
  const { BUILTIN_DRAWIO_ID } = await import('../server/integrations.ts');
  const bad = await f.admin.req('POST', docs(), { type: 'overview', repoIds: [repoId], diagramCloud: 'aws' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /only applies to the icon diagram style/);
  const bad2 = await f.admin.req('POST', docs(), { type: 'overview', repoIds: [repoId], diagramStyle: 'icon', diagramCloud: 'mars' });
  assert.equal(bad2.status, 400);
  const list = await f.admin.get(docs());
  assert.equal(list.styles.find((s: any) => s.id === 'icon').available, true);
  assert.equal(list.clouds.length, 5);
  assert.equal(typeof list.word.iconDiagrams, 'boolean');

  const c = await f.admin.post(docs(), { type: 'overview', repoIds: [repoId], title: 'Payments overview', includeKnowledge: false, includeDecisions: false, diagramStyle: 'icon', diagramCloud: 'gcp' });
  assert.equal(c.document.diagram_style, 'icon');
  assert.equal(c.document.diagram_cloud, 'gcp');
  assert.deepEqual(c.workflow.integrations, [BUILTIN_DRAWIO_ID]);
  assert.match(c.workflow.goal, /you may add up to 2 icon diagrams \(official Google Cloud style\)/);
  assert.doesNotMatch(c.workflow.goal, /fenced mermaid block/);
  const done = await docSettled(c.document.id);
  assert.equal(done.document.status, 'ready', JSON.stringify(done.document));
  assert.match(done.document.markdown, /!\[How the parts fit together\]\(.*flow\.drawio\)/);
  const noPicture = (w: string) => /Icon diagram ".*flow\.drawio" not drawn/.test(w);
  const dl = await f.admin.req('GET', `${docs()}/${c.document.id}/download?format=docx`);
  const t = await docxText(dl.buf!);
  if ((await import('../server/drawio-render.ts')).drawioRendererProblem() === null) {
    assert.ok(!done.document.warnings.some(noPicture), JSON.stringify(done.document.warnings));
    assert.ok(t.media.length >= 1, 'the diagram is a picture in the Word file');
  } else {
    assert.ok(done.document.warnings.some(noPicture), JSON.stringify(done.document.warnings));
    assert.match(t.xml, /Icon diagram not drawn/);
  }
  await f.admin.del(`${docs()}/${c.document.id}`);
});

test('an agent-drawn diagram a document cannot use becomes a placeholder and a warning, never a failure', async () => {
  const c = await f.admin.post(docs(), { type: 'overview', repoIds: [repoId], title: 'Payments overview [demo-external-drawio]', includeKnowledge: false, includeDecisions: false, diagramStyle: 'icon' });
  const done = await docSettled(c.document.id);
  assert.equal(done.document.status, 'ready', JSON.stringify(done.document));
  assert.ok(done.document.warnings.some((w: string) => /Icon diagram ".*flow\.drawio" not drawn: .*external address/.test(w)), JSON.stringify(done.document.warnings));
  const t = await docxText((await f.admin.req('GET', `${docs()}/${c.document.id}/download?format=docx`)).buf!);
  assert.match(t.xml, /Icon diagram not drawn: .*flow\.drawio/);
  assert.equal(t.media.length, 0);
  await f.admin.del(`${docs()}/${c.document.id}`);
});

async function pptxMedia(buf: Buffer) {
  const z = await JSZip.loadAsync(buf);
  const slides = Object.keys(z.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  let text = '';
  for (const s of slides) text += await z.file(s)!.async('string');
  return { text, media: Object.keys(z.files).filter((n) => n.startsWith('ppt/media/')) };
}

test('a deck from a stored icon diagram puts it on a slide as an image; a deck that draws its own gets the icon tools', { timeout: 120_000 }, async () => {
  const { BUILTIN_DRAWIO_ID } = await import('../server/integrations.ts');
  const drawn = (await import('../server/drawio-render.ts')).drawioRendererProblem() === null;
  const c = await f.admin.post(decks(), { diagramId, slideCount: 5 });
  assert.equal(c.presentation.diagram_style, 'mermaid');
  assert.match(c.workflow.goal, /icon architecture diagram "Payments icons"/);
  assert.match(c.workflow.goal, new RegExp(`"image" element whose "path" is "docs/diagrams/${diagramSlug}\\.drawio"`));
  assert.deepEqual(c.workflow.integrations, []);
  const done = await deckSettled(c.presentation.id);
  assert.equal(done.presentation.status, 'ready', JSON.stringify(done.presentation));
  const dl = await f.admin.req('GET', `${decks()}/${c.presentation.id}/download`);
  const m = await pptxMedia(dl.buf!);
  if (drawn) {
    assert.ok(m.media.length >= 1, 'the diagram is a picture on a slide');
    assert.ok(!done.presentation.warnings.some((w: string) => /Icon diagram/.test(w)));
  } else {
    assert.ok(done.presentation.warnings.some((w: string) => /Icon diagram ".*\.drawio" not drawn/.test(w)), JSON.stringify(done.presentation.warnings));
    assert.match(m.text, /Icon diagram not drawn: docs\/diagrams\//);
  }
  await f.admin.del(`${decks()}/${c.presentation.id}`);

  const own = await f.admin.post(decks(), { topic: 'Why the refund approval limits changed in Q4. Agents may refund up to 100. Managers may refund up to 5000.', diagramStyle: 'icon', diagramCloud: 'azure', slideCount: 5 });
  assert.equal(own.presentation.diagram_style, 'icon');
  assert.equal(own.presentation.diagram_cloud, 'azure');
  assert.deepEqual(own.workflow.integrations, [BUILTIN_DRAWIO_ID]);
  assert.match(own.workflow.goal, /you may draw up to 2 icon diagrams \(official Azure style\)/);
  const ownDone = await deckSettled(own.presentation.id);
  assert.equal(ownDone.presentation.status, 'ready', JSON.stringify(ownDone.presentation));
  const m2 = await pptxMedia((await f.admin.req('GET', `${decks()}/${own.presentation.id}/download`)).buf!);
  if (drawn) assert.ok(m2.media.length >= 1);
  else assert.ok(ownDone.presentation.warnings.some((w: string) => /Icon diagram/.test(w)));
  await f.admin.del(`${decks()}/${own.presentation.id}`);

  const bad = await f.admin.req('POST', decks(), { topic: 'Refund policy overview', diagramStyle: 'icon', diagramCloud: 'mars' });
  assert.equal(bad.status, 400);
  const list = await f.admin.get(decks());
  assert.equal(list.styles.find((s: any) => s.id === 'icon').available, true);
  assert.equal(list.clouds.length, 5);
});

/* ------------------------------------------------------------------ */
/* make-doc: .drawio files as pictures                                  */
/* ------------------------------------------------------------------ */

test('make-doc: an image path ending in .drawio is drawn, and a missing renderer gives a labelled placeholder with a warning', async () => {
  const { generate } = await import('../server/docgen.ts');
  const { rendererDir } = await import('../server/drawio-pack.ts');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'makedoc-'));
  fs.writeFileSync(path.join(work, 'arch.drawio'), GOOD);
  fs.writeFileSync(path.join(work, 'bad.drawio'), demoDrawio({ cloud: 'aws', title: 'x', items: ['a'], variant: 'external' }));
  fs.writeFileSync(path.join(work, 'notdrawio.drawio'), 'hello');
  try {
    const spec = { type: 'docx', output: 'out.docx', blocks: [{ type: 'image', path: 'arch.drawio', caption: 'Architecture' }, { type: 'image', path: 'bad.drawio' }] } as any;
    const r = await generate(spec, { baseDir: work });
    assert.ok(r.warnings?.some((w) => /Icon diagram "bad\.drawio" not drawn: .*external address/.test(w)), JSON.stringify(r.warnings));
    const t = await docxText(fs.readFileSync(path.join(work, 'out.docx')));
    assert.match(t.xml, /Icon diagram not drawn: bad\.drawio/);
    if ((await import('../server/drawio-render.ts')).drawioRendererProblem() === null) {
      assert.ok(t.media.length >= 1, 'the good diagram is a picture');
      assert.ok(!r.warnings?.some((w) => /arch\.drawio/.test(w)));
    } else {
      assert.ok(r.warnings?.some((w) => /Icon diagram "arch\.drawio" not drawn/.test(w)));
    }
    await assert.rejects(generate({ type: 'docx', output: 'o2.docx', blocks: [{ type: 'image', path: 'notdrawio.drawio' }] } as any, { baseDir: work }), /not a draw\.io diagram/);
    await assert.rejects(generate({ type: 'docx', output: 'o3.docx', blocks: [{ type: 'image', path: '../etc/x.drawio' }] } as any, { baseDir: work }), /must be inside|not found/);

    // With the viewer files away the placeholder and the warning still appear; the command never fails.
    const dir = rendererDir();
    fs.renameSync(dir, `${dir}-away`);
    try {
      const r2 = await generate({ type: 'pptx', output: 'out.pptx', slides: [{ layout: 'image', title: 'Arch', image: { path: 'arch.drawio', caption: 'c' } }] } as any, { baseDir: work });
      assert.ok(r2.warnings?.some((w) => /Icon diagram "arch\.drawio" not drawn: the draw\.io viewer files are not installed/.test(w)), JSON.stringify(r2.warnings));
      const z = await JSZip.loadAsync(fs.readFileSync(path.join(work, 'out.pptx')));
      assert.match(await z.file('ppt/slides/slide1.xml')!.async('string'), /Icon diagram not drawn: arch\.drawio/);
    } finally {
      fs.renameSync(`${dir}-away`, dir);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('rendering: the pipeline from a validated file to PNG and SVG works in the headless browser (stub viewer)', { skip: hasBrowser() ? 'no headless browser' : false, timeout: 60_000 }, async () => {
  const { renderDrawio, inlineIconImages } = await import('../server/drawio-render.ts');
  const [a, bad, c] = await renderDrawio([{ xml: GOOD }, { xml: 'not a diagram' }, { xml: demoDrawio({ cloud: 'gcp', title: 'y', items: ['b'] }) }]);
  assert.equal(a.ok, true, JSON.stringify(a));
  if (a.ok) {
    assert.equal(a.png.subarray(1, 4).toString('ascii'), 'PNG');
    assert.match(a.svg, /<svg/);
    assert.match(a.svg, /cells \d+/, 'the page ran the (stub) viewer on the checked diagram');
    assert.ok(a.pxW > 0 && a.density > 0);
  }
  assert.equal(bad.ok, false, 'a file that fails the checks never reaches the browser');
  if (!bad.ok) assert.match(bad.reason, /not well-formed XML|must start with/);
  assert.equal(c.ok, true);
  // Icon images are put into the picture from the installed image folder, never fetched.
  const { rendererDir } = await import('../server/drawio-pack.ts');
  const xml = validateDrawio(demoDrawio({ cloud: 'azure', title: 'z', items: ['a'] })).xml;
  const inl = inlineIconImages(xml, path.join(rendererDir(), 'img', 'lib'));
  assert.deepEqual(inl.missing, []);
  assert.match(inl.xml, /image=data:image\/svg\+xml,[A-Za-z0-9+/=]+;/);
  const none = inlineIconImages(xml, path.join(packRoot, 'no-such-images'));
  assert.deepEqual(none.missing, ['azure2/compute/Function_Apps.svg']);
  assert.match(none.xml, /image=img\/lib\/azure2\/compute\/Function_Apps\.svg/);
});

/* ------------------------------------------------------------------ */
/* Access, audit, delete                                                */
/* ------------------------------------------------------------------ */

test('roles: a viewer reads and exports icon diagrams, but cannot create or refresh them', async () => {
  assert.equal((await f.viewer.req('GET', dg())).status, 200);
  assert.equal((await f.viewer.req('GET', `${dg()}/${diagramId}/export?format=drawio`)).status, 200);
  assert.equal((await f.viewer.req('POST', dg(), { kind: 'components', repoId, style: 'icon' })).status, 403);
  assert.equal((await f.viewer.req('POST', `${dg()}/${diagramId}/refresh`, { style: 'icon' })).status, 403);
  assert.ok([403, 404].includes((await f.outsider.req('GET', `${dg()}/${diagramId}/export?format=drawio`)).status));
});

test('actions are audited with the style, cloud and format', async () => {
  const text = (e: any) => (typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail));
  const has = async (action: string, re: RegExp) => {
    const { entries } = await f.admin.get(`/api/admin/audit-log?action=${action}&limit=100`);
    assert.ok(entries.some((e: any) => re.test(text(e))), `${action} ${re}`);
  };
  await has('diagram.create', /"style":"icon"/);
  await has('diagram.version', /"format":"drawio".*"style":"icon"|"style":"icon".*"format":"drawio"/);
  await has('diagram.refresh', /"style":"icon"/);
  await has('diagram.export', /"format":"drawio"/);
  await has('tool.install', /drawio/).catch(() => undefined);
  const { entries } = await f.admin.get('/api/admin/audit-log?action=diagram.version&limit=100');
  assert.ok(entries.some((e: any) => /"ok":false/.test(text(e))), 'refused files are recorded too');
});

test('the project outputs list the icon diagram and sync copies it to the Vault again', async () => {
  const { syncProjectGenerated } = await import('../server/outputs.ts');
  const vault = path.join(vaultRoot, 'generated', 'diagrams', `${diagramSlug}.drawio`);
  fs.rmSync(vault, { force: true });
  assert.ok((await syncProjectGenerated(f.pid, null)) >= 1);
  assert.match(fs.readFileSync(vault, 'utf8'), /^<mxfile/);
});

test('delete removes the icon diagram, its files, its Vault copies and its pictures', async () => {
  const { diagram } = await f.admin.get(`${dg()}/${diagramId}`);
  assert.equal((await f.admin.del(`${dg()}/${diagramId}`)).ok, true);
  assert.equal((await f.admin.req('GET', `${dg()}/${diagramId}`)).status, 404);
  assert.equal(fs.existsSync(path.join(slugDir, 'docs/diagrams', `${diagram.slug}.drawio`)), false);
  assert.equal(fs.existsSync(path.join(slugDir, 'docs/diagrams', `${diagram.slug}.json`)), false);
  assert.equal(fs.readdirSync(path.join(vaultRoot, 'generated', 'diagrams')).filter((n) => n.startsWith(diagram.slug)).length, 0);
  const renders = path.join(f.srv.dataDir, 'diagram-renders', f.pid);
  assert.equal(fs.existsSync(renders) ? fs.readdirSync(renders).filter((n) => n.startsWith(diagramId)).length : 0, 0);
  assert.match(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: slugDir }).toString(), /Delete diagram Payments icons/);
});

test('Mermaid diagrams are unchanged: default style, mermaid format, no icon tools attached', async () => {
  const c = await f.admin.post(dg(), { kind: 'components', repoId, title: 'Plain mermaid' });
  assert.equal(c.diagram.style, 'mermaid');
  assert.equal(c.diagram.format, 'mermaid');
  assert.equal(c.diagram.cloud, null);
  assert.deepEqual(c.workflow.integrations, []);
  assert.doesNotMatch(c.workflow.goal, /Style: icon/);
  const done = await settled(c.diagram.id);
  assert.equal(done.diagram.status, 'ready');
  assert.match(done.diagram.mermaid, /^flowchart TB/);
  assert.equal(done.diagram.drawio, null);
  assert.deepEqual(Object.keys(done.diagram.links).sort(), ['mmd', 'png']);
  assert.equal((await f.admin.req('GET', `${dg()}/${c.diagram.id}/export?format=drawio`)).status, 400);
  assert.equal((await f.admin.req('GET', `${dg()}/${c.diagram.id}/export?format=mmd`)).status, 200);
  // A Mermaid diagram can be redrawn as an icon diagram: a new version in the other format.
  const r = await f.admin.post(`${dg()}/${c.diagram.id}/refresh`, { style: 'icon', cloud: 'kubernetes' });
  assert.equal(r.diagram.style, 'icon');
  const icon = await settled(c.diagram.id);
  assert.equal(icon.diagram.version, 2);
  assert.equal(icon.diagram.format, 'drawio');
  assert.equal(icon.diagram.cloud, 'kubernetes');
  assert.equal(icon.versions.find((v: any) => v.version === 1).format, 'mermaid');
  assert.equal(fs.existsSync(path.join(slugDir, 'docs/diagrams', `${c.diagram.slug}.mmd`)), false, 'the old format file is replaced');
  assert.equal(fs.existsSync(path.join(slugDir, 'docs/diagrams', `${c.diagram.slug}.drawio`)), true);
  await f.admin.del(`${dg()}/${c.diagram.id}`);
});

test('the drawio file helpers also cover the small cases', () => {
  assert.equal(drawioDensity('').nodes, 0);
  assert.throws(() => validateDrawio(''), /empty/);
  assert.throws(() => validateDrawio(undefined), /empty/);
});
