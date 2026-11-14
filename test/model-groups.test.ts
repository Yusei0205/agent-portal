/**
 * Model pickers group the models by family (Claude first, newest first inside it) instead of the order AWS returned.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
// @ts-expect-error — plain JS modules without type declarations
import { groupModelsByFamily, modelFamily } from '../web/src/lib/model-groups.js';

const require = createRequire(import.meta.url);
const { createElement } = require('react') as { createElement: (component: unknown, props?: object | null, ...children: unknown[]) => unknown };
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };
let tempDir: string;
let ModelOptions: unknown;
before(async () => {
  tempDir = await mkdtemp(path.resolve('.model-options-test-'));
  const outfile = path.join(tempDir, 'ModelOptions.mjs');
  await build({ entryPoints: ['web/src/components/ModelOptions.jsx'], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic' });
  ({ default: ModelOptions } = await import(pathToFileURL(outfile).href));
});
after(async () => { if (tempDir) await rm(tempDir, { recursive: true, force: true }); });

const m = (id: string, label: string) => ({ id, label });
// The mixed order from the account in the screenshot.
const MIXED = [
  m('us.anthropic.claude-3-sonnet', 'US Anthropic Claude 3 Sonnet'),
  m('us.meta.llama3-2-11b', 'US Meta Llama 3.2 11B Instruct'),
  m('us.anthropic.claude-3-haiku', 'US Anthropic Claude 3 Haiku'),
  m('us.deepseek.r1', 'US DeepSeek-R1'),
  m('us.stability.conservative-upscale', 'US Stable Image Conservative Upscale'),
  m('us.meta.llama3-2-3b', 'US Meta Llama 3.2 3B Instruct'),
  m('us.anthropic.claude-sonnet-4-5', 'US Anthropic Claude Sonnet 4.5'),
  m('us.twelvelabs.marengo', 'US TwelveLabs Marengo Embed v2.7'),
  m('us.amazon.nova-premier', 'US Nova Premier'),
  m('us.anthropic.claude-opus-4-1', 'US Anthropic Claude Opus 4.1'),
  m('us.mistral.pixtral', 'US Mistral Pixtral Large 25.02'),
  m('us.twelvelabs.pegasus', 'US Pegasus v1.2'),
  m('something.else', 'Mystery model'),
];

describe('model families', () => {
  it('recognises the families on the list', () => {
    const fam = Object.fromEntries(MIXED.map((x) => [x.label, modelFamily(x)]));
    assert.equal(fam['US Anthropic Claude 3 Haiku'], 'Anthropic Claude');
    assert.equal(fam['US Meta Llama 3.2 3B Instruct'], 'Meta Llama');
    assert.equal(fam['US Nova Premier'], 'Amazon Nova & Titan');
    assert.equal(fam['US Pegasus v1.2'], 'TwelveLabs');
    assert.equal(fam['US TwelveLabs Marengo Embed v2.7'], 'TwelveLabs');
    assert.equal(fam['US Stable Image Conservative Upscale'], 'Stability AI');
    assert.equal(fam['Mystery model'], 'Other models');
  });

  it('puts Claude first, other makers in a fixed order, and unknown models last', () => {
    const names = groupModelsByFamily(MIXED).map((g: { name: string }) => g.name);
    assert.deepEqual(names, ['Anthropic Claude', 'Amazon Nova & Titan', 'Meta Llama', 'Mistral', 'DeepSeek', 'TwelveLabs', 'Stability AI', 'Other models']);
  });

  it('sorts Claude Opus, Sonnet, Haiku with the newest version first, and Llama smallest first', () => {
    const groups = groupModelsByFamily(MIXED);
    assert.deepEqual(groups[0].models.map((x: { label: string }) => x.label), [
      'US Anthropic Claude Opus 4.1', 'US Anthropic Claude Sonnet 4.5', 'US Anthropic Claude 3 Sonnet', 'US Anthropic Claude 3 Haiku',
    ]);
    const llama = groups.find((g: { name: string }) => g.name === 'Meta Llama').models.map((x: { id: string }) => x.id);
    assert.deepEqual(llama, ['us.meta.llama3-2-3b', 'us.meta.llama3-2-11b']);
  });
});

describe('ModelOptions', () => {
  it('groups with optgroups when there are several families, and stays flat for one', () => {
    const many = renderToStaticMarkup(createElement('select', null, createElement(ModelOptions, { models: MIXED })));
    assert.match(many, /<optgroup label="Anthropic Claude">/);
    assert.match(many, /<optgroup label="Meta Llama">/);
    const one = renderToStaticMarkup(createElement('select', null, createElement(ModelOptions, { models: [m('claude-opus-4', 'Opus 4'), m('claude-sonnet-4', 'Sonnet 4')] })));
    assert.doesNotMatch(one, /optgroup/);
    assert.equal(renderToStaticMarkup(createElement('select', null, createElement(ModelOptions, { models: [] }))), '<select></select>');
  });
});
