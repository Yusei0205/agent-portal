/**
 * Unit tests for web/src/lib/help-content.js — the in-portal user guide (Help page).
 *
 * Checks the guide stays consistent with the portal: unique topic ids, known groups and icons,
 * a topic for every rail page, and links that point at real routes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error — plain JS module without type declarations
import { HELP_GROUPS, HELP_TOPICS, searchHelp, pageHref, plainText } from '../web/src/lib/help-content.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('help content', () => {
  it('has unique topic ids and known groups', () => {
    const ids = HELP_TOPICS.map((t: any) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    const groups = new Set(HELP_GROUPS.map((g: any) => g.id));
    for (const t of HELP_TOPICS) {
      assert.ok(groups.has(t.group), `${t.id}: unknown group ${t.group}`);
      assert.match(t.id, /^[a-z0-9-]+$/);
      assert.ok(t.title && t.summary && t.sections.length > 0, `${t.id}: incomplete`);
      for (const s of t.sections) assert.ok(s.heading && (s.items?.length || s.rows?.length), `${t.id}: empty section`);
      for (const s of t.sections) if (s.action) assert.ok(s.action.id && s.action.label, `${t.id}: a section action needs an id and a label`);
    }
  });

  it('uses only icons that exist', () => {
    const icons = read('web/src/components/Icon.jsx');
    for (const t of HELP_TOPICS) {
      assert.ok(new RegExp(`(^|\\s)'?${t.icon}'?:\\s`, 'm').test(icons), `${t.id}: no icon "${t.icon}"`);
    }
  });

  it('covers every page in the rail', () => {
    const rail = read('web/src/components/Rail.jsx');
    const railTabs = [...rail.matchAll(/\{ tab: '([a-z-]+)'/g)].map((m) => m[1]).filter((t) => t !== 'help');
    const linked = new Set(HELP_TOPICS.filter((t: any) => t.page).map((t: any) => t.page.tab));
    for (const tab of railTabs) assert.ok(linked.has(tab), `rail page "${tab}" has no help topic`);
  });

  it('links only to routes the app renders', () => {
    const app = read('web/src/App.jsx');
    for (const t of HELP_TOPICS) {
      if (!t.page) continue;
      const scope = t.page.project ? 'route.projectId &&' : '!route.projectId &&';
      assert.ok(app.includes(`${scope} route.tab === '${t.page.tab}'`), `${t.id}: no ${t.page.project ? 'project' : 'portal'} route "${t.page.tab}"`);
    }
  });

  it('builds page links', () => {
    assert.equal(pageHref({ tab: 'connect', sub: 'git' }, ''), '#/connect/git');
    assert.equal(pageHref({ tab: 'reviews', sub: 'code', project: true }, 'p 1'), '#/p/p%201/reviews/code');
    assert.equal(pageHref({ tab: 'sessions', project: true }, ''), null);
    assert.equal(pageHref(undefined, 'p1'), null);
  });

  it('searches every word, case-insensitively', () => {
    assert.equal(searchHelp('').length, HELP_TOPICS.length);
    const ids = searchHelp('BRANCH scan').map((t: any) => t.id);
    assert.ok(ids.includes('reviews'));
    assert.ok(!ids.includes('vault'));
    assert.equal(searchHelp('zzz-no-such-thing').length, 0);
    assert.equal(plainText('**Bold** and `code`'), 'Bold and code');
  });
});
