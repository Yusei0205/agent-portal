/** The cat's shortcut panel: which actions exist for a route and how typed text is matched. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS module without type declarations
import { catActions, matchCatInput, normalizeQuery, CAT_GREETING } from '../web/src/lib/cat-actions.js';

const inProject = { projectId: 'p1', tab: 'sessions', rest: [] };
const portal = { projectId: null, tab: 'projects', rest: [] };
const labels = (a: Array<{ label: string }>) => a.map((x) => x.label);

describe('catActions', () => {
  it('offers the project shortcuts inside a project', () => {
    assert.deepEqual(labels(catActions(inProject)), ['Start a session', 'What needs me?', 'Auto-fix', 'Pipelines', 'Search knowledge']);
    const byId = Object.fromEntries(catActions(inProject).map((a: any) => [a.id, a]));
    assert.equal(byId.start.href, '#/p/p1/sessions');
    assert.equal(byId.start.after, 'new-session');
    assert.equal(byId.inbox.href, '#/inbox');
    assert.equal(byId.autofix.href, '#/p/p1/setup/autofix');
    assert.equal(byId.pipelines.href, '#/p/p1/setup/pipelines');
    assert.equal(byId.knowledge.href, '#/p/p1/knowledge');
  });
  it('offers only what exists outside a project: no project actions', () => {
    const a = catActions(portal);
    assert.deepEqual(labels(a), ['What needs me?', 'Open a project']);
    assert.ok(a.every((x: any) => !x.href.includes('/p/')));
  });
  it('tolerates a missing route and encodes the project id', () => {
    assert.deepEqual(labels(catActions(null)), ['What needs me?', 'Open a project']);
    assert.equal(catActions({ projectId: 'a b' })[0].href, '#/p/a%20b/sessions');
  });
  it('has unique ids', () => {
    const ids = catActions(inProject).map((a: any) => a.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('matchCatInput', () => {
  const actions = catActions(inProject);
  const pages = [
    { id: 'goto_sessions', label: 'Sessions', href: '#/p/p1/sessions' },
    { id: 'goto_reviews', label: 'Reviews', href: '#/p/p1/reviews/code' },
    { id: 'help_reviews', label: 'Help: Reviews', href: '#/help/reviews' },
    { id: 'goto_inbox', label: 'Inbox', href: '#/inbox' },
    { id: 'goto_usage', label: 'Usage', href: '#/usage' },
    { id: 'goto_settings', label: 'Settings', href: '#/settings' },
  ];
  const hit = (t: string) => matchCatInput(t, actions, pages);

  it('opens the Inbox for "inbox" in any form', () => {
    for (const t of ['inbox', 'Inbox', '  INBOX! ', 'open the inbox', 'take me to my inbox', 'what needs me', 'What needs me?']) {
      const r = hit(t);
      assert.equal(r.kind, 'action', t);
      assert.equal(r.item.href, '#/inbox', t);
    }
  });
  it('matches the other actions by name or keyword', () => {
    assert.equal(hit('start a session').item.id, 'start');
    assert.equal(hit('new session').item.id, 'start');
    assert.equal(hit('autofix').item.id, 'autofix');
    assert.equal(hit('Auto-fix').item.id, 'autofix');
    assert.equal(hit('pipelines').item.id, 'pipelines');
    assert.equal(hit('search knowledge').item.id, 'knowledge');
    assert.equal(hit('knowledge').item.id, 'knowledge');
  });
  it('matches page names from the command palette', () => {
    assert.deepEqual([hit('usage').kind, hit('usage').item.href], ['page', '#/usage']);
    assert.equal(hit('go to settings').item.href, '#/settings');
    assert.equal(hit('reviews').item.href, '#/p/p1/reviews/code'); // the page, not the help topic
    assert.equal(hit('sessions').item.href, '#/p/p1/sessions');
  });
  it('says none for questions and empty text', () => {
    for (const t of ['what is the weather', 'hello there', '', '   ', '??', 'x']) assert.equal(hit(t).kind, 'none', t);
    assert.equal(matchCatInput('inbox', [], []).kind, 'none');
    assert.equal(matchCatInput('inbox', undefined, undefined).kind, 'none');
  });
  it('does not offer project pages it was not given', () => {
    assert.equal(matchCatInput('auto-fix', catActions(portal), pages).kind, 'none');
  });
  it('ignores page entries without a link', () => {
    assert.equal(matchCatInput('theme', [], [{ label: 'Theme: Dark' }]).kind, 'none');
  });
});

describe('copy', () => {
  it('normalizeQuery strips filler words and punctuation', () => {
    assert.equal(normalizeQuery('Take me to the Inbox!'), 'inbox');
    assert.equal(normalizeQuery('  Auto-fix '), 'auto fix');
  });
  it('greets', () => {
    assert.equal(CAT_GREETING, "Meow! I'm your portal assistant. What would you like to do?");
  });
});
