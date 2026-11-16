/**
 * The shot board and the HTML guide: reading a screenshot manifest, telling placed, unplaced, missing and
 * not-captured pictures apart, and building a page that cannot run script from the guide's text.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, shotBoard, boardCounts, referencedShots, shotPath, buildGuideHtml, mergeGuides, guideSetFromSources } from '../server/guide-bundle.ts';

const MANIFEST = [
  '{"file":"10-checker-sidebar.png","role":"Checker","page":"/dashboard","title":"Sidebar","boxes":[{"n":1,"label":"Dashboard"},{"n":2,"label":"Bell"}]}',
  '{"file":"11-list.png","role":"Checker","title":"List"}',
  '{"file":"tmp-scratch.png","title":"scratch"}',
  '{"file":"12-old.png","title":"old","notes":"DO NOT USE: superseded"}',
  '{"file":"13-gone.png","title":"Admin screen","missing":true,"notes":"not shown to this role"}',
  'not json',
  '{"file":"../escape.png"}',
].join('\n');

describe('manifest', () => {
  it('keeps real shots and leaves out scratch, retired, broken and path-escaping lines', () => {
    const { shots, skipped } = parseManifest(MANIFEST);
    assert.deepEqual(shots.map((s) => s.file), ['screenshots/10-checker-sidebar.png', 'screenshots/11-list.png', 'screenshots/13-gone.png']);
    assert.equal(skipped, 4);
    assert.deepEqual(shots[0].boxes, [{ n: 1, label: 'Dashboard' }, { n: 2, label: 'Bell' }]);
    assert.equal(shots[2].missing, true);
  });

  it('treats "x.png" and "screenshots/x.png" as the same picture', () => {
    assert.equal(shotPath('a.png'), 'screenshots/a.png');
    assert.equal(shotPath('screenshots/a.png'), 'screenshots/a.png');
    assert.equal(shotPath('.\\screenshots\\a.png'), 'screenshots/a.png');
  });
});

describe('shot board', () => {
  const md = '# G\n\n![Sidebar: 1 Dashboard](screenshots/10-checker-sidebar.png)\n\n![Gone](screenshots/99-lost.png)\n\n![Again](screenshots/10-checker-sidebar.png)';

  it('lists the pictures the text shows, once each, in order', () => {
    assert.deepEqual(referencedShots(md), ['screenshots/10-checker-sidebar.png', 'screenshots/99-lost.png']);
    assert.deepEqual(referencedShots('![x](https://evil.test/a.png) ![y](other/a.png)'), []);
  });

  it('marks placed, unplaced, missing-file and not-captured, and joins the manifest', () => {
    const { shots } = parseManifest(MANIFEST);
    const rows = shotBoard(md, ['screenshots/10-checker-sidebar.png', 'screenshots/11-list.png'], shots);
    const status = Object.fromEntries(rows.map((r) => [r.file, r.status]));
    assert.deepEqual(status, {
      'screenshots/10-checker-sidebar.png': 'placed',
      'screenshots/99-lost.png': 'missing-file',
      'screenshots/11-list.png': 'unplaced',
      'screenshots/13-gone.png': 'not-captured',
    });
    const placed = rows.find((r) => r.file === 'screenshots/10-checker-sidebar.png')!;
    assert.equal(placed.role, 'Checker');
    assert.equal(placed.inManifest, true);
    assert.equal(rows.find((r) => r.file === 'screenshots/99-lost.png')!.inManifest, false);
    assert.deepEqual(boardCounts(rows), { placed: 1, unplaced: 1, 'missing-file': 1, 'not-captured': 1, total: 4 });
  });

  it('works without a manifest', () => {
    const rows = shotBoard('![a](screenshots/a.png)', ['screenshots/a.png', 'screenshots/b.png'], []);
    assert.deepEqual(rows.map((r) => [r.file, r.status]), [['screenshots/a.png', 'placed'], ['screenshots/b.png', 'unplaced']]);
  });
});

describe('guide HTML', () => {
  const build = (md: string, files: string[] = [], manifest = MANIFEST) =>
    buildGuideHtml({ title: 'My <guide>', md, rows: shotBoard(md, files, parseManifest(manifest).shots), generatedAt: '2026-11-16T00:00:00Z' });

  it('makes figures with the box legend, a contents list and the appendix of unplaced pictures', () => {
    const html = build('# Guide\n\n## Start\n\nText\n\n### Sub\n\n![Sidebar: 1 Dashboard](screenshots/10-checker-sidebar.png)',
      ['screenshots/10-checker-sidebar.png', 'screenshots/11-list.png']);
    assert.match(html, /<figure><img loading="lazy" src="screenshots\/10-checker-sidebar.png" alt="Sidebar: 1 Dashboard">/);
    assert.match(html, /<li value="1">Dashboard<\/li><li value="2">Bell<\/li>/);
    assert.match(html, /<a class="d2" href="#start">Start<\/a><a class="d3" href="#sub">Sub<\/a>/);
    assert.match(html, /id="more-screenshots"[\s\S]*src="screenshots\/11-list.png"/);
    assert.match(html, /id="screenshots-to-be-added"[\s\S]*13-gone\.png[\s\S]*could not be taken/);
    assert.match(html, /<title>My &lt;guide&gt;<\/title>/);
  });

  it('shows raw HTML as text and drops script links and pictures from elsewhere', () => {
    const html = build('# G\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [ok](https://example.com)\n\n![x](https://evil.test/a.png)\n\n<img src=x onerror=alert(1)>');
    assert.ok(!html.includes('<script>alert'));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!/href="javascript:/i.test(html));
    assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">ok<\/a>/);
    assert.ok(!html.includes('evil.test'));
  });

  it('gives repeated headings their own anchors', () => {
    const html = build('## Same\n\n## Same');
    assert.match(html, /id="same"/);
    assert.match(html, /id="same-2"/);
  });
});

describe('large guides (one document per role)', () => {
  const part = (label: string, slug: string, md: string, files: string[], manifest = '') => ({ label, slug, md, files, manifest: parseManifest(manifest).shots });

  it('reads the caption as the title of a picture the manifest knows nothing about', () => {
    const rows = shotBoard('![Sign in: 1 Email](screenshots/01.png)', ['screenshots/01.png'], []);
    assert.equal(rows[0].title, 'Sign in: 1 Email');
  });

  it('accepts a well-formed set tag only', () => {
    assert.deepEqual(guideSetFromSources({ guideSet: { id: 'set_abc123', name: ' LENS ' } }), { id: 'set_abc123', name: 'LENS' });
    assert.equal(guideSetFromSources({ guideSet: { id: 'x', name: 'n' } }), null);
    assert.equal(guideSetFromSources({ guideSet: { id: 'set_abc123', name: '' } }), null);
    assert.equal(guideSetFromSources({ guideSet: 'nope' }), null);
    assert.equal(guideSetFromSources({}), null);
    assert.equal(guideSetFromSources(null), null);
  });

  it('makes a chapter per document, moves each document pictures to its own folder and lets two use the same file name', () => {
    const a = part('Checker', 'gd_a', '# Checker guide\n\n## Sign in\n\n![Sign in](screenshots/01-login.png)\n\n```\n# not a heading\n```', ['screenshots/01-login.png'],
      '{"file":"screenshots/01-login.png","role":"Checker","page":"/login"}');
    const b = part('Admin', 'gd_b', '# Admin guide\n\n## Sign in\n\n![Sign in](screenshots/01-login.png)', ['screenshots/01-login.png', 'screenshots/02-extra.png']);
    const m = mergeGuides('LENS', [a, b]);
    assert.match(m.md, /^# LENS\n\n## Checker\n\n### Sign in\n\n!\[Sign in\]\(screenshots\/gd_a\/01-login\.png\)/);
    assert.match(m.md, /## Admin\n\n### Sign in\n\n!\[Sign in\]\(screenshots\/gd_b\/01-login\.png\)/);
    assert.ok(!m.md.includes('# Checker guide') && !m.md.includes('# Admin guide'), 'each document title line is dropped');
    assert.match(m.md, /```\n# not a heading\n```/, 'code is left alone');
    assert.deepEqual(m.files.map((f) => `${f.part}:${f.from}>${f.to}`), [
      '0:screenshots/01-login.png>screenshots/gd_a/01-login.png',
      '1:screenshots/01-login.png>screenshots/gd_b/01-login.png',
      '1:screenshots/02-extra.png>screenshots/gd_b/02-extra.png',
    ]);
    const status = Object.fromEntries(m.rows.map((r) => [r.file, r.status]));
    assert.deepEqual(status, {
      'screenshots/gd_a/01-login.png': 'placed',
      'screenshots/gd_b/01-login.png': 'placed',
      'screenshots/gd_b/02-extra.png': 'unplaced',
    });
    assert.equal(m.rows[0].role, 'Checker', 'the manifest follows the picture to its new path');
    const html = buildGuideHtml({ title: 'LENS', md: m.md, rows: m.rows, generatedAt: '2026-11-16T00:00:00Z' });
    assert.match(html, /src="screenshots\/gd_a\/01-login\.png"/);
    assert.match(html, /<h2 id="checker">Checker<\/h2>/);
    assert.match(html, /id="more-screenshots"[\s\S]*gd_b\/02-extra\.png/);
  });
});
