import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

// The portal's JSX dependencies do not ship TypeScript declarations.
const require = createRequire(import.meta.url);
const { createElement } = require('react') as { createElement: (component: unknown, props: object) => unknown };
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };

let tempDir: string;
let InboxItem: (props: { item: Record<string, unknown> }) => unknown;
before(async () => {
  tempDir = await mkdtemp(path.resolve('.inbox-ui-test-'));
  const outfile = path.join(tempDir, 'Inbox.mjs');
  await build({ entryPoints: ['web/src/pages/Inbox.jsx'], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic' });
  ({ InboxItem } = await import(pathToFileURL(outfile).href));
});
after(async () => { if (tempDir) await rm(tempDir, { recursive: true, force: true }); });

const base = { id: 'push1', project_id: 'p1', workflow_id: 'w1', created_at: new Date().toISOString() };
const render = (item: Record<string, unknown>) => renderToStaticMarkup(createElement(InboxItem, { item: { ...base, ...item } }));

describe('Inbox approval controls', () => {
  it('shows PR approval and decline buttons with the requested repository context', () => {
    const html = render({ type: 'push', payload: { title: 'Open a pull request for shop?', body: '5 files changed. Approve to push a new branch.' } });
    assert.match(html, />Approve and create pull request<\/button>/);
    assert.match(html, />Decline<\/button>/);
    assert.match(html, /Open a pull request for shop\?/);
    assert.match(html, /5 files changed/);
    assert.match(html, /href="#\/p\/p1\/sessions\/w1"/);
    assert.doesNotMatch(html, />Dismiss<\/button>/);
  });
  it('keeps tool approval and generic notification actions distinct', () => {
    const approval = render({ type: 'approval', payload: { toolName: 'Bash', toolInput: { command: 'git status' } } });
    assert.match(approval, />Approve<\/button>/);
    assert.match(approval, />Deny<\/button>/);
    assert.match(approval, /git status/);
    const generic = render({ type: 'blocked', payload: { message: 'Needs attention' } });
    assert.match(generic, />Dismiss<\/button>/);
    assert.doesNotMatch(generic, />Approve/);
  });
});
