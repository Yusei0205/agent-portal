/**
 * The agents orbit view's two pure parts:
 *   web/src/lib/agent-activity.js — each agent's tool count, current action and transcript, from the run's events
 *   web/src/lib/agent-orbit.js    — where agents sit around the main agent, and arrow-key navigation between them
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS module without type declarations
import { summarizeActivity, describeTool, badgeCount, agentLabels, increasedTools } from '../web/src/lib/agent-activity.js';
// @ts-expect-error — plain JS module without type declarations
import { orbitLayout, neighbourInDirection, nervePath, ORBIT_MAIN, RING_STEP } from '../web/src/lib/agent-orbit.js';

interface Ev { type: string; payload: Record<string, unknown> }
const text = (t: string, extra: Record<string, unknown> = {}): Ev => ({ type: 'assistant-text', payload: { text: t, ...extra } });
const tool = (toolName: string, toolInput: unknown, extra: Record<string, unknown> = {}): Ev => ({ type: 'tool-start', payload: { toolName, toolInput, ...extra } });

describe('describeTool', () => {
  it('says what a tool call is in a few words', () => {
    assert.equal(describeTool('Bash', JSON.stringify({ command: 'cd rhb && ls' })), 'Running cd rhb && ls');
    assert.equal(describeTool('Read', { file_path: 'src/app.ts' }), 'Read src/app.ts');
    assert.equal(describeTool('mcp__portal__delegate_session', '{}'), 'delegate_session');
    assert.equal(describeTool('Grep', 'not json'), 'Grep');
  });
  it('keeps a long command short', () => {
    assert.ok(describeTool('Bash', { command: 'x'.repeat(500) }).length <= 100);
  });
});

describe('summarizeActivity', () => {
  const agents = [
    { id: 'a', name: 'reviewer', status: 'running' },
    { id: 'b', name: 'tester', status: 'done' },
  ];

  it('gives the main agent the events with no agent label, and each sub-agent its own', () => {
    const out = summarizeActivity([
      tool('Bash', { command: 'ls' }),
      tool('Read', { file_path: 'a.ts' }, { agent: 'reviewer' }),
      text('Two bugs in a.ts.', { agent: 'reviewer' }),
      tool('Bash', { command: 'npm test' }, { agent: 'tester' }),
      text('Planning the next step.'),
    ], agents);
    assert.equal(out.main.tools, 1);
    assert.equal(out.main.current, 'Planning the next step.');
    assert.equal(out.byId.get('a').tools, 1);
    assert.equal(out.byId.get('a').current, 'Two bugs in a.ts.');
    assert.deepEqual(out.byId.get('a').lines.map((l: { kind: string }) => l.kind), ['tool', 'text']);
    assert.equal(out.byId.get('b').tools, 1);
    assert.equal(out.byId.get('b').current, 'Running npm test');
  });

  it('joins streamed chunks of one message into one line', () => {
    const out = summarizeActivity([
      text('Found ', { stream: true }), text('3 files', { stream: true }), text('.', { stream: true }),
    ], []);
    assert.deepEqual(out.main.lines, [{ kind: 'text', text: 'Found 3 files.' }]);
  });

  it('starts a new line after a tool call', () => {
    const out = summarizeActivity([text('One', { stream: true }), tool('Read', { file_path: 'a' }), text('Two', { stream: true })], []);
    assert.deepEqual(out.main.lines.map((l: { text: string }) => l.text), ['One', 'Read a', 'Two']);
  });

  it('leaves a label that matches no agent out of the main agent\'s transcript', () => {
    const out = summarizeActivity([text('ghost speaking', { agent: 'nobody' }), text('main speaking')], agents);
    assert.deepEqual(out.main.lines.map((l: { text: string }) => l.text), ['main speaking']);
  });

  it('picks the running agent when two share a name', () => {
    const twins = [{ id: 'old', name: 'coder', status: 'done' }, { id: 'new', name: 'coder', status: 'running' }];
    const out = summarizeActivity([tool('Read', { file_path: 'x' }, { agent: 'coder' })], twins);
    assert.equal(out.byId.get('new').tools, 1);
    assert.equal(out.byId.get('old').tools, 0);
  });

  it('ignores other event types, empty text, and caps a very long transcript', () => {
    const many = Array.from({ length: 500 }, (_, i) => tool('Read', { file_path: `f${i}` }));
    const out = summarizeActivity([{ type: 'status', payload: { text: 'hi' } }, text('   '), ...many], []);
    assert.equal(out.main.tools, 500);
    assert.equal(out.main.lines.length, 200);
    assert.equal(out.main.lines[199].text, 'Read f499');
  });

  it('gives agents that share a name their own transcripts when events name the agent by id', () => {
    const triplets = [
      { id: 'run1:s-1', name: 'general-task-execution', status: 'done' },
      { id: 'run1:s-2', name: 'general-task-execution', status: 'done' },
      { id: 'run1:s-3', name: 'general-task-execution', status: 'running' },
    ];
    const out = summarizeActivity([
      text('first one done', { agentId: 's-1', agent: 'general-task-execution' }),
      tool('fs_read', {}, { agentId: 's-2', agent: 'general-task-execution' }),
      text('third is working', { agentId: 's-3', agent: 'general-task-execution' }),
      text('and the main agent speaks'),
    ], triplets);
    assert.deepEqual(out.byId.get('run1:s-1').lines.map((l: { text: string }) => l.text), ['first one done']);
    assert.deepEqual(out.byId.get('run1:s-2').lines.map((l: { text: string }) => l.text), ['fs_read']);
    assert.equal(out.byId.get('run1:s-3').current, 'third is working');
    assert.deepEqual(out.main.lines.map((l: { text: string }) => l.text), ['and the main agent speaks']);
  });

  it('does not put an event with an unknown agent id in the main agent\'s transcript', () => {
    const out = summarizeActivity([text('who?', { agentId: 'nope' }), text('main')], [{ id: 'run1:s-1', name: 'x', status: 'running' }]);
    assert.deepEqual(out.main.lines.map((l: { text: string }) => l.text), ['main']);
  });

  it('copes with no events and no agents', () => {
    const out = summarizeActivity(undefined, undefined);
    assert.equal(out.main.tools, 0);
    assert.equal(out.byId.size, 0);
  });
});

describe('agentLabels', () => {
  it('keeps a lone agent\'s name and numbers agents that share one, in the order they started', () => {
    const labels = agentLabels([
      { id: 'c', name: 'general-task-execution', startedAt: '2026-11-08T05:00:09Z' },
      { id: 'a', name: 'general-task-execution', startedAt: '2026-11-08T05:00:01Z' },
      { id: 'b', name: 'general-task-execution', startedAt: '2026-11-08T05:00:05Z' },
      { id: 'x', name: 'reviewer', startedAt: '2026-11-08T05:00:02Z' },
    ]);
    assert.equal(labels.get('a'), 'general-task-execution #1');
    assert.equal(labels.get('b'), 'general-task-execution #2');
    assert.equal(labels.get('c'), 'general-task-execution #3');
    assert.equal(labels.get('x'), 'reviewer');
  });
  it('copes with no agents and with agents that have no start time', () => {
    assert.equal(agentLabels(undefined).size, 0);
    const l = agentLabels([{ id: '1', name: 'a' }, { id: '2', name: 'a' }]);
    assert.deepEqual([l.get('1'), l.get('2')], ['a #1', 'a #2']);
  });
});

describe('increasedTools', () => {
  it('names the agents that made more tool calls, and nothing on the first look', () => {
    assert.deepEqual(increasedTools(null, { a: 3, b: 0 }), []);
    assert.deepEqual(increasedTools({ a: 3, b: 0 }, { a: 3, b: 0 }), []);
    assert.deepEqual(increasedTools({ a: 3, b: 0 }, { a: 4, b: 0 }), ['a']);
    assert.deepEqual(increasedTools({ a: 3 }, { a: 3, b: 2 }).sort(), ['b'], 'a new agent that already made calls fires');
    assert.deepEqual(increasedTools({ a: 3 }, { a: 3, b: 0 }), [], 'a new agent with no calls yet does not');
    assert.deepEqual(increasedTools({ a: 5 }, { a: 2 }), [], 'a lower count (a new run) does not fire');
  });
});

describe('nervePath', () => {
  const A = { x: 0, y: 0 };
  const B = { x: 100, y: 0 };
  it('is a curve from one agent to the other, with its length', () => {
    const p = nervePath(A, B, 1);
    assert.match(p.d, /^M0 0 Q[-\d.]+ [-\d.]+ 100 0$/);
    assert.equal(p.length, 100);
    const [, cx, cy] = /Q([-\d.]+) ([-\d.]+)/.exec(p.d)!.map(Number) as number[];
    assert.equal(cx, 50);
    assert.notEqual(cy, 0, 'the middle is pulled off the straight line');
  });
  it('bends to the other side when asked, and never by more than 60px', () => {
    const up = Number(/Q[-\d.]+ ([-\d.]+)/.exec(nervePath(A, B, 1).d)![1]);
    const down = Number(/Q[-\d.]+ ([-\d.]+)/.exec(nervePath(A, B, -1).d)![1]);
    assert.equal(up, -down);
    assert.ok(Math.abs(Number(/Q[-\d.]+ ([-\d.]+)/.exec(nervePath(A, { x: 2000, y: 0 }, 1).d)![1])) <= 60);
  });
  it('copes with two agents in the same place', () => {
    const p = nervePath(A, A, 1);
    assert.equal(p.length, 0);
    assert.match(p.d, /^M0 0 L0 0$/);
  });
});

describe('badgeCount', () => {
  it('caps at 99+', () => {
    assert.equal(badgeCount(7), '7');
    assert.equal(badgeCount(99), '99');
    assert.equal(badgeCount(120), '99+');
    assert.equal(badgeCount(-3), '0');
  });
});

describe('orbitLayout', () => {
  const near = (v: number, w: number, eps = 1e-6) => Math.abs(v - w) < eps;

  it('puts the main agent in the centre with no rings when there are no agents', () => {
    const g = orbitLayout([]);
    assert.equal(g.nodes.length, 1);
    assert.deepEqual([g.nodes[0].x, g.nodes[0].y, g.nodes[0].isMain], [0, 0, true]);
    assert.deepEqual(g.rings, []);
  });

  it('spreads the agents the main agent started evenly around the first ring', () => {
    const g = orbitLayout([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
    const ring = g.nodes.filter((n: { id: string }) => n.id !== ORBIT_MAIN);
    assert.equal(ring.length, 4);
    for (const n of ring) assert.ok(near(Math.hypot(n.x, n.y), RING_STEP));
    assert.deepEqual(g.rings, [RING_STEP]);
    assert.equal(g.edges.length, 4);
    assert.ok(g.edges.every((e: { from: string }) => e.from === ORBIT_MAIN));
  });

  it('puts an agent on the next ring out, joined to the agent that started it', () => {
    const g = orbitLayout([{ id: 'p' }, { id: 'c', parentId: 'p' }]);
    const c = g.nodes.find((n: { id: string }) => n.id === 'c');
    assert.ok(near(Math.hypot(c.x, c.y), 2 * RING_STEP));
    assert.deepEqual(g.edges.find((e: { to: string }) => e.to === 'c'), { from: 'p', to: 'c' });
    assert.equal(g.rings.length, 2);
  });

  it('keeps neighbours on one ring apart', () => {
    const agents = [{ id: 'p1' }, { id: 'p2' }, ...Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, parentId: i < 3 ? 'p1' : 'p2' }))];
    const g = orbitLayout(agents);
    const outer = g.nodes.filter((n: { depth: number }) => n.depth === 2);
    for (let i = 0; i < outer.length; i++) {
      for (let j = i + 1; j < outer.length; j++) assert.ok(Math.hypot(outer[i].x - outer[j].x, outer[i].y - outer[j].y) > 60, 'agents overlap');
    }
  });

  it('keeps an agent whose parent is unknown, a parent loop and a self parent', () => {
    const g = orbitLayout([
      { id: 'x', parentId: 'gone' },
      { id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' },
      { id: 's', parentId: 's' },
    ]);
    assert.equal(g.nodes.length, 5);
    for (const n of g.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
    assert.equal(new Set(g.edges.map((e: { to: string }) => e.to)).size, 4, 'every agent is joined to something');
  });
});

describe('neighbourInDirection', () => {
  const g = orbitLayout([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
  const pos = (id: string) => g.nodes.find((n: { id: string }) => n.id === id);

  it('moves from the main agent to the agent in that direction', () => {
    // First ring starts at the top and goes round: a top, b right, c bottom, d left.
    assert.equal(neighbourInDirection(g.nodes, null, { x: 0, y: -1 }), 'a');
    assert.equal(neighbourInDirection(g.nodes, null, { x: 1, y: 0 }), 'b');
    assert.equal(neighbourInDirection(g.nodes, null, { x: 0, y: 1 }), 'c');
    assert.equal(neighbourInDirection(g.nodes, null, { x: -1, y: 0 }), 'd');
  });

  it('goes back toward the centre, and stays put when nothing lies that way', () => {
    assert.ok(pos('a'));
    assert.equal(neighbourInDirection(g.nodes, 'a', { x: 0, y: 1 }), ORBIT_MAIN);
    assert.equal(neighbourInDirection(g.nodes, 'a', { x: 0, y: -1 }), null);
  });
});
