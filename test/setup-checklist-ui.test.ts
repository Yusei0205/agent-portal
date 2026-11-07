/**
 * The "Get started" checklist: steps in order, finished ones marked, the next one is the primary action, steps that
 * need a project say so until there is one, and nothing shows once everything is done.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createElement } = require('react') as { createElement: (component: unknown, props: object) => unknown };
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };

let tempDir: string;
let View: (props: object) => unknown;
let showAgain: () => void;
before(async () => {
  tempDir = await mkdtemp(path.resolve('.setup-checklist-test-'));
  const outfile = path.join(tempDir, 'SetupChecklist.mjs');
  await build({ entryPoints: ['web/src/components/SetupChecklist.jsx'], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic' });
  ({ SetupChecklistView: View, showSetupChecklistAgain: showAgain } = await import(pathToFileURL(outfile).href));
});
after(async () => { if (tempDir) await rm(tempDir, { recursive: true, force: true }); });

const render = (project: object | null, state: Record<string, boolean>) => renderToStaticMarkup(createElement(View, { project, state, onNewProject: () => {}, onHide: () => {} }));
const none = { ai: false, project: false, git: false, repo: false, session: false };

describe('Get started checklist', () => {
  it('on a fresh install lists the five steps in order, with the first as the main action', () => {
    const html = render(null, none);
    const order = ['Sign in to an AI engine', 'Create a project', 'Connect your Git host', 'Add a repository', 'Start your first session'].map((t) => html.indexOf(t));
    assert.ok(order.every((i) => i >= 0) && [...order].sort((a, b) => a - b).join() === order.join(), 'all five, in order');
    assert.match(html, /0 of 5 done/);
    for (const [engine, label] of [['claude-code', 'Claude Code'], ['kiro', 'Kiro'], ['codex', 'Codex']]) {
      assert.match(html, new RegExp(`<a class="btn btn-sm btn-primary" href="#/config/sign-ins\\?engine=${engine}">${label}</a>`), `${label} can be chosen`);
    }
    assert.match(html, /Create a project first/, 'repository and session steps need a project');
  });

  it('marks finished steps, moves the main action on, and links the project steps', () => {
    const html = render({ id: 'p1' }, { ...none, ai: true, project: true });
    assert.match(html, /2 of 5 done/);
    assert.match(html, /Sign in to an AI engine \(done\)/);
    assert.match(html, /<a class="btn btn-sm btn-primary" href="#\/connect\/git">Connect<\/a>/);
    assert.match(html, /href="#\/p\/p1\/workspaces\/repositories"/);
    assert.doesNotMatch(html, /Create a project first/);
  });

  it('can be skipped, says where it comes back, and Help brings it back', () => {
    const html = render(null, none);
    assert.match(html, />Skip for now<\/button>/);
    assert.match(html, /href="#\/help\/getting-started"/);
    const store = new Map<string, string>([['setup-checklist-hidden', '1']]);
    (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    try {
      showAgain();
      assert.equal(store.has('setup-checklist-hidden'), false, 'the card shows again');
    } finally { delete (globalThis as any).localStorage; }
  });

  it('shows nothing once every step is done', () => {
    assert.equal(render({ id: 'p1' }, { ai: true, project: true, git: true, repo: true, session: true }), '');
  });
});
