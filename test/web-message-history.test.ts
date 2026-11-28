/// <reference lib="dom" />
/**
 * Up and Down in the chat box bring back the messages sent before, like a terminal (Kiro, Claude Code, Codex).
 * The rules are tested on their own, then the real composer is driven with key presses.
 */
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
// @ts-expect-error — plain JS module without type declarations
import { addToHistory, idleHistory, stepHistory } from '../web/src/lib/messageHistory.js';

describe('message history rules', () => {
  const list = ['one', 'two', 'three'];
  const at = (value: string, pos = value.length) => ({ value, selStart: pos, selEnd: pos });

  it('keeps what was sent, once in a row, and no more than the limit', () => {
    assert.deepEqual(addToHistory([], '  hello  '), ['hello']);
    assert.deepEqual(addToHistory(['a'], 'a'), ['a']);
    assert.deepEqual(addToHistory(['a'], '   '), ['a']);
    assert.equal(addToHistory(Array.from({ length: 100 }, (_, i) => `m${i}`), 'new').length, 100);
  });

  it('Up goes back one message at a time and stops at the oldest', () => {
    let state = idleHistory(list);
    const seen: string[] = [];
    let value = '';
    for (let i = 0; i < 5; i++) {
      const r = stepHistory(list, state, 'ArrowUp', at(value));
      assert.ok(r);
      state = r.state; value = r.value; seen.push(value);
    }
    assert.deepEqual(seen, ['three', 'two', 'one', 'one', 'one']);
  });

  it('Down comes forward and ends on what was being typed', () => {
    let r = stepHistory(list, idleHistory(list), 'ArrowUp', at('my draft'))!;
    r = stepHistory(list, r.state, 'ArrowUp', at(r.value))!;
    assert.equal(r.value, 'two');
    r = stepHistory(list, r.state, 'ArrowDown', at(r.value))!;
    assert.equal(r.value, 'three');
    r = stepHistory(list, r.state, 'ArrowDown', at(r.value))!;
    assert.equal(r.value, 'my draft');
    assert.equal(stepHistory(list, r.state, 'ArrowDown', at(r.value)), null, 'nothing further to come forward to');
  });

  it('leaves the arrows to the box when they move inside a message or a selection', () => {
    assert.equal(stepHistory(list, idleHistory(list), 'ArrowUp', at('a\nb')), null, 'caret on the second line');
    assert.equal(stepHistory(list, idleHistory(list), 'ArrowUp', { value: 'abc', selStart: 0, selEnd: 3 }), null, 'a selection');
    assert.equal(stepHistory([], idleHistory([]), 'ArrowUp', at('')), null, 'no history');
    const browsing = stepHistory(list, idleHistory(list), 'ArrowUp', at(''))!;
    assert.equal(stepHistory(list, { ...browsing.state, index: 0 }, 'ArrowDown', at('x\ny', 0)), null, 'caret not on the last line');
  });
});

