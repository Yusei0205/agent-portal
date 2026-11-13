import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { compactGraph, encodeGraph } from '../server/agent/runner-graph.ts';
import { validateGraph, searchNodes, neighbourhood, takeRunnerEvent } from '../server/code-map.ts';

const raw = {
  nodes: [
    { id: 'a_pay', label: 'payInvoice()', _callable: true, community: 1, community_name: 'billing', source_file: 'src/pay.ts', source_location: 'L12' },
    { id: 'a_refund', label: 'refund()', _callable: true, community: 1, source_file: 'src/refund.ts', source_location: 'L3' },
    { id: 'a_Acct', label: 'Account', _callable: true, _callable_class: true, community: 2, community_name: 'accounts', source_file: 'src/account.ts', source_location: 'L1' },
    { id: 'f_pay', label: '../pay.ts', community: 1, source_file: 'pay.ts' },
    { id: 'ref_fs', label: 'ref_fs', external: true, type: 'external', community: 1, source_file: '' },
  ],
  links: [
    { source: 'a_pay', target: 'a_refund', relation: 'calls' },
    { source: 'a_pay', target: 'a_Acct', relation: 'calls' },
    { source: 'f_pay', target: 'a_pay', relation: 'contains' },
    { source: 'a_pay', target: 'ref_fs', relation: 'imports_from' },
    { source: 'a_pay', target: 'missing', relation: 'calls' },
  ],
};

describe('compactGraph', () => {
  it('keeps names, files, lines, kinds and communities, and drops links to unknown items', () => {
    const g = compactGraph(raw)!;
    assert.equal(g.nodes.length, 5);
    assert.equal(g.links.length, 4);
    const pay = g.nodes.find((n) => n.i === 'a_pay')!;
    assert.deepEqual([pay.l, pay.f, pay.n, pay.c, pay.k], ['payInvoice()', 'src/pay.ts', 12, 1, 'function']);
    assert.equal(g.nodes.find((n) => n.i === 'a_Acct')!.k, 'class');
    assert.equal(g.nodes.find((n) => n.i === 'f_pay')!.k, 'file');
    assert.equal(g.nodes.find((n) => n.i === 'ref_fs')!.k, 'external');
    assert.deepEqual(g.communities, { '1': 'billing', '2': 'accounts' });
    assert.equal(g.truncated, false);
  });
  it('keeps the best-connected items when there are too many', () => {
    const g = compactGraph(raw, { nodes: 2, links: 100 })!;
    assert.equal(g.truncated, true);
    assert.ok(g.nodes.some((n) => n.i === 'a_pay'));
    assert.ok(g.nodes.every((n) => n.k !== 'external'));
    const ids = new Set(g.nodes.map((n) => n.i));
    assert.ok(g.links.every((l) => ids.has(l.s) && ids.has(l.t)));
  });
  it('refuses something that is not a graph', () => { assert.equal(compactGraph({ nope: 1 }), null); });
});

describe('validateGraph', () => {
  it('round-trips what the runner sends', () => {
    const g = compactGraph(raw)!;
    const back = JSON.parse(zlib.gunzipSync(Buffer.from(encodeGraph(g), 'base64')).toString('utf8'));
    assert.ok(validateGraph(back));
  });
  it('rejects empty, malformed and oversized graphs', () => {
    assert.equal(validateGraph({ nodes: [], links: [] }), null);
    assert.equal(validateGraph({ nodes: [{ i: 1 }], links: [] }), null);
    assert.equal(validateGraph(null), null);
  });
});

describe('search and neighbourhood', () => {
  const g = compactGraph(raw)!;
  const byId = new Map(g.nodes.map((n) => [n.i, n]));
  const adj = new Map<string, { other: string; r: string; dir: 'out' | 'in' }[]>();
  const degree = new Map<string, number>();
  const add = (a: string, v: { other: string; r: string; dir: 'out' | 'in' }) => { (adj.get(a) ?? adj.set(a, []).get(a)!).push(v); degree.set(a, (degree.get(a) ?? 0) + 1); };
  for (const e of g.links) { add(e.s, { other: e.t, r: e.r, dir: 'out' }); add(e.t, { other: e.s, r: e.r, dir: 'in' }); }

  it('ranks an exact name above a prefix, a substring and a file match, and skips external items', () => {
    assert.equal(searchNodes(g.nodes, degree, 'refund')[0].i, 'a_refund');
    assert.equal(searchNodes(g.nodes, degree, 'payinvoice()')[0].i, 'a_pay');
    assert.deepEqual(searchNodes(g.nodes, degree, 'account.ts').map((n) => n.i), ['a_Acct']);
    assert.equal(searchNodes(g.nodes, degree, 'fs').length, 0);
    assert.equal(searchNodes(g.nodes, degree, '  ').length, 0);
  });
  it('returns an item with its neighbours and the links among them', () => {
    const out = neighbourhood({ byId, adj, degree, links: g.links }, 'a_pay')!;
    assert.deepEqual(out.nodes.map((n) => n.i).sort(), ['a_Acct', 'a_pay', 'a_refund', 'f_pay', 'ref_fs']);
    assert.ok(out.links.some((l) => l.s === 'f_pay' && l.t === 'a_pay' && l.r === 'contains'));
    assert.equal(neighbourhood({ byId, adj, degree, links: g.links }, 'nope'), null);
  });
  it('caps the neighbours and says how many were left out', () => {
    const out = neighbourhood({ byId, adj, degree, links: g.links }, 'a_pay', 2)!;
    assert.equal(out.nodes.length, 3);
    assert.equal(out.more, 2);
  });
});

