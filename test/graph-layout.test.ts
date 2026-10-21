// Layout of the agent canvas (web/src/lib/graphLayout.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUT, initials, layoutTree, liveNode, shapeKey } from '../web/src/lib/graphLayout.js';

type N = { id: string; children: N[]; status?: string; items?: { seq: number }[] };
const n = (id: string, ...children: N[]): N => ({ id, children });

test('a lone main agent sits in the first slot', () => {
  const l = layoutTree(n('main'));
  assert.deepEqual(l.pos.get('main'), { x: LAYOUT.padX + LAYOUT.colW / 2, y: LAYOUT.padY, depth: 0 });
  assert.equal(l.edges.length, 0);
  assert.equal(l.parent.get('main'), null);
});

test('subagents line up side by side under their parent, which is centred over them', () => {
  const l = layoutTree(n('main', n('a'), n('b'), n('c')));
  const [a, b, c, m] = ['a', 'b', 'c', 'main'].map((id) => l.pos.get(id)!);
  assert.ok(a.x < b.x && b.x < c.x, 'left to right in start order');
  assert.equal(a.y, b.y);
  assert.ok(a.y > m.y, 'children are below the parent');
  assert.equal(m.x, b.x, 'parent centred over its children');
  assert.deepEqual(l.edges, [{ from: 'main', to: 'a' }, { from: 'main', to: 'b' }, { from: 'main', to: 'c' }]);
  assert.equal(l.parent.get('c'), 'main');
});

test('nodes never share a position, even in uneven trees', () => {
  const l = layoutTree(n('main', n('a', n('a1'), n('a2'), n('a3')), n('b'), n('c', n('c1'))));
  const seen = new Set([...l.pos.values()].map((p) => `${p.x},${p.y}`));
  assert.equal(seen.size, l.pos.size);
  assert.ok(l.width >= 5 * LAYOUT.colW, 'one slot per leaf');
  assert.ok(l.height >= 3 * LAYOUT.rowH - LAYOUT.rowH + LAYOUT.padY);
});

test('collapsed nodes hide their children and take one slot', () => {
  const tree = n('main', n('a', n('a1'), n('a2')), n('b'));
  const l = layoutTree(tree, { collapsed: new Set(['a']) });
  assert.ok(!l.pos.has('a1') && !l.pos.has('a2'));
  assert.equal(l.edges.length, 2);
  assert.notEqual(shapeKey(tree), shapeKey(tree, new Set(['a'])));
});

test('the shape key ignores status changes, so positions stay put while agents work', () => {
  const tree: N = n('main', n('a'));
  const before = shapeKey(tree);
  tree.status = 'done';
  tree.children[0].status = 'failed';
  assert.equal(shapeKey(tree), before);
  tree.children.push(n('b'));
  assert.notEqual(shapeKey(tree), before, 'a new subagent changes it');
});

test('initials for bubbles', () => {
  assert.equal(initials('business-analyst'), 'BA');
  assert.equal(initials('Main agent'), 'MA');
  assert.equal(initials('reviewer'), 'RE');
  assert.equal(initials(''), '?');
});

test('follow live picks the running agent that acted last', () => {
  const nodes = new Map<string, N>([
    ['main', { id: 'main', children: [], status: 'running', items: [{ seq: 3 }] }],
    ['a', { id: 'a', children: [], status: 'running', items: [{ seq: 9 }] }],
    ['b', { id: 'b', children: [], status: 'done', items: [{ seq: 12 }] }],
  ]);
  assert.equal(liveNode(nodes)?.id, 'a');
  nodes.get('a')!.status = 'done';
  assert.equal(liveNode(nodes)?.id, 'main');
  nodes.get('main')!.status = 'done';
  assert.equal(liveNode(nodes), null);
});
