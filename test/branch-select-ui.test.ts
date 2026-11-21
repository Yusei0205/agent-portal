import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { createElement } = require('react') as { createElement: (component: unknown, props: object) => unknown };
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };
let tempDir: string;
let BranchSelect: unknown;
before(async () => {
  tempDir = await mkdtemp(path.resolve('.branch-select-test-'));
  const outfile = path.join(tempDir, 'BranchSelect.mjs');
  await build({ entryPoints: ['web/src/components/BranchSelect.jsx'], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic' });
  ({ BranchSelect } = await import(pathToFileURL(outfile).href));
});
after(async () => { if (tempDir) await rm(tempDir, { recursive: true, force: true }); });
const render = (props: object) => renderToStaticMarkup(createElement(BranchSelect, { id: 'head', onChange: () => {}, ...props }));

describe('Code review branch selector', () => {
  it('shows selectable branches without a manual text field', () => {
    const html = render({ value: 'feature/login', branches: ['main', 'feature/login'] });
    assert.match(html, /<select id="head"/);
    assert.match(html, /value="main"/);
    assert.match(html, /value="feature\/login" selected=""/);
    assert.match(html, /Enter a ref instead/);
    assert.doesNotMatch(html, /<input/);
  });
  it('disables selection while branches are loading', () => {
    const html = render({ value: '', loading: true });
    assert.match(html, /disabled=""/);
    assert.match(html, /Loading branches/);
  });
  it('preserves an existing ref not in the fetched list and deduplicates branches', () => {
    const html = render({ value: 'release-tag', branches: ['main', 'main'] });
    assert.match(html, /value="release-tag" selected=""/);
    assert.equal((html.match(/value="main"/g) || []).length, 1);
  });
});