describe('takeRunnerEvent', () => {
  it('passes other events on and takes code-graph ones even when it cannot place them', async () => {
    assert.equal(await takeRunnerEvent({}, { type: 'status', text: 'x' }), false);
    assert.equal(await takeRunnerEvent({ repos: [] }, { type: 'code-graph', repo: 'unknown', encoding: 'gzip-base64', data: 'AAAA' }), true);
  });
});

describe('forceLayout', () => {
  it('puts the chosen item in the middle and keeps every item inside the frame without overlapping', async () => {
    // @ts-ignore: a plain JS module of the web app, which has no declaration file
    const { forceLayout } = await import('../web/src/lib/forceLayout.js');
    const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}` }));
    const links = nodes.slice(1).map((n) => ({ s: 'n0', t: n.id }));
    const p = forceLayout(nodes, links, 'n0', { width: 900, height: 560 });
    assert.deepEqual(p.get('n0'), { x: 450, y: 280 });
    const pts = [...p.values()];
    assert.ok(pts.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y) && q.x >= 40 && q.x <= 860 && q.y >= 30 && q.y <= 530));
    let closest = Infinity;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) closest = Math.min(closest, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    assert.ok(closest > 8, `closest pair ${closest}`);
    assert.deepEqual(forceLayout(nodes, links, 'n0'), forceLayout(nodes, links, 'n0'));
  });
});

describe('code map routes', () => {
  it('stores a graph sent by a runner and answers list, overview, search and node', async () => {
    const { createTestServer, cleanup, fetchJson } = await import('./fixtures.ts');
    const { getGitReposRepository } = await import('../server/repositories/git-repos.ts');
    const { rememberRunnerRepo } = await import('../server/code-map.ts');
    const ts = await createTestServer();
    try {
      const setup = await fetchJson(ts.baseUrl, '/api/auth/setup', { method: 'POST', body: { email: `a-${Date.now()}@test.com`, name: 'A', password: 'password1234', provider: 'demo' } });
      const cookie = setup.cookie ?? '';
      const pr = await fetchJson(ts.baseUrl, '/api/projects', { method: 'POST', body: { name: `CM ${Date.now()}` }, cookie });
      const projectId = ((pr.body as any).project as any).id as string;
      const repoId = 'gr_cm1';
      await getGitReposRepository().create({ id: repoId, project_id: projectId, name: 'Payments API', url: 'https://example.com/p.git', provider: 'github', status: 'ready', default_branch: 'main', identity: null, last_synced_at: null, last_error: null, created_at: new Date().toISOString(), connection_id: null });

      const none = await fetchJson(ts.baseUrl, `/api/projects/${projectId}/code-map`, { cookie });
      assert.equal((none.body as any).repos[0].hasMap, false);
      assert.equal((await fetchJson(ts.baseUrl, `/api/projects/${projectId}/code-map/${repoId}/overview`, { cookie })).status, 404);

      // The portal remembers which repository a runner folder is when it builds the runner's list.
      rememberRunnerRepo('Payments_API', 'https://example.com/p.git', { repoId, projectId, repoName: 'Payments API' });
      const data = encodeGraph(compactGraph(raw)!);
      const consumed = await takeRunnerEvent({ repos: [{ name: 'Payments_API', url: 'https://example.com/p.git' }] }, { type: 'code-graph', repo: 'Payments_API', encoding: 'gzip-base64', data });
      assert.equal(consumed, true);

      const list = (await fetchJson(ts.baseUrl, `/api/projects/${projectId}/code-map`, { cookie })).body as any;
      assert.equal(list.repos[0].hasMap, true);
      assert.equal(list.repos[0].nodes, 5);
      const ov = (await fetchJson(ts.baseUrl, `/api/projects/${projectId}/code-map/${repoId}/overview`, { cookie })).body as any;
      assert.ok(ov.communities.length >= 1 && ov.top.length >= 1);
      const se = (await fetchJson(ts.baseUrl, `/api/projects/${projectId}/code-map/${repoId}/search?q=refund`, { cookie })).body as any;
      assert.equal(se.results[0].i, 'a_refund');
      const nd = (await fetchJson(ts.baseUrl, `/api/projects/${projectId}/code-map/${repoId}/node?id=a_pay`, { cookie })).body as any;
      assert.equal(nd.centerId, 'a_pay');
      assert.ok(nd.nodes.length >= 4 && nd.links.length >= 3);
      assert.equal((await fetchJson(ts.baseUrl, `/api/projects/${projectId}/code-map/${repoId}/node?id=nope`, { cookie })).status, 404);
      assert.equal((await fetchJson(ts.baseUrl, `/api/projects/${projectId}/code-map/${repoId}/search?q=`, { cookie })).status, 400);
    } finally { await cleanup(); }
  });
});

describe('graphify progress', () => {
  it('reads the extraction counts and the later stages from graphify output', async () => {
    const { parseGraphifyLine } = await import('../server/agent/runner-graph.ts');
    assert.deepEqual(parseGraphifyLine('  AST cache: 0/542 files served from cache (0%); 542 to extract'), { stage: 'extract', percent: 5, detail: 'Reading the code: 542 files to read' });
    const mid = parseGraphifyLine('  AST extraction: 271/542 uncached files (50%) [12 workers]')!;
    assert.equal(mid.stage, 'extract');
    assert.equal(Math.round(mid.percent), 38);
    assert.match(mid.detail, /271 of 542 files/);
    assert.equal(parseGraphifyLine('  AST extraction: 542/542 uncached files (100%) [12 workers]')!.stage, 'build');
    assert.equal(parseGraphifyLine('[graphify watch] Rebuilt: 7123 nodes, 23558 edges, 168 communities')!.percent, 98);
    assert.equal(parseGraphifyLine('Updating code graph in . (no LLM needed)...'), null);
  });
});
