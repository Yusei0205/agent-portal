import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCursorStreamReader, newCursorStreamState, describeToolCall } from '../server/agent/cursor-stream.ts';

const fixture = (n: number): string => readFileSync(new URL(`./fixtures/cursor/run${n}.ndjson`, import.meta.url), 'utf8');

function replay(text: string, chunk = 0) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const state = newCursorStreamState();
  const reader = createCursorStreamReader(state, (type, payload) => events.push({ type, payload: payload as Record<string, unknown> }));
  if (chunk) for (let i = 0; i < text.length; i += chunk) reader.push(text.slice(i, i + chunk));
  else reader.push(text);
  reader.end();
  return { events, state };
}

describe('cursor stream-json parser', () => {
  it('maps a real read/write/shell turn to portal events', () => {
    const { events, state } = replay(fixture(1));
    const tools = events.filter((e) => e.type === 'tool-start').map((e) => e.payload.toolName);
    assert.deepEqual(tools, ['Read', 'Write', 'Bash']);
    assert.equal(events.filter((e) => e.type === 'tool-end').length, 3);
    assert.equal(state.sessionId, '16432804-1bf5-4201-a4c5-90bfa59d64b7');
    assert.equal(state.finished, true);
    assert.equal(state.isError, false);
    assert.deepEqual(state.usage, { inputTokens: 19030, outputTokens: 263, cacheReadTokens: 7936, cacheWriteTokens: 0, reasoningTokens: 60 });
    const shell = events.find((e) => e.type === 'tool-start' && e.payload.toolName === 'Bash')!;
    assert.deepEqual(JSON.parse(String(shell.payload.toolInput)), { command: 'echo hi' });
    assert.ok(events.some((e) => e.type === 'agent-thought'));
  });

  it('shows streamed text once: the consolidated copy of a message is not repeated', () => {
    const { events, state } = replay(fixture(1));
    const text = events.filter((e) => e.type === 'assistant-text').map((e) => e.payload.text).join('');
    assert.equal(text, state.text);
    assert.equal((text.match(/read `notes\.txt`/gi) ?? []).length, 1);
    assert.match(text, /\n\nRead notes/); // a paragraph break where a tool call came between two pieces of text
  });

  it('gives the same result when stdout arrives in tiny chunks', () => {
    const whole = replay(fixture(1));
    const split = replay(fixture(1), 7);
    assert.deepEqual(split.events, whole.events);
  });

  it('reports a rejected or denied command as tool-blocked, not tool-end', () => {
    const { events } = replay(fixture(5));
    const blocked = events.filter((e) => e.type === 'tool-blocked');
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].payload.toolName, 'Bash');
    assert.match(String(blocked[0].payload.reason), /project permission rules/);
    assert.ok(!events.some((e) => e.type === 'tool-end' && e.payload.toolName === 'Bash'));
  });

  it('passes unrecognised lines to onOther and ignores unknown event types', () => {
    const others: string[] = [];
    const state = newCursorStreamState();
    const reader = createCursorStreamReader(state, () => {}, (l) => others.push(l));
    reader.push('warning: something\n{"type":"future","x":1}\n{broken json\n');
    reader.end();
    assert.deepEqual(others, ['warning: something', '{broken json']);
  });

  it('names an edit of an existing file Edit and an MCP call mcp__server__tool', () => {
    assert.equal(describeToolCall({ tool_call: { editToolCall: { args: { path: '/a', diff: 'x' } } } })!.name, 'Edit');
    assert.equal(describeToolCall({ tool_call: { mcpToolCall: { args: { providerIdentifier: 'jira', toolName: 'search' } } } })!.name, 'mcp__jira__search');
    assert.equal(describeToolCall({ tool_call: { fooBarToolCall: { args: {} } } })!.name, 'FooBar');
  });
});

describe('real-CLI regressions', () => {
  it('shows a short final answer once: the CLI repeats it as a whole message with no timestamp and no call id', () => {
    const { events, state } = replay(fixture(6));
    const text = events.filter((e) => e.type === 'assistant-text').map((e) => e.payload.text).join('');
    assert.equal(text, 'pelican');
    assert.equal(state.text, 'pelican');
    assert.equal(state.resultText, 'pelican');
  });

  it('shows whole messages when the CLI was not asked to stream partial output', () => {
    const state = newCursorStreamState();
    const seen: string[] = [];
    const reader = createCursorStreamReader(state, (t, p) => { if (t === 'assistant-text') seen.push(String((p as { text: string }).text)); });
    reader.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] }, session_id: 's' }) + '\n');
    reader.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] }, session_id: 's' }) + '\n');
    reader.end();
    assert.deepEqual(seen, ['one', 'two']);
  });
});