describe('the composer arrow keys', () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require('jsdom');
  const { createElement, act } = require('react');
  let tempDir = '';
  let ComposerBar: unknown;
  let dom: InstanceType<typeof JSDOM>;
  let root: { render: (e: unknown) => void; unmount: () => void };
  const previousFetch = globalThis.fetch;
  const sent: string[] = [];
  const memoryWrites: Array<{ path: string; content: string }> = [];
  const shellRuns: string[] = [];

  before(async () => {
    dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      let body: unknown = { commands: [] };
      if (u.includes('/api/user-config/claude/file')) { if (init?.method === 'PUT') memoryWrites.push(JSON.parse(String(init.body))); body = { content: '# Guide\n' }; }
      else if (u.includes('/api/user-config/agents')) body = { agents: [{ name: 'lead-orchestrator', description: 'Runs the team' }, { name: 'reviewer' }] };
      else if (u.includes('/ide/tree')) {
        body = u.includes('path=src') ? { entries: [{ name: 'app.ts', path: 'src/app.ts', type: 'file' }] }
          : { entries: [{ name: 'src', path: 'src', type: 'directory' }, { name: 'README.md', path: 'README.md', type: 'file' }] };
      } else if (u.endsWith('/message-history')) body = { messages: ['first question', 'second question'] };
      else if (u.endsWith('/message')) { sent.push(JSON.parse(String(init?.body)).message); body = { ok: true, resumed: true }; }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    };
    tempDir = await mkdtemp(path.resolve('.message-history-test-'));
    const outfile = path.join(tempDir, 'Composer.mjs');
    await build({
      stdin: { contents: "export { ComposerBar } from './web/src/pages/sessions/IdeWorkspace.jsx';", resolveDir: process.cwd(), loader: 'jsx' },
      outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic',
      plugins: [{ name: 'stubs', setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'style' }));
        b.onLoad({ filter: /.*/, namespace: 'style' }, () => ({ contents: '', loader: 'js' }));
        b.onResolve({ filter: /^dcv(?:-ui)?$/ }, (a) => ({ path: a.path, namespace: 'viewer' }));
        b.onLoad({ filter: /.*/, namespace: 'viewer' }, () => ({ contents: 'export default {}; export const DCVViewer = () => null;', loader: 'js' }));
      } }],
    });
    ComposerBar = (await import(pathToFileURL(outfile).href)).ComposerBar;
    const { createRoot } = require('react-dom/client');
    root = createRoot(dom.window.document.getElementById('root'));
  });
  after(async () => {
    if (root) await act(async () => root.unmount());
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    dom?.window.close();
    globalThis.fetch = previousFetch;
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });

  const box = () => dom.window.document.querySelector('textarea') as HTMLTextAreaElement;
  const press = async (key: string, mods: { ctrlKey?: boolean; altKey?: boolean } = {}) => {
    const e = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
    await act(async () => { box().dispatchEvent(e); });
    return e.defaultPrevented;
  };
  const type = async (text: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(box(), text); box().dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    box().setSelectionRange(text.length, text.length);
  };

  it('Up recalls earlier messages, Down returns to the draft, and a sent message joins the list', async () => {
    await act(async () => root.render(createElement(ComposerBar, { projectId: 'p1', workflow: { id: 'w1', status: 'paused', engine: 'demo', repo_ids: [] } })));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    await type('half typed');
    assert.equal(await press('ArrowUp'), true);
    assert.equal(box().value, 'second question');
    await press('ArrowUp');
    assert.equal(box().value, 'first question');
    await press('ArrowDown');
    assert.equal(box().value, 'second question');
    await press('ArrowDown');
    assert.equal(box().value, 'half typed', 'back to what was being typed');

    await type('a third one');
    await press('Enter');
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    assert.deepEqual(sent, ['a third one']);
    assert.equal(box().value, '');
    await press('ArrowUp');
    assert.equal(box().value, 'a third one', 'the message just sent is the first one recalled');
  });

  it('leaves Up alone inside a message of several lines', async () => {
    await type('line one\nline two');
    assert.equal(await press('ArrowUp'), false);
    assert.equal(box().value, 'line one\nline two');
  });

  it('Ctrl+R searches earlier messages and Enter puts the pick in the box without sending', async () => {
    await type('');
    sent.length = 0;
    assert.equal(await press('r', { ctrlKey: true }), true);
    await type('first');
    assert.ok(dom.window.document.querySelector('[aria-label="Earlier messages"]'), 'the results list is open');
    await press('Enter');
    assert.equal(box().value, 'first question');
    assert.deepEqual(sent, [], 'picking is not sending');
    assert.equal(dom.window.document.querySelector('[aria-label="Earlier messages"]'), null);
  });

  it('a backslash before Enter makes a new line instead of sending', async () => {
    await type('step one\\');
    assert.equal(await press('Enter'), true);
    assert.equal(box().value, 'step one\n');
    assert.deepEqual(sent, []);
  });

  it('Ctrl+U clears the line', async () => {
    await type('some words');
    await press('u', { ctrlKey: true });
    assert.equal(box().value, '');
  });

  it('@ lists the working copy, a folder opens the next level, a file ends the mention', async () => {
    await type('look at @');
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const labels = () => [...dom.window.document.querySelectorAll('[aria-label="Files"] li')].map((li) => li.querySelector('code')!.textContent);
    assert.deepEqual(labels(), ['src/', 'README.md']);
    await press('Enter');
    assert.equal(box().value, 'look at @src/', 'a folder keeps the mention open');
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    assert.deepEqual(labels(), ['app.ts']);
    await press('Tab');
    assert.equal(box().value, 'look at @src/app.ts ');
    assert.deepEqual(sent, [], 'picking a file does not send the message');
  });

  it('Alt+M asks for a second press before trusting all tools, then sends /tools trust', async () => {
    await type('');
    sent.length = 0;
    await press('m', { altKey: true });
    assert.deepEqual(sent, [], 'the first press only arms it');
    assert.match(dom.window.document.querySelector('.ws-mode:not(.ws-mode-plan)')!.textContent!, /press again/);
    await press('m', { altKey: true });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    assert.deepEqual(sent, ['/tools trust']);
  });

  it('the agent dropdown lists the choices and a pick sends /agent on its own, leaving the draft alone', async () => {
    const wf = { id: 'w1', status: 'paused', engine: 'codex', model: '', repo_ids: [] };
    await act(async () => root.render(createElement(ComposerBar, { projectId: 'p1', workflow: wf })));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    await type('my draft');
    sent.length = 0;
    const chip = [...dom.window.document.querySelectorAll('.ws-chip')].find((b) => /agent/.test(b.textContent!)) as HTMLButtonElement;
    await act(async () => { chip.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const options = [...dom.window.document.querySelectorAll('[aria-label="agent"] li')].map((li) => li.querySelector('code')?.textContent);
    assert.deepEqual(options, ['● default', 'lead-orchestrator', 'reviewer']);
    await act(async () => { (dom.window.document.querySelectorAll('[aria-label="agent"] li')[1] as HTMLElement).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    assert.deepEqual(sent, ['/agent lead-orchestrator']);
    assert.equal(box().value, 'my draft', 'the draft is not touched');
  });

  it('while a turn runs the send button becomes Stop, and typing brings Send back', async () => {
    const wf = { id: 'w1', status: 'running', engine: 'codex', repo_ids: [] };
    await act(async () => root.render(createElement(ComposerBar, { projectId: 'p1', workflow: wf })));
    await type('');
    const doc = dom.window.document;
    assert.ok(doc.querySelector('.ws-stop-btn'), 'Stop is shown with an empty box');
    assert.equal(box().placeholder, 'Queue a follow-up for when this turn ends…');
    assert.ok([...doc.querySelectorAll('.ws-chip')].every((b) => (b as HTMLButtonElement).disabled), 'the agent cannot change mid-turn');
    await type('one more thing');
    assert.equal(doc.querySelector('.ws-stop-btn'), null, 'Send replaces Stop once there is text');
  });

  it('the / button opens the command menu by putting a slash in the box', async () => {
    const wf = { id: 'w1', status: 'paused', engine: 'demo', repo_ids: [] };
    await act(async () => root.render(createElement(ComposerBar, { projectId: 'p1', workflow: wf })));
    await type('');
    await act(async () => { (dom.window.document.querySelector('.ws-slash-btn') as HTMLElement).click(); });
    assert.equal(box().value, '/');
  });

  it('after a finished turn, follow-up chips fill the box without sending', async () => {
    const wf = { id: 'w1', status: 'done', stop_reason: 'awaiting_message', engine: 'demo', repo_ids: [] };
    await act(async () => root.render(createElement(ComposerBar, { projectId: 'p1', workflow: wf })));
    await type('');
    sent.length = 0;
    const chips = [...dom.window.document.querySelectorAll('.ws-suggest-chip')];
    assert.ok(chips.length >= 3, 'suggestions are shown');
    await act(async () => { (chips.find((c) => /Review/.test(c.textContent!)) as HTMLElement).click(); });
    assert.equal(box().value, '/review');
    assert.deepEqual(sent, [], 'nothing is sent');
    assert.equal(dom.window.document.querySelector('.ws-suggest'), null, 'the chips go away once there is text');
  });

  it('"!command" goes to the terminal and not to the agent', async () => {
    const wf = { id: 'w1', status: 'paused', engine: 'claude-code', repo_ids: [] };
    await act(async () => root.render(createElement(ComposerBar, { projectId: 'p1', workflow: wf, onShellCommand: (c: string) => shellRuns.push(c) })));
    await type('!git status');
    assert.match(dom.window.document.body.textContent!, /runs this in the session terminal/);
    sent.length = 0;
    await press('Enter');
    assert.deepEqual(shellRuns, ['git status']);
    assert.deepEqual(sent, []);
    assert.equal(box().value, '');
  });

  it('"#note" is appended to CLAUDE.md for Claude Code, while "# heading" is an ordinary message', async () => {
    const wf = { id: 'w1', status: 'paused', engine: 'claude-code', repo_ids: [] };
    await act(async () => root.render(createElement(ComposerBar, { projectId: 'p1', workflow: wf })));
    await type('#always use pnpm');
    sent.length = 0;
    await press('Enter');
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    assert.deepEqual(memoryWrites, [{ path: 'CLAUDE.md', content: '# Guide\n- always use pnpm\n' }]);
    assert.deepEqual(sent, [], 'a note is not sent to the agent');
    assert.match(dom.window.document.body.textContent!, /Saved to your CLAUDE\.md/);
    await type('# A heading');
    await press('Enter');
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    assert.deepEqual(sent, ['# A heading']);
    assert.equal(memoryWrites.length, 1);
  });

  it('"#note" on another engine explains instead of saving', async () => {
    const wf = { id: 'w1', status: 'paused', engine: 'codex', repo_ids: [] };
    await act(async () => root.render(createElement(ComposerBar, { projectId: 'p1', workflow: wf })));
    await type('#note');
    memoryWrites.length = 0;
    await press('Enter');
    assert.equal(memoryWrites.length, 0);
    assert.match(dom.window.document.body.textContent!, /Claude Code sessions only/);
  });

  it('the plan chip and Alt+P switch plan mode with /plan, and plan mode shows in the box', async () => {
    const off = { id: 'w1', status: 'paused', engine: 'claude-code', plan_mode: false, repo_ids: [] };
    await act(async () => root.render(createElement(ComposerBar, { projectId: 'p1', workflow: off })));
    await type('my draft');
    sent.length = 0;
    const chip = () => dom.window.document.querySelector('.ws-mode-plan') as HTMLButtonElement;
    assert.equal(chip().textContent, 'plan: off');
    await act(async () => { chip().click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    assert.deepEqual(sent, ['/plan on']);
    assert.equal(box().value, 'my draft', 'the draft is not touched');
    await press('p', { altKey: true });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    assert.deepEqual(sent, ['/plan on', '/plan on'], 'Alt+P does the same');

    const on = { ...off, plan_mode: true };
    await act(async () => root.render(createElement(ComposerBar, { projectId: 'p1', workflow: on })));
    assert.equal(chip().textContent, 'plan: on');
    assert.equal(chip().getAttribute('aria-pressed'), 'true');
    assert.ok(dom.window.document.querySelector('.ws-composer--plan'));
    assert.match(box().placeholder, /Plan mode/);
    sent.length = 0;
    await act(async () => { chip().click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    assert.deepEqual(sent, ['/plan off']);
  });

  it('plan mode cannot be switched while a turn runs', async () => {
    const running = { id: 'w1', status: 'running', engine: 'claude-code', plan_mode: false, repo_ids: [] };
    await act(async () => root.render(createElement(ComposerBar, { projectId: 'p1', workflow: running })));
    assert.equal((dom.window.document.querySelector('.ws-mode-plan') as HTMLButtonElement).disabled, true);
  });
});
