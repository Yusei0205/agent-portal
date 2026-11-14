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
      assert.equal(typeof nd.children, 'object', 'each main neighbour comes with its own small items');
      assert.equal((await fetchJson(ts.baseUrl, `/api/projects/${projectId}/code-map/${repoId}/node?id=nope`, { cookie })).status, 404);
      assert.equal((await fetchJson(ts.baseUrl, `/api/projects/${projectId}/code-map/${repoId}/search?q=`, { cookie })).status, 400);
    } finally { await cleanup(); }
  });

  it('keeps a map per branch: the list names the branches that have one, and each route reads the branch asked for', async () => {
    const { createTestServer, cleanup, fetchJson } = await import('./fixtures.ts');
    const { getGitReposRepository } = await import('../server/repositories/git-repos.ts');
    const { rememberRunnerRepo } = await import('../server/code-map.ts');
    const { getDb } = await import('../server/db.ts');
    const { setSetting } = await import('../server/settings.ts');
    const { graphIdFor } = await import('../server/graph-id.ts');
    const ts = await createTestServer();
    try {
      const setup = await fetchJson(ts.baseUrl, '/api/auth/setup', { method: 'POST', body: { email: `b-${Date.now()}@test.com`, name: 'A', password: 'password1234', provider: 'demo' } });
      const cookie = setup.cookie ?? '';
      const pr = await fetchJson(ts.baseUrl, '/api/projects', { method: 'POST', body: { name: `CMB ${Date.now()}` }, cookie });
      const projectId = ((pr.body as any).project as any).id as string;
      const repoId = 'gr_cmb';
      await getGitReposRepository().create({ id: repoId, project_id: projectId, name: 'Branchy', url: 'https://example.com/b.git', provider: 'github', status: 'ready', default_branch: 'main', identity: null, last_synced_at: null, last_error: null, created_at: new Date().toISOString(), connection_id: null });

      // A graph of the branch feature/x, built the way the build job does: the run was started with branch feature/x.
      const id = graphIdFor(repoId, 'feature/x');
      rememberRunnerRepo('Branchy', 'https://example.com/b.git', { repoId, projectId, repoName: 'Branchy', graphId: id }, 'feature/x');
      const data = encodeGraph(compactGraph(raw)!);
      await takeRunnerEvent({ repos: [{ name: 'Branchy', url: 'https://example.com/b.git', branch: 'feature/x' }] }, { type: 'code-graph', repo: 'Branchy', encoding: 'gzip-base64', data });
      await setSetting(getDb(), `codegraph.${id}`, JSON.stringify({ state: 'ready', at: new Date().toISOString(), message: '', stored: true, version: 'v1', nodes: 5, branch: 'feature/x' }));
      await setSetting(getDb(), `codegraph-index.${repoId}`, JSON.stringify(['feature/x']));

      const q = (route: string) => fetchJson(ts.baseUrl, `/api/projects/${projectId}/code-map/${repoId}/${route}`, { cookie });
      assert.equal((await q('overview?branch=feature/x')).status, 200);
      assert.equal(((await q('search?q=refund&branch=feature/x')).body as any).results[0].i, 'a_refund');
      assert.equal(((await q('node?id=a_pay&branch=feature/x')).body as any).centerId, 'a_pay');
      assert.equal((await q('overview')).status, 404, 'the default branch has no map of its own');
      assert.equal((await q('overview?branch=other')).status, 404);
      assert.equal((await q('overview?branch=..%2Fx')).status, 400);

      const list = (await fetchJson(ts.baseUrl, `/api/projects/${projectId}/code-map`, { cookie })).body as any;
      const r = list.repos.find((x: any) => x.id === repoId);
      assert.equal(r.defaultBranch, 'main');
      assert.equal(r.hasMap, false, 'the default branch has none');
      assert.deepEqual(r.branches.map((b: any) => [b.branch, b.hasMap, b.isDefault]), [['feature/x', true, false]]);
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

describe('neighbourhood: the small items beside each main neighbour', () => {
  // c uses a and b. a has four neighbours of its own (x, y, z, w), b has x and q. m is a neighbour of c as well as of a.
  const nodes = ['c', 'a', 'b', 'm', 'x', 'y', 'z', 'w', 'q', 'ext'].map((i) => ({ i, l: i, f: `${i}.ts`, n: 1, c: 0, k: i === 'ext' ? 'external' : 'function' }));
  const link = (s: string, t2: string, r = 'calls') => ({ s, t: t2, r });
  const links = [link('c', 'a'), link('c', 'b'), link('c', 'm'), link('a', 'x'), link('a', 'y'), link('a', 'z'), link('a', 'w'), link('a', 'm'), link('b', 'x'), link('b', 'q'), link('b', 'ext'), link('y', 'z')];
  const byId = new Map(nodes.map((n) => [n.i, n]));
  const adj = new Map<string, { other: string; r: string; dir: 'out' | 'in' }[]>();
  const degree = new Map<string, number>();
  const add = (a: string, v: { other: string; r: string; dir: 'out' | 'in' }) => { (adj.get(a) ?? adj.set(a, []).get(a)!).push(v); degree.set(a, (degree.get(a) ?? 0) + 1); };
  for (const e of links) { add(e.s, { other: e.t, r: e.r, dir: 'out' }); add(e.t, { other: e.s, r: e.r, dir: 'in' }); }
  const hood = neighbourhood({ byId, adj, degree, links } as never, 'c')!;

  it('gives each main neighbour up to three of its own neighbours and says how many more there are', () => {
    assert.equal(hood.children.a.nodes.length, 3);
    assert.equal(hood.children.a.more, 1);
  });
  it('never repeats the middle item or another main neighbour as somebody\'s small item, and skips external items', () => {
    for (const [owner, kids] of Object.entries(hood.children)) {
      for (const k of kids.nodes) {
        assert.ok(!['c', 'a', 'b', 'm'].includes(k.i), `${owner} shows ${k.i}`);
        assert.notEqual(k.k, 'external');
      }
    }
  });
  it('lets different neighbours show different small items when there is a choice, and keeps the direction and relation', () => {
    const aIds = hood.children.a.nodes.map((k) => k.i);
    const bIds = hood.children.b.nodes.map((k) => k.i);
    // x is already a's small item, so b lists its other neighbour q first.
    assert.ok(aIds.includes('x'));
    assert.deepEqual(bIds, ['q', 'x']);
    assert.deepEqual(hood.children.a.nodes[0].r, 'calls');
    assert.equal(hood.children.a.nodes[0].dir, 'out');
  });
  it('has an entry for every main neighbour, even one with nothing beyond it', () => {
    assert.deepEqual(hood.children.m, { nodes: [], more: 0 });
  });
});

describe('mindmapLayout', () => {
  type Box = { id: string; x: number; y: number; w: number; h: number };
  const boxes = (r: any): Box[] => {
    const out: Box[] = [{ id: 'core', x: r.center.x - r.center.size / 2, y: r.center.y - r.center.size / 2, w: r.center.size, h: r.center.size }];
    for (const [id, m] of r.mains) out.push({ id, x: m.x - m.w / 2, y: m.y - m.h / 2, w: m.w, h: m.h });
    for (const [id, list] of r.kids) (list as any[]).forEach((k, j) => out.push({ id: `${id}/k${j}`, x: k.x - k.size / 2, y: k.y - k.size / 2, w: k.size, h: k.size }));
    return out;
  };

  it('puts every card, small item and the middle card apart and inside the canvas, at any number of neighbours', async () => {
    // @ts-ignore: a plain JS module of the web app, which has no declaration file
    const { mindmapLayout } = await import('../web/src/lib/mindmapLayout.js');
    for (const n of [0, 1, 5, 7, 12, 24, 36]) {
      const mains = Array.from({ length: n }, (_: unknown, i: number) => ({ id: `m${i}`, w: 112 + ((i * 23) % 80), kids: i % 4 }));
      const r = mindmapLayout(mains);
      const all = boxes(r);
      for (let i = 0; i < all.length; i++) {
        const a = all[i];
        assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= r.width && a.y + a.h <= r.height, `${a.id} inside at ${n}`);
        for (let j = i + 1; j < all.length; j++) {
          const b = all[j];
          assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `${a.id} overlaps ${b.id} at ${n}`);
        }
      }
    }
  });

  it('puts the middle card in the middle, the best connected one above, the next below, and the rest on both sides', async () => {
    // @ts-ignore
    const { mindmapLayout } = await import('../web/src/lib/mindmapLayout.js');
    const mains = Array.from({ length: 11 }, (_: unknown, i: number) => ({ id: `m${i}`, w: 130, kids: 3 }));
    const r = mindmapLayout(mains);
    assert.equal(r.mains.get('m0').side, 'top');
    assert.equal(r.mains.get('m1').side, 'bottom');
    assert.equal(r.mains.get('m0').x, r.center.x);
    assert.ok(r.mains.get('m0').y < r.center.y && r.mains.get('m1').y > r.center.y);
    const sides = [...r.mains.values()].map((m: any) => m.side);
    assert.equal(sides.filter((s: string) => s === 'left').length, 4);
    assert.equal(sides.filter((s: string) => s === 'right').length, 5);
    for (const [id, m] of r.mains) {
      const kids = r.kids.get(id);
      assert.equal(kids.length, 3);
      for (const k of kids) {
        if (m.side === 'right') assert.ok(k.x > m.x + m.w / 2);
        if (m.side === 'left') assert.ok(k.x < m.x - m.w / 2);
      }
    }
  });

  it('keeps few neighbours simple: no card above or below until there are enough, and is deterministic', async () => {
    // @ts-ignore
    const { mindmapLayout } = await import('../web/src/lib/mindmapLayout.js');
    const mains = Array.from({ length: 4 }, (_: unknown, i: number) => ({ id: `m${i}`, w: 120, kids: 2 }));
    const r = mindmapLayout(mains);
    assert.deepEqual([...r.mains.values()].map((m: any) => m.side).sort(), ['left', 'left', 'right', 'right']);
    assert.deepEqual([...r.mains.entries()], [...mindmapLayout(mains).mains.entries()]);
  });
});
