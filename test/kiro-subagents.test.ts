/**
 * kiro-runner/src/subagents.ts — Kiro's sub-agent frames (ACP `tool_call` tagged `_meta.kiro.kind = "agent-subtask"`)
 * become the portal's subagent-started / -finished / -failed events, so the agents graph can draw Kiro's agents.
 * The frames below follow the shapes Kiro documents (kirodotdev/Kiro issue 12092).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSubagentTracker } from '../kiro-runner/src/subagents.ts';

const start = (id: string, name: string, extra: Record<string, unknown> = {}, toolCallId = `call-${id}`) => ({
  sessionUpdate: 'tool_call',
  toolCallId,
  title: 'invoke_sub_agent',
  rawInput: { name, prompt: `Do the ${name} job in full detail.`, explanation: `Run the ${name}`, contextFiles: [], ...extra },
  _meta: { kiro: { kind: 'agent-subtask', agentSubtaskId: id } },
});
const said = (id: string, text: string) => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
  _meta: { kiro: { replayId: `${id}-say`, agentSubtaskId: id } },
});
const done = (toolCallId: string, status: string, text = '') => ({
  sessionUpdate: 'tool_call_update',
  toolCallId,
  status,
  ...(text ? { content: [{ type: 'content', content: { type: 'text', text } }] } : {}),
});

describe('Kiro sub-agents → portal events', () => {
  it('starts a sub-agent from the invoke_sub_agent frame, with its name and task', () => {
    const t = createSubagentTracker();
    assert.deepEqual(t.onUpdate(start('s-1', 'explorer')), [
      { type: 'subagent-started', id: 's-1', name: 'explorer', description: 'Run the explorer' },
    ]);
    assert.equal(t.openCount, 1);
  });

  it('uses the prompt as the task when there is no explanation, and reads a JSON string input', () => {
    const t = createSubagentTracker();
    const frame = { ...start('s-1', 'coder'), rawInput: JSON.stringify({ name: 'coder', prompt: 'Write   the\nretry' }) };
    assert.deepEqual(t.onUpdate(frame), [{ type: 'subagent-started', id: 's-1', name: 'coder', description: 'Write the retry' }]);
  });

  it('finishes it when the invoking tool call completes, with what the child answered', () => {
    let clock = 1000;
    const t = createSubagentTracker(() => clock);
    t.onUpdate(start('s-1', 'explorer'));
    t.onUpdate(said('s-1', 'Found 3 '));
    t.onUpdate(said('s-1', 'files.'));
    clock = 5000;
    const out = t.onUpdate(done('call-s-1', 'completed'));
    assert.deepEqual(out, [{ type: 'subagent-finished', id: 's-1', name: 'explorer', summary: 'Found 3 files.', status: 'completed', durationMs: 4000 }]);
    assert.equal(t.openCount, 0);
  });

  it('prefers the result Kiro attaches to the tool call over the child\'s last words', () => {
    const t = createSubagentTracker();
    t.onUpdate(start('s-1', 'explorer'));
    t.onUpdate(said('s-1', 'thinking out loud'));
    const [ev] = t.onUpdate(done('call-s-1', 'completed', 'Three files need changes.'));
    assert.equal(ev.summary, 'Three files need changes.');
  });

  it('reports a failed tool call as a failed sub-agent', () => {
    const t = createSubagentTracker();
    t.onUpdate(start('s-1', 'tester'));
    const [ev] = t.onUpdate(done('call-s-1', 'failed', 'Tests did not run.'));
    assert.equal(ev.type, 'subagent-failed');
    assert.equal(ev.summary, 'Tests did not run.');
  });

  it('keeps several sub-agents apart when they run at the same time', () => {
    const t = createSubagentTracker();
    t.onUpdate(start('a', 'api-reviewer'));
    t.onUpdate(start('b', 'web-reviewer'));
    t.onUpdate(said('b', 'web is fine'));
    t.onUpdate(said('a', 'api has a bug'));
    assert.equal(t.openCount, 2);
    const [b] = t.onUpdate(done('call-b', 'completed'));
    assert.equal(b.id, 'b');
    assert.equal(b.summary, 'web is fine');
    const [a] = t.onUpdate(done('call-a', 'completed'));
    assert.equal(a.summary, 'api has a bug');
  });

  it('finishes whatever is still open when the turn ends, so no node stays running', () => {
    const t = createSubagentTracker();
    t.onUpdate(start('a', 'one'));
    t.onUpdate(start('b', 'two'));
    t.onUpdate(said('a', 'all done'));
    const ended = t.finishOpen();
    assert.deepEqual(ended.map((e) => [e.type, e.id]), [['subagent-finished', 'a'], ['subagent-finished', 'b']]);
    assert.equal(ended[0].summary, 'all done');
    assert.equal(t.openCount, 0);
    assert.deepEqual(t.finishOpen(), [], 'nothing more to finish');
  });

  it('marks open sub-agents failed when the turn did not go well', () => {
    const t = createSubagentTracker();
    t.onUpdate(start('a', 'one'));
    assert.equal(t.finishOpen(false)[0].type, 'subagent-failed');
  });

  it('ignores ordinary tool calls, frames with no sub-agent id, and an agent started twice', () => {
    const t = createSubagentTracker();
    assert.deepEqual(t.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'x', title: 'fs_read', rawInput: { path: 'a.ts' } }), []);
    assert.deepEqual(t.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'y', title: 'invoke_sub_agent', rawInput: { name: 'n' } }), [], 'no agentSubtaskId: nothing to track it by');
    assert.deepEqual(t.onUpdate(done('call-unknown', 'completed')), []);
    assert.equal(t.onUpdate(start('s-1', 'explorer')).length, 1);
    assert.deepEqual(t.onUpdate(start('s-1', 'explorer')), [], 'a repeated start frame does not add a second node');
  });

  it('says which sub-agent a message or tool call belongs to, and leaves the caller\'s own alone', () => {
    const t = createSubagentTracker();
    t.onUpdate(start('s-1', 'explorer'));
    t.onUpdate(start('s-2', 'explorer'));
    // The call that started a sub-agent is the caller's own, not the sub-agent's work.
    assert.equal(t.ownerOf(start('s-1', 'explorer')), null);
    // The sub-agent's own message and tool calls carry its id (two agents of one type stay apart).
    assert.deepEqual(t.ownerOf(said('s-1', 'hello')), { id: 's-1', name: 'explorer' });
    assert.deepEqual(t.ownerOf({ sessionUpdate: 'tool_call', toolCallId: 'x', title: 'fs_read', rawInput: {}, _meta: { kiro: { agentSubtaskId: 's-2' } } }), { id: 's-2', name: 'explorer' });
    // A frame with no tag is the main agent's.
    assert.equal(t.ownerOf({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'main' } }), null);
    // A tag nothing has been seen under is not guessed at.
    assert.equal(t.ownerOf(said('unknown', 'stray')), null);
  });

  describe('a lead agent that spawns a crew', () => {
    const crew = { sessionUpdate: 'tool_call', toolCallId: 'crew-1', title: 'Spawning agent crew', rawInput: {} };

    it('shows each agent of the crew, though no call names them', () => {
      const t = createSubagentTracker();
      assert.deepEqual(t.onUpdate(crew), [], 'the hand-off call itself is the lead\'s');
      const first = t.onUpdate(said('c-1', 'Looking at the first file'));
      assert.deepEqual(first, [{ type: 'subagent-started', id: 'c-1', name: 'sub-agent' }]);
      assert.equal(t.onUpdate(said('c-1', ' and the next')).length, 0, 'started once');
      assert.equal(t.onUpdate(said('c-2', 'Another agent')).length, 1);
      assert.equal(t.openCount, 2);
      assert.deepEqual(t.ownerOf(said('c-2', 'more')), { id: 'c-2', name: 'sub-agent' });
      assert.equal(t.ownerOf(crew), null);
    });

    it('starts an agent from a tool call of its own, and finishes the crew when the hand-off call ends', () => {
      const t = createSubagentTracker();
      t.onUpdate(crew);
      const started = t.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Reading a.ts', rawInput: {}, _meta: { kiro: { agentSubtaskId: 'c-1' } } });
      assert.equal(started[0]?.type, 'subagent-started');
      t.onUpdate(said('c-1', 'Found nothing.'));
      const ended = t.onUpdate(done('crew-1', 'completed'));
      assert.deepEqual(ended.map((e) => [e.type, e.id]), [['subagent-finished', 'c-1']]);
      assert.equal(ended[0]?.summary, 'Found nothing.');
      assert.equal(t.openCount, 0);
    });

    it('uses the name the hand-off call gives when it is tagged and named', () => {
      const t = createSubagentTracker();
      const ev = t.onUpdate({ ...crew, rawInput: { name: 'reviewer', prompt: 'Review it' }, _meta: { kiro: { agentSubtaskId: 'c-9' } } });
      assert.equal(ev[0]?.name, 'reviewer');
    });
  });

  it('still names a sub-agent\'s late frame after it has finished', () => {
    const t = createSubagentTracker();
    t.onUpdate(start('s-1', 'explorer'));
    t.onUpdate(done('call-s-1', 'completed'));
    assert.equal(t.openCount, 0);
    assert.deepEqual(t.ownerOf(said('s-1', 'one more thing')), { id: 's-1', name: 'explorer' });
  });

  it('keeps names and text to a sensible size', () => {
    const t = createSubagentTracker();
    const [ev] = t.onUpdate(start('s-1', 'n'.repeat(500), { explanation: 'e'.repeat(2000) }));
    assert.ok(ev.name.length <= 64);
    assert.ok((ev.description ?? '').length <= 300);
    t.onUpdate(said('s-1', 'x'.repeat(5000)));
    assert.ok((t.finishOpen()[0].summary ?? '').length <= 1000);
  });
});
