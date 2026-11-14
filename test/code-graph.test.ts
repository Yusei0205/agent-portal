/**
 * Code graphs built once per repository (Repositories page), saved, and loaded by sessions instead of being built in each one.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { parseRunnerRepos } from '../server/agent/runner-repos.ts';
import { loadStoredGraph, gunzipToFile, GRAPH_DIR } from '../server/agent/runner-graph.ts';
import { buildAndStoreGraph, graphCounts } from '../server/agent/runner-graph-build.ts';

const GRAPH = { nodes: [{ id: 'a', label: 'a()', source_file: 'a.ts' }, { id: 'b', label: 'b()', source_file: 'b.ts' }], links: [{ source: 'a', target: 'b', relation: 'calls' }] };

function serve(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler).listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() });
    });
  });
}

/** A stand-in for the graphify command: writes graphify-out/graph.json in the folder it runs in (or fails). */
function fakeGraphify(dir: string, ok: boolean): string {
  const script = path.join(dir, 'fake-graphify.mjs');
  fs.writeFileSync(script, ok
    ? `import fs from 'node:fs'; fs.mkdirSync('graphify-out', { recursive: true }); fs.writeFileSync('graphify-out/graph.json', ${JSON.stringify(JSON.stringify(GRAPH))}); console.log('2 nodes, 1 edges');`
    : 'process.exit(3);');
  if (process.platform === 'win32') {
    const cmd = path.join(dir, `fake-graphify-${ok ? 'ok' : 'bad'}.cmd`);
    fs.writeFileSync(cmd, `@echo off\r\nnode "${script}" %*\r\n`);
    return cmd;
  }
  const sh = path.join(dir, `fake-graphify-${ok ? 'ok' : 'bad'}`);
  fs.writeFileSync(sh, `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });
  return sh;
}

function makeRepo(dir: string): string {
  const repo = path.join(dir, 'origin');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): void => { execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'ignore' }); };
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return repo;
}

describe('repo.graph in a runner payload', () => {
  const base = { name: 'r', url: 'https://example.com/r.git' };
  it('accepts a download link and a version', () => {
    const p = parseRunnerRepos([{ ...base, graph: { url: 'https://s3.example.com/g.gz?sig=1', version: '2026-11-13T07:00:00.000Z' } }]);
    assert.equal(p.ok, true);
    if (p.ok) assert.deepEqual(p.repos[0].graph, { url: 'https://s3.example.com/g.gz?sig=1', version: '2026-11-13T07:00:00.000Z' });
  });
  it('refuses a link that is not https, or has spaces, or a missing version', () => {
    assert.equal(parseRunnerRepos([{ ...base, graph: { url: 'http://x/g.gz', version: 'v' } }]).ok, false);
    assert.equal(parseRunnerRepos([{ ...base, graph: { url: 'https://x/g .gz', version: 'v' } }]).ok, false);
    assert.equal(parseRunnerRepos([{ ...base, graph: { url: 'https://x/g.gz' } }]).ok, false);
  });
});

describe('loadStoredGraph (a session loads the saved graph, builds nothing)', () => {
  let tmp: string;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-load-')); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('puts the graph in graphify-out, keeps it out of git, and does not download the same version twice', async () => {
    const repoDir = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    let hits = 0;
    const srv = await serve((_req, res) => { hits++; res.writeHead(200, { 'content-type': 'application/gzip' }); res.end(zlib.gzipSync(JSON.stringify(GRAPH))); });
    try {
      const said: string[] = [];
      await loadStoredGraph(repoDir, 'repo', { url: `${srv.url}/g.gz`, version: '2026-11-13T07:00:00.000Z' }, (e) => { if (e.type === 'status') said.push(e.text); });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repoDir, GRAPH_DIR, 'graph.json'), 'utf8')), GRAPH);
      assert.match(fs.readFileSync(path.join(repoDir, '.git', 'info', 'exclude'), 'utf8'), /graphify-out\//);
      assert.match(said.join('\n'), /Code graph of repo loaded \(built 2026-11-13, \d+ KB\)/);
      await loadStoredGraph(repoDir, 'repo', { url: `${srv.url}/g.gz`, version: '2026-11-13T07:00:00.000Z' }, () => undefined);
      assert.equal(hits, 1, 'the same version is not downloaded again');
      await loadStoredGraph(repoDir, 'repo', { url: `${srv.url}/g.gz`, version: '2026-11-14T07:00:00.000Z' }, () => undefined);
      assert.equal(hits, 2, 'a newer version is');
    } finally { srv.close(); }
  });

  it('says so and leaves the agent to read the code when the link fails or the file is not a graph', async () => {
    const repoDir = path.join(tmp, 'repo2');
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    const gone = await serve((_req, res) => { res.writeHead(403); res.end(); });
    const junk = await serve((_req, res) => { res.writeHead(200); res.end(zlib.gzipSync('not json')); });
    try {
      const said: string[] = [];
      await loadStoredGraph(repoDir, 'repo2', { url: `${gone.url}/g.gz`, version: 'v1' }, (e) => { if (e.type === 'status') said.push(e.text); });
      await loadStoredGraph(repoDir, 'repo2', { url: `${junk.url}/g.gz`, version: 'v2' }, (e) => { if (e.type === 'status') said.push(e.text); });
      assert.match(said[0], /could not be loaded \(HTTP 403\)/);
      assert.match(said[1], /is not readable/);
      assert.equal(fs.existsSync(path.join(repoDir, GRAPH_DIR, 'graph.json')), false);
    } finally { gone.close(); junk.close(); }
  });
});

describe('gunzipToFile (a big repository graph unpacks to hundreds of MB)', () => {
  it('writes the unpacked graph to a file and returns its size', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gunzip-'));
    try {
      const body = JSON.stringify({ nodes: Array.from({ length: 2000 }, (_, i) => ({ id: `n${i}` })), links: [] });
      const dest = path.join(tmp, 'graph.json');
      const size = await gunzipToFile(zlib.gzipSync(body), dest, 10 * 1024 * 1024);
      assert.equal(size, Buffer.byteLength(body));
      assert.equal(fs.readFileSync(dest, 'utf8'), body);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  it('refuses a graph over the size cap, and leaves no partial file', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gunzip-'));
    try {
      const dest = path.join(tmp, 'graph.json');
      await assert.rejects(gunzipToFile(zlib.gzipSync('{"a":"' + 'x'.repeat(100_000) + '"}'), dest, 1000), /unpacks to more than/);
      assert.equal(fs.existsSync(dest), false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('buildAndStoreGraph (the Build code graph job on the runner)', { skip: process.platform === 'win32' ? 'the fake graphify is a shell script' : false }, () => {
  let tmp: string;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-build-test-')); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('counts nodes and links whichever name graphify gives them', () => {
    assert.deepEqual(graphCounts(GRAPH), { nodes: 2, links: 1 });
    assert.deepEqual(graphCounts({ nodes: [1], edges: [1, 2, 3] }), { nodes: 1, links: 3 });
    assert.deepEqual(graphCounts(null), { nodes: 0, links: 0 });
  });

  it('clones the latest commit, builds the graph and saves it gzipped to the given link', async () => {
    const origin = makeRepo(tmp);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: origin }).toString().trim();
    let body: Buffer = Buffer.alloc(0);
    const store = await serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => { body = Buffer.concat(chunks); res.writeHead(200); res.end(); });
    });
    try {
      const r = await buildAndStoreGraph({ name: 'origin', url: origin }, () => undefined, { putUrl: `${store.url}/put`, maxMs: 60_000, bin: fakeGraphify(tmp, true) });
      assert.equal(r.success, true, String(r.error));
      assert.equal(r.stored, true);
      assert.equal(r.commit, head);
      assert.equal(r.nodes, 2);
      assert.equal(r.links, 1);
      assert.deepEqual(JSON.parse(zlib.gunzipSync(body).toString('utf8')), GRAPH);
    } finally { store.close(); }
  });

  it('keeps a graph that could not be saved for the Code map and says so', async () => {
    const origin = makeRepo(path.join(tmp, 'two'));
    const store = await serve((_req, res) => { res.writeHead(403); res.end(); });
    try {
      const r = await buildAndStoreGraph({ name: 'origin', url: origin }, () => undefined, { putUrl: `${store.url}/put`, maxMs: 60_000, bin: fakeGraphify(tmp, true) });
      assert.equal(r.success, true);
      assert.equal(r.stored, false);
      assert.match(String(r.error), /could not be saved \(HTTP 403\)/);
    } finally { store.close(); }
  });

  it('fails with a reason when graphify fails or is missing', async () => {
    const origin = makeRepo(path.join(tmp, 'three'));
    const bad = await buildAndStoreGraph({ name: 'origin', url: origin }, () => undefined, { maxMs: 60_000, bin: fakeGraphify(tmp, false) });
    assert.equal(bad.success, false);
    assert.match(String(bad.error), /did not finish/);
    const none = await buildAndStoreGraph({ name: 'origin', url: origin }, () => undefined, { maxMs: 60_000, bin: null });
    assert.equal(none.success, false);
    assert.match(String(none.error), /not installed/);
  });
});
