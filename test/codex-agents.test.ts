import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexAgentTracker } from '../server/agent/codex-agents.ts';

test('tracks concurrent native agents, nested parents, completion and restart without duplicates', () => {
  const events: any[] = [];
  const tracker = createCodexAgentTracker((type, payload) => events.push({ type, ...payload }));
  const spawn = { type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', senderThreadId: 'lead', receiverThreadIds: ['api'], prompt: 'Review API', agentsStates: {} };
  tracker.accept(spawn); tracker.accept(spawn);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'subagent-started');
  tracker.accept({ ...spawn, senderThreadId: 'api', receiverThreadIds: ['tests'] });
  tracker.accept({ ...spawn, tool: 'wait', agentsStates: { api: { status: 'completed', message: 'Done' }, tests: { status: 'errored', message: 'Failed' } } });
  assert.equal(events.find(e => e.id === 'tests')?.parentId, 'api');
  assert.equal(events.at(-2).type, 'subagent-finished');
  assert.equal(events.at(-1).type, 'subagent-failed');
  tracker.accept({ ...spawn, tool: 'resumeAgent', agentsStates: { api: { status: 'running' } } });
  tracker.accept({ ...spawn, tool: 'closeAgent', agentsStates: { api: { status: 'shutdown' } } });
  assert.equal(events.at(-1).status, 'stopped');
  assert.equal(tracker.has('api'), true);
  assert.equal(tracker.has('unrelated-thread'), false);
});
