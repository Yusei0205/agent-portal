/**
 * Simple / Advanced interface level (web/src/lib/uiLevel.js) and the rail tags
 * that use it (web/src/components/Rail.jsx).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// @ts-expect-error plain JS module shared with the browser
import * as ui from '../web/src/lib/uiLevel.js';

// Minimal browser globals: localStorage, document with an <html> element and events.
const store = new Map<string, string>();
const attrs = new Map<string, string>();
const events: string[] = [];
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as any).document = {
  documentElement: { setAttribute: (k: string, v: string) => { attrs.set(k, v); } },
  dispatchEvent: (e: { type: string }) => { events.push(e.type); return true; },
};
if (typeof (globalThis as any).CustomEvent === 'undefined') {
  (globalThis as any).CustomEvent = class { type: string; detail: unknown; constructor(t: string, i?: { detail?: unknown }) { this.type = t; this.detail = i?.detail; } };
}


describe('UI level', () => {
  beforeEach(() => { store.clear(); attrs.clear(); events.length = 0; });

  it('defaults to simple when nothing is saved', () => {
    assert.equal(ui.getUiLevel(), 'simple');
  });

  it('ignores an unknown saved value', () => {
    store.set(ui.LS_UI_LEVEL, 'expert');
    assert.equal(ui.getUiLevel(), 'simple');
  });

  it('saves, mirrors on <html data-ui-level> and announces a change', () => {
    ui.setUiLevel('advanced');
    assert.equal(store.get(ui.LS_UI_LEVEL), 'advanced');
    assert.equal(attrs.get('data-ui-level'), 'advanced');
    assert.deepEqual(events, [ui.UI_LEVEL_EVENT]);
    assert.equal(ui.getUiLevel(), 'advanced');
    ui.setUiLevel('anything-else');
    assert.equal(ui.getUiLevel(), 'simple');
  });

  it('never uses data-mode, which is the colour mode', () => {
    ui.applyUiLevel('advanced');
    assert.equal(attrs.has('data-mode'), false);
  });

  it('keeps core pages out of the advanced list', () => {
    for (const core of ['dashboard', 'inbox', 'sessions', 'automations', 'reviews', 'knowledge', 'create', 'vault', 'setup', 'settings', 'help', 'projects', 'account']) {
      assert.equal(ui.isAdvancedTab(core), false, `${core} should be core`);
    }
    for (const adv of ['usage', 'workspaces', 'tests', 'tickets', 'mail', 'connect', 'config', 'users', 'agentcore', 'api', 'feedback', 'academy', 'loop-specs']) {
      assert.equal(ui.isAdvancedTab(adv), true, `${adv} should be advanced`);
    }
  });

  it('rail items tagged advanced match ADVANCED_TABS', () => {
    const src = fs.readFileSync(new URL('../web/src/components/Rail.jsx', import.meta.url), 'utf8');
    const tagged = [...src.matchAll(/\{ tab: '([a-z-]+)'[^}\n]*advanced: true[^}\n]*\}/g)].map((m) => m[1]);
    assert.ok(tagged.length >= 10, `expected advanced rail items, found ${tagged.length}`);
    for (const tab of tagged) {
      assert.equal(ui.isAdvancedTab(tab), true, `rail item ${tab} is tagged advanced but not in ADVANCED_TABS`);
    }
  });
});
