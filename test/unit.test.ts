import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { extractJson, parseFrontmatter, safeJoin, slugify, stringifyFrontmatter } from '../server/util.ts';
import { htmlToMarkdown, sectionize } from '../server/convert.ts';
import { parseUnifiedDiff, reviewDiff } from '../server/agent/heuristics.ts';
import { estimateCost, tierOf } from '../server/agent/pricing.ts';
import { redact } from '../server/git.ts';

test('frontmatter round trip keeps lists and quotes', () => {
  const text = stringifyFrontmatter({ name: 'qa-engineer', description: 'Use for tests: plans & cases', tools: ['Read', 'Grep'], model: 'haiku' }, 'Body here');
  const { data, body } = parseFrontmatter(text);
  assert.equal(data.name, 'qa-engineer');
  assert.equal(data.description, 'Use for tests: plans & cases');
  assert.equal(data.tools, 'Read, Grep');
  assert.equal(body.trim(), 'Body here');
  const yamlList = parseFrontmatter('---\nname: x\ntools:\n  - Read\n  - Write\n---\nhi');
  assert.deepEqual(yamlList.data.tools, ['Read', 'Write']);
});

test('sectionize splits on headings, ignores code fences, keeps anchors unique', () => {
  const s = sectionize('Intro text here.\n\n# A\n\nalpha\n\n```\n# not a heading\n```\n\n## B\n\nbeta\n\n## B\n\ngamma', 'Doc');
  assert.deepEqual(s.map((x) => x.heading), ['Doc', 'A', 'B', 'B']);
  assert.deepEqual(s.map((x) => x.anchor), ['doc', 'a', 'b', 'b-2']);
  assert.match(s[1].content, /# not a heading/);
});

test('long sections are split into parts', () => {
  const big = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} ${'word '.repeat(10)}`).join('\n\n');
  const s = sectionize(`# Big\n\n${big}`, 'Doc');
  assert.ok(s.length > 1);
  assert.ok(s.every((x) => x.content.length <= 12_000));
  assert.equal(s[1].heading, 'Big (part 2)');
});

test('html to markdown keeps structure and drops scripts', () => {
  const md = htmlToMarkdown('<h2>Title</h2><p>Hello <strong>world</strong></p><script>alert(1)</script><ul><li>One</li></ul>');
  assert.match(md, /^## Title/m);
  assert.match(md, /\*\*world\*\*/);
  assert.match(md, /- One/);
  assert.ok(!md.includes('alert'));
});

test('review rules catch secrets, injection and silent catches but not env lookups', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/a.ts',
    '@@ -0,0 +1,5 @@',
    "+const password = 'hunter2hunter2';",
    '+const token = process.env.TOKEN;',
    '+db.query("SELECT * FROM t WHERE id = " + id);',
    '+try { x() } catch (e) {}',
    '+fetch("http://example.com/api")',
  ].join('\n');
  const f = reviewDiff(diff);
  const msgs = f.map((x) => `${x.line}:${x.severity}:${x.category}`);
  assert.ok(msgs.includes('1:critical:security'));
  assert.ok(!f.some((x) => x.line === 2 && x.severity === 'critical'));
  assert.ok(msgs.includes('3:high:security'));
  assert.ok(msgs.includes('4:medium:reliability'));
  assert.ok(msgs.includes('5:low:security'));
  const files = parseUnifiedDiff(diff);
  assert.equal(files[0].status, 'added');
  assert.equal(files[0].additions, 5);
});

test('pricing tiers and Haiku long-prompt pricing', () => {
  assert.equal(tierOf('claude-haiku-5-5'), 'haiku');
  assert.equal(tierOf('global.anthropic.claude-opus-5-5'), 'opus');
  assert.equal(tierOf('claude-fable-5-1'), 'fable');
  assert.equal(estimateCost('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000 }), 3);
  assert.equal(estimateCost('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 5_000 }), 0.0075);
  assert.equal(estimateCost('claude-haiku-5-5', { input_tokens: 200_000 }), 0.1);
});

test('helpers: json extraction, safe paths, slugs, redaction', () => {
  assert.deepEqual(extractJson('Here:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('noise {"b":[1,2]} trailing'), { b: [1, 2] });
  assert.equal(extractJson('nothing'), null);
  assert.throws(() => safeJoin('/data/x', '../y'));
  assert.equal(safeJoin('/data/x', 'a/b'), path.resolve('/data/x', 'a/b'));
  assert.equal(slugify('Refunds FSD v2 (final).pdf'), 'refunds-fsd-v2-final-pdf');
  assert.equal(redact('fatal: https://user:ghp_abcdefghijklmnopqrstuvwxyz123456@github.com/a'), 'fatal: https://***@github.com/a');
});
