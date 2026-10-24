import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bootServer, Client, waitFor, type TestServer, startSingleRun, startSingleRunReq } from './client.ts';
import { composeDocumentPrompt } from '../server/docrun.ts';

let srv: TestServer;
let admin: Client;
let pid: string;
let slug: string;
let repoId: string;
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrun-repo-'));

before(async () => {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repoDir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repoDir, 'app.py'), 'def handler(event, context):\n    return {"ok": True}\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  srv = await bootServer();
  admin = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'a@example.com', name: 'Ann', password: 'a-long-password-1' });
  const { project } = await admin.post('/api/projects', { name: 'Docs', description: 'd' });
  pid = project.id;
  slug = project.slug;
  const { repo } = await admin.post(`/api/projects/${pid}/repos`, { localPath: repoDir, name: 'payments' });
  repoId = repo.id;
  await waitFor(async () => ((await admin.get(`/api/projects/${pid}/repos`)).repos.find((r: any) => r.id === repoId).status === 'ready' ? true : null), 'clone');
});

after(async () => {
  await srv.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
});

test('the prompt names the repo path, the focus, the deliverable and the safety rules', () => {
  const p = composeDocumentPrompt({ name: 'payments', slug: 'payments', default_branch: 'main' }, { scope: 'the handlers', output: 'markdown-word' });
  assert.match(p, /repos\/payments\//);
  assert.match(p, /document-code skill/);
  assert.match(p, /Focus on: the handlers/);
  assert.match(p, /Markdown files.*Word document/s);
  assert.match(p, /Never copy secrets/);
  assert.match(composeDocumentPrompt({ name: 'x', slug: 'x', default_branch: 'main' }, { output: 'slides' }), /Cover the whole repository.*PowerPoint/s);
});

test('both documentation skills are installed in the project', () => {
  const dir = path.join(srv.dataDir, 'projects', slug, '.claude/skills');
  for (const name of ['make-documents', 'document-code']) {
    const text = fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\nname: ${name}\n`));
  }
  assert.match(fs.readFileSync(path.join(dir, 'document-code/SKILL.md'), 'utf8'), /file:line|path\/to\/file\.ext:line/);
});

test('a documentation run reads the repo in place: no working copy, right title and prompt', async () => {
  const { run } = await startSingleRun(admin, pid, {
    document: { repoId, scope: 'the Lambda handler', output: 'word' },
    model: 'sonnet',
    permissionMode: 'acceptEdits',
  });
  assert.equal(run.title, 'Document payments');
  const done = await waitFor(async () => {
    const r = await admin.get(`/api/runs/${run.id}`);
    return ['completed', 'failed', 'stopped'].includes(r.run.status) ? r : null;
  }, 'run');
  assert.equal(done.run.status, 'completed');
  assert.equal(done.run.repo_id ?? null, null, 'no working copy, so writes are not confined to the repo');
  assert.equal(done.run.worktree ?? null, null);
  assert.match(done.run.prompt, /repos\/payments\//);
  assert.match(done.run.prompt, /Focus on: the Lambda handler/);
  assert.match(done.run.prompt, /Word document/);
});

test('bad requests are refused with a clear reason', async () => {
  const bad = async (document: any, status: number, re: RegExp) => {
    const r = await startSingleRunReq(admin, pid, { document });
    assert.equal(r.status, status, JSON.stringify(r.data));
    assert.match(r.data.error, re);
  };
  await bad({ repoId, output: 'pdf' }, 400, /Output must be/);
  await bad({ repoId: 'g_nope' }, 404, /not found/i);
  await bad({}, 404, /not found/i);
});
