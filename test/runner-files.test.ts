/**
 * Files an agent writes in an AgentCore microVM come back to the portal: collect -> chunked events -> receiver.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  collectRunnerFiles, collectRepoDocuments, emitRunnerFiles, createFileReceiver, safeRelPath, RUNNER_FILE_LIMITS,
} from '../server/agent/runner-files.ts';
import { _setAgentCoreInvokerOverride } from '../server/agent/kiro-agentcore.ts';
import type { AgentCoreSSEEvent } from '../server/agent/kiro-agentcore.ts';
import { runClaudeViaAgentCore } from '../server/agent/claude-agentcore.ts';
import type { RunContext } from '../server/agent/types.ts';

let src = '';
let dst = '';
beforeEach(() => {
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-src-'));
  dst = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-dst-'));
});
afterEach(() => {
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(dst, { recursive: true, force: true });
  _setAgentCoreInvokerOverride(null);
});

const write = (rel: string, data: string | Buffer) => {
  const abs = path.join(src, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
};

describe('collectRunnerFiles', () => {
  it('keeps allowed types, skips tool folders, empty files and unwanted extensions', () => {
    write('report.md', '# hi');
    write('docs/diagram.drawio', '<mxfile/>');
    write('.claude/notes.md', 'x');
    write('.agent-notes/lead-orchestrator.md', 'x');
    write('repos/app/README.md', 'x');
    write('node_modules/p/readme.md', 'x');
    write('app.exe', 'MZ');
    write('empty.md', '');
    const { files } = collectRunnerFiles(src);
    assert.deepEqual(files.map((f) => f.rel).sort(), ['docs/diagram.drawio', 'report.md']);
  });

  it('sends source files from the work folder, but not lock files, build output, dotfiles or repositories', () => {
    write('DelayedShipments.tsx', 'export {}');
    write('src/util.py', 'x = 1');
    write('setup.sh', 'echo');
    write('package-lock.json', '{}');
    write('dist/bundle.js', 'x');
    write('.eslintrc.json', '{}');
    write('repos/app/src/index.ts', 'x');
    write('node_modules/p/index.js', 'x');
    const { files } = collectRunnerFiles(src);
    assert.deepEqual(files.map((f) => f.rel).sort(), ['DelayedShipments.tsx', 'setup.sh', 'src/util.py']);
  });

  it('the receiver accepts a source file path and still refuses one inside repos/ or dist/', () => {
    assert.equal(safeRelPath('DelayedShipments.tsx'), 'DelayedShipments.tsx');
    assert.equal(safeRelPath('repos/app/index.ts'), null);
    assert.equal(safeRelPath('dist/bundle.js'), null);
    assert.equal(safeRelPath('package-lock.json'), null);
  });

  it('only returns files changed since the given time', () => {
    write('old.md', 'old');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(src, 'old.md'), past, past);
    write('new.md', 'new');
    const { files } = collectRunnerFiles(src, Date.now() - 30_000);
    assert.deepEqual(files.map((f) => f.rel), ['new.md']);
  });

  it('enforces the file-count limit and counts what it skipped', () => {
    for (let i = 0; i < RUNNER_FILE_LIMITS.files + 5; i++) write(`f${i}.md`, 'x');
    const { files, skipped } = collectRunnerFiles(src);
    assert.equal(files.length, RUNNER_FILE_LIMITS.files);
    assert.equal(skipped, 5);
  });
});

describe('round trip', () => {
  it('delivers text and multi-chunk binary files byte for byte', async () => {
    const big = Buffer.alloc(RUNNER_FILE_LIMITS.chunkBytes * 2 + 123, 7);
    write('out/big.pdf', big);
    write('notes.md', 'hello');
    const events: Array<Record<string, unknown>> = [];
    const sent = emitRunnerFiles(src, (e) => events.push(e));
    assert.equal(sent, 2);
    assert.ok(events.filter((e) => e.type === 'file' && e.path === 'out/big.pdf').length === 3, 'big file in 3 chunks');

    const written: string[] = [];
    const rx = createFileReceiver(dst, async (abs) => { written.push(abs); });
    for (const e of events) await rx.handle(e);
    assert.deepEqual(rx.received.sort(), ['notes.md', 'out/big.pdf']);
    assert.ok(fs.readFileSync(path.join(dst, 'out', 'big.pdf')).equals(big));
    assert.equal(fs.readFileSync(path.join(dst, 'notes.md'), 'utf8'), 'hello');
    assert.equal(written.length, 2);
  });
});

describe('receiver safety', () => {
  const chunk = (over: Record<string, unknown> = {}) => ({ type: 'file', path: 'a.md', size: 3, index: 0, count: 1, data: Buffer.from('abc').toString('base64'), ...over });

  it('rejects traversal, absolute paths, tool folders and disallowed extensions', async () => {
    const rx = createFileReceiver(dst);
    for (const p of ['../evil.md', 'a/../../evil.md', '/etc/passwd.md', 'C:/x.md', 'a' + String.fromCharCode(92) + 'b.md', '.git/x.md', 'repos/y.md', 'repos/x/y.ts', 'repos/x/node_modules/y.md', 'repos/x/.github/y.md', 'repos/x/dist/y.md', 'repos/.git/y.md', 'run.bat', 'x.exe', '']) {
      await rx.handle(chunk({ path: p }));
    }
    assert.equal(rx.received.length, 0);
    assert.equal(rx.rejected, 15);
    assert.deepEqual(fs.readdirSync(dst), []);
  });

  it('rejects a size mismatch, out-of-order chunks and oversize announcements', async () => {
    const rx = createFileReceiver(dst);
    await rx.handle(chunk({ size: 99 }));                       // announced 99, got 3
    await rx.handle(chunk({ path: 'b.md', count: 2, index: 1 })); // starts at chunk 1
    await rx.handle(chunk({ path: 'c.md', size: RUNNER_FILE_LIMITS.fileBytes + 1 }));
    assert.equal(rx.received.length, 0);
    assert.equal(rx.rejected, 3);
  });

  it('safeRelPath normalises good paths', () => {
    assert.equal(safeRelPath('docs/./a.md'), 'docs/a.md');
    assert.equal(safeRelPath('docs/../a.md'), null);
  });
});

describe('Claude adapter receives files into the run work folder', () => {
  it('writes them and reports the count', async () => {
    write('result.md', '# done');
    const events: Array<Record<string, unknown>> = [];
    emitRunnerFiles(src, (e) => events.push(e));
    _setAgentCoreInvokerOverride(async function* () {
      for (const e of events) yield e as unknown as AgentCoreSSEEvent;
      yield { type: 'result', stop_reason: 'end_turn', metrics: {} } as unknown as AgentCoreSSEEvent;
    });
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx = {
      run: { workDir: dst },
      emit: (type: string, payload: object) => { emitted.push({ type, payload: payload as Record<string, unknown> }); },
      awaitInput: async () => ({ decision: 'allow', remember: false, message: '' }),
      allowed: new Set<string>(), signal: null,
    } as unknown as RunContext;
    await runClaudeViaAgentCore(ctx, {
      runtimeArn: 'arn:x', runId: 'r', prompt: 'p', model: 'm', auth: { kind: 'api_key', secret: 's' }, trustTools: true,
    });
    assert.equal(fs.readFileSync(path.join(dst, 'result.md'), 'utf8'), '# done');
    assert.ok(emitted.some((e) => e.type === 'status' && /Received 1 file/.test(String(e.payload.text))));
  });
});

describe('documents written inside a cloned repository', () => {
  const run = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  const mkRepo = () => {
    const repo = path.join(src, 'repos', 'app');
    fs.mkdirSync(repo, { recursive: true });
    run(['init', '-q'], repo);
    run(['config', 'user.email', 't@t.t'], repo); run(['config', 'user.name', 't'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'old');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export {}');
    run(['add', '.'], repo); run(['commit', '-q', '-m', 'init'], repo);
    return repo;
  };

  it('sends new and changed documents, not source files, untouched files or tool folders', () => {
    const repo = mkRepo();
    fs.mkdirSync(path.join(repo, 'supporting_files', 'technical_doc'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'supporting_files', 'technical_doc', 'Guide.md'), '# guide');
    fs.writeFileSync(path.join(repo, 'README.md'), 'changed');
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const x = 1;');
    fs.mkdirSync(path.join(repo, 'node_modules', 'p'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'p', 'r.md'), 'x');
    const rels = collectRepoDocuments(src).map((f) => f.rel).sort();
    assert.deepEqual(rels, ['repos/app/README.md', 'repos/app/supporting_files/technical_doc/Guide.md']);
    assert.deepEqual(collectRunnerFiles(src).files.map((f) => f.rel).sort(), rels);
  });

  it('ignores a repos/ folder that is not a git repository, and files older than the run', () => {
    write('repos/plain/NOTES.md', 'x');
    assert.deepEqual(collectRepoDocuments(src), []);
    const repo = mkRepo();
    fs.writeFileSync(path.join(repo, 'Doc.md'), 'x');
    assert.deepEqual(collectRepoDocuments(src, Date.now() + 60_000), []);
  });

  it('arrives at the portal under repos/<name>/ and the receiver still refuses source files and tool folders there', async () => {
    const repo = mkRepo();
    fs.writeFileSync(path.join(repo, 'Guide.md'), '# guide');
    const rx = createFileReceiver(dst);
    emitRunnerFiles(src, (ev) => { void rx.handle(ev); });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(rx.received, ['repos/app/Guide.md']);
    assert.equal(fs.readFileSync(path.join(dst, 'repos', 'app', 'Guide.md'), 'utf8'), '# guide');
    assert.equal(safeRelPath('repos/app/src/a.ts'), null);
  });
});

describe('portal side listing of repository documents', () => {
  it('lists the documents a cloud runner sent for a repository, and nothing hidden or in tool folders', async () => {
    const { collectReceivedRepoDocs } = await import('../server/output-files.ts');
    write('repos/app/docs/Guide.md', '# g');
    write('repos/app/diagram.drawio', '<mxfile/>');
    write('repos/app/main.ts', 'x');
    write('repos/app/.hidden/n.md', 'x');
    write('repos/app/node_modules/p/r.md', 'x');
    const rels = collectReceivedRepoDocs(path.join(src, 'repos', 'app')).map((f) => path.relative(src, f).split(path.sep).join('/')).sort();
    assert.deepEqual(rels, ['repos/app/diagram.drawio', 'repos/app/docs/Guide.md']);
  });
});
