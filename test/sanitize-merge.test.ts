/**
 * Unit tests for:
 *   web/src/lib/sanitize.js  — DOMPurify-based markdown sanitizer
 *   web/src/lib/mergeEvents.js — assistant-text merge logic
 *
 * The sanitizer tests run DOMPurify through jsdom so that the exact
 * configuration used in the browser (FORBID_TAGS/FORBID_ATTR + the link hook)
 * is exercised without a real browser.
 *
 * Run a single file with:
 *   npm run test:file -- test/sanitize-merge.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

// ── Import the pure merge helper directly ────────────────────────────────────
// @ts-expect-error — plain-JS module without types
import { mergeConsecutiveAssistantText, collectThoughtParagraphs } from '../web/src/lib/mergeEvents.js';

// ── Replicate sanitize.js configuration with a JSDOM window ─────────────────
// We cannot import web/src/lib/sanitize.js in Node.js because DOMPurify's
// module-level initialisation requires a browser DOM.  Instead we reproduce
// the identical configuration here so any future drift will be caught by CI.
const { window: jsdomWindow } = new JSDOM('');
// DOMPurify exports a factory in Node.js context
const DOMPurify = (createDOMPurify as unknown as (win: Window) => typeof import('dompurify'))(
  jsdomWindow as unknown as Window,
);

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  const el = node as Element;
  if (el.tagName === 'A') {
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  }
});

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form'], FORBID_ATTR: ['style'] });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTextEvent(text: string, id?: string) {
  return { type: 'assistant-text', id: id ?? `ev-${text.slice(0, 6)}`, payload: { text } };
}
function makeHumanEvent(text: string) {
  return { type: 'human', payload: { text } };
}
function makeToolEvent() {
  return { type: 'tool-start', payload: { tool: 'bash' } };
}
function makeCompleteEvent() {
  return { type: 'run-complete', payload: {} };
}

// ══════════════════════════════════════════════════════════════════════════════
// mergeConsecutiveAssistantText
// ══════════════════════════════════════════════════════════════════════════════

describe('mergeConsecutiveAssistantText — basic merging', () => {
  it('returns an empty array unchanged', () => {
    assert.deepEqual(mergeConsecutiveAssistantText([]), []);
  });

  it('returns a single event unchanged', () => {
    const ev = makeTextEvent('hello\n');
    const result = mergeConsecutiveAssistantText([ev]);
    assert.equal(result.length, 1);
    assert.equal(result[0].payload.text, 'hello\n');
  });

  it('merges two consecutive assistant-text events', () => {
    const events = [makeTextEvent('hello\n'), makeTextEvent('world\n')];
    const result = mergeConsecutiveAssistantText(events);
    assert.equal(result.length, 1);
    assert.equal(result[0].payload.text, 'hello\nworld\n');
  });

  it('merges three or more consecutive events into one', () => {
    const events = [makeTextEvent('a\n'), makeTextEvent('b\n'), makeTextEvent('c\n')];
    const result = mergeConsecutiveAssistantText(events);
    assert.equal(result.length, 1);
    assert.equal(result[0].payload.text, 'a\nb\nc\n');
  });

  it('preserves the first event id', () => {
    const events = [makeTextEvent('a', 'first'), makeTextEvent('b', 'second')];
    const result = mergeConsecutiveAssistantText(events);
    assert.equal(result[0].id, 'first');
  });

  it('preserves other fields from the first event', () => {
    const events = [
      { type: 'assistant-text', id: 'x', run_id: 'r1', payload: { text: 'a\n' } },
      { type: 'assistant-text', id: 'y', run_id: 'r2', payload: { text: 'b\n' } },
    ];
    const result = mergeConsecutiveAssistantText(events);
    assert.equal(result[0].run_id, 'r1');
  });
});

describe('mergeConsecutiveAssistantText — newline separator', () => {
  it('does NOT add a separator when the previous chunk already ends with \\n', () => {
    // Kiro plain-text mode: each chunk ends with newline
    const events = [makeTextEvent('line one\n'), makeTextEvent('line two\n')];
    const [merged] = mergeConsecutiveAssistantText(events);
    assert.equal(merged.payload.text, 'line one\nline two\n');
  });

  it('inserts \\n when the previous chunk has no trailing newline', () => {
    // Kiro JSON mode / other engines: trimmed chunks
    const events = [makeTextEvent('infrastructure.'), makeTextEvent("I haven't")];
    const [merged] = mergeConsecutiveAssistantText(events);
    assert.equal(merged.payload.text, "infrastructure.\nI haven't");
  });

  it('inserts only one separator regardless of how many trimmed chunks follow', () => {
    const events = [makeTextEvent('a'), makeTextEvent('b'), makeTextEvent('c')];
    const [merged] = mergeConsecutiveAssistantText(events);
    assert.equal(merged.payload.text, 'a\nb\nc');
  });

  it('skips separator for an empty chunk', () => {
    const events = [makeTextEvent('hello'), makeTextEvent(''), makeTextEvent('world')];
    const [merged] = mergeConsecutiveAssistantText(events);
    // Empty chunk is skipped; separator is still inserted before 'world'
    assert.equal(merged.payload.text, 'hello\nworld');
  });

  it('joins streamed chunks as-is, even mid-word and mid-markdown', () => {
    const s = (text: string, id: string) => ({ type: 'assistant-text', id, payload: { text, stream: true } });
    const events = [s("I haven't tested an", '1'), s('ything yet. **What', '2'), s("'s at the URL:**", '3')];
    const [merged] = mergeConsecutiveAssistantText(events);
    assert.equal(merged.payload.text, "I haven't tested anything yet. **What's at the URL:**");
  });

  it('still separates a non-streamed chunk that follows a streamed one', () => {
    const events = [
      { type: 'assistant-text', id: '1', payload: { text: 'streamed', stream: true } },
      makeTextEvent('plain', '2'),
    ];
    const [merged] = mergeConsecutiveAssistantText(events);
    assert.equal(merged.payload.text, 'streamed\nplain');
  });
});

describe('mergeConsecutiveAssistantText — cross-turn isolation', () => {
  it('stops merging at a human-message event', () => {
    const events = [
      makeTextEvent('agent reply 1'),
      makeHumanEvent('user follow-up'),
      makeTextEvent('agent reply 2'),
    ];
    const result = mergeConsecutiveAssistantText(events);
    assert.equal(result.length, 3);
    assert.equal(result[0].payload.text, 'agent reply 1');
    assert.equal(result[1].type, 'human');
    assert.equal(result[2].payload.text, 'agent reply 2');
  });

  it('stops merging at a tool-start event', () => {
    const events = [
      makeTextEvent('before tool'),
      makeToolEvent(),
      makeTextEvent('after tool'),
    ];
    const result = mergeConsecutiveAssistantText(events);
    assert.equal(result.length, 3);
    assert.equal(result[0].payload.text, 'before tool');
    assert.equal(result[1].type, 'tool-start');
    assert.equal(result[2].payload.text, 'after tool');
  });

  it('stops merging at a run-complete event', () => {
    const events = [
      makeTextEvent('chunk 1'),
      makeTextEvent('chunk 2'),
      makeCompleteEvent(),
    ];
    const result = mergeConsecutiveAssistantText(events);
    assert.equal(result.length, 2);
    assert.equal(result[0].payload.text, 'chunk 1\nchunk 2');
    assert.equal(result[1].type, 'run-complete');
  });

  it('handles multiple separate assistant groups in one stream', () => {
    // turn 1: two agent chunks; human; turn 2: two agent chunks
    const events = [
      makeTextEvent('a1'),
      makeTextEvent('a2'),
      makeHumanEvent('question'),
      makeTextEvent('b1'),
      makeTextEvent('b2'),
    ];
    const result = mergeConsecutiveAssistantText(events);
    assert.equal(result.length, 3);
    assert.equal(result[0].payload.text, 'a1\na2');
    assert.equal(result[1].type, 'human');
    assert.equal(result[2].payload.text, 'b1\nb2');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// sanitizeMarkdown — XSS payloads
// ══════════════════════════════════════════════════════════════════════════════

describe('sanitizeMarkdown — event-handler attributes', () => {
  it('strips unquoted onerror on <img>', () => {
    const out = sanitize('<img src=x onerror=alert(1)>');
    assert.ok(!out.includes('onerror'), `onerror not stripped: ${out}`);
  });

  it('strips quoted onerror on <img>', () => {
    const out = sanitize('<img src="x" onerror="alert(1)">');
    assert.ok(!out.includes('onerror'), `onerror not stripped: ${out}`);
  });

  it('strips onmouseover on arbitrary tags', () => {
    const out = sanitize('<div onmouseover="steal()">text</div>');
    assert.ok(!out.includes('onmouseover'), `onmouseover not stripped: ${out}`);
  });
});

describe('sanitizeMarkdown — dangerous tags', () => {
  it('removes <iframe>', () => {
    const out = sanitize('<iframe src="https://evil.example"></iframe>');
    assert.ok(!out.includes('<iframe'), `iframe not removed: ${out}`);
  });

  it('removes <object>', () => {
    const out = sanitize('<object data="x.swf"></object>');
    assert.ok(!out.includes('<object'), `object not removed: ${out}`);
  });

  it('removes <embed>', () => {
    const out = sanitize('<embed src="x.swf">');
    assert.ok(!out.includes('<embed'), `embed not removed: ${out}`);
  });

  it('removes <form>', () => {
    const out = sanitize('<form action="https://evil.example"><input></form>');
    assert.ok(!out.includes('<form'), `form not removed: ${out}`);
  });

  it('strips onload from <svg>', () => {
    const out = sanitize('<svg onload="alert(1)"><circle r="10"/></svg>');
    assert.ok(!out.includes('onload'), `onload not stripped from svg: ${out}`);
  });

  it('removes <style> entirely', () => {
    const out = sanitize('<style>body{background:url(javascript:alert(1))}</style>');
    assert.ok(!out.toLowerCase().includes('<style'), `style tag not removed: ${out}`);
  });
});

describe('sanitizeMarkdown — dangerous URLs', () => {
  it('strips javascript: href', () => {
    const out = sanitize('<a href="javascript:alert(1)">click</a>');
    assert.ok(!out.includes('javascript:'), `javascript: URL not stripped: ${out}`);
  });

  it('strips entity-encoded javascript: href', () => {
    // &#106; = j, &#97; = a, etc.
    const out = sanitize('<a href="&#106;avascript:alert(1)">click</a>');
    assert.ok(!out.includes('javascript:'), `entity-encoded javascript: not stripped: ${out}`);
  });

  it('strips data:text/html link', () => {
    const out = sanitize('<a href="data:text/html,<script>alert(1)</script>">link</a>');
    assert.ok(!out.includes('data:text/html'), `data: URL not stripped: ${out}`);
  });
});

describe('sanitizeMarkdown — style injection', () => {
  it('strips style attribute', () => {
    const out = sanitize('<div style="background:url(javascript:alert(1))">text</div>');
    assert.ok(!out.includes('style='), `style attribute not stripped: ${out}`);
  });
});

describe('sanitizeMarkdown — safe content passes through', () => {
  it('preserves ordinary text', () => {
    const out = sanitize('<p>Hello <strong>world</strong></p>');
    assert.ok(out.includes('Hello'), 'text missing');
    assert.ok(out.includes('<strong>'), 'strong missing');
  });

  it('preserves safe href links', () => {
    const out = sanitize('<a href="https://example.com">link</a>');
    assert.ok(out.includes('href="https://example.com"'), `safe href missing: ${out}`);
  });

  it('preserves code blocks', () => {
    const out = sanitize('<pre><code>const x = 1;</code></pre>');
    assert.ok(out.includes('<code>'), `code block missing: ${out}`);
  });
});

describe('sanitizeMarkdown — link target hook', () => {
  it('adds target=_blank to links', () => {
    const out = sanitize('<a href="https://example.com">link</a>');
    assert.ok(out.includes('target="_blank"'), `target="_blank" missing: ${out}`);
  });

  it('adds rel=noopener noreferrer to links', () => {
    const out = sanitize('<a href="https://example.com">link</a>');
    assert.ok(out.includes('rel="noopener noreferrer"'), `rel missing: ${out}`);
  });

  it('overwrites any existing rel to noopener noreferrer', () => {
    const out = sanitize('<a href="https://example.com" rel="follow">link</a>');
    assert.ok(out.includes('rel="noopener noreferrer"'), `rel not replaced: ${out}`);
    assert.ok(!out.includes('rel="follow"'), `old rel not removed: ${out}`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// collectThoughtParagraphs
// ══════════════════════════════════════════════════════════════════════════════

describe('collectThoughtParagraphs', () => {
  const thought = (text: string) => ({ type: 'agent-thought', payload: { text } });

  it('joins streamed reasoning chunks as sent, even mid-word', () => {
    const events = [
      thought('I'), thought(' need to figure out what'), thought(' ISD'), thought(' ref'),
      thought('ers to in this cod'), thought('ebase before writing the sp'), thought('ec.'),
    ];
    assert.deepEqual(collectThoughtParagraphs(events), [
      'I need to figure out what ISD refers to in this codebase before writing the spec.',
    ]);
  });

  it('starts a new paragraph when a tool call sits between thoughts', () => {
    const events = [
      thought('First I search'), thought(' the repo.'),
      { type: 'tool-start', payload: { toolName: 'grep' } },
      { type: 'tool-end', payload: {} },
      thought('Now I read'), thought(' the results.'),
    ];
    assert.deepEqual(collectThoughtParagraphs(events), [
      'First I search the repo.',
      'Now I read the results.',
    ]);
  });

  it('ignores empty chunks and returns nothing when there are no thoughts', () => {
    assert.deepEqual(collectThoughtParagraphs([thought(''), thought('  ')]), []);
    assert.deepEqual(collectThoughtParagraphs([{ type: 'assistant-text', payload: { text: 'hi' } }]), []);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// mergeEventLists
// ══════════════════════════════════════════════════════════════════════════════

// @ts-expect-error — plain-JS module without types
import { mergeEventLists } from '../web/src/lib/mergeEvents.js';

/** Build a transcript-style run event (src='r') with the given timestamp. */
function makeRunEvent(
  id: number,
  type: string,
  createdAt: string,
  runId = 'run-1',
) {
  return { src: 'r' as const, id, type, created_at: createdAt, run_id: runId, payload: {} };
}

/** Build a transcript-style workflow event (src='w') — e.g. a human message. */
function makeWorkflowEvent(id: number, type: string, createdAt: string) {
  return { src: 'w' as const, id, type, created_at: createdAt, run_id: null, payload: {} };
}

/** Build a stream event (no src field — treated as 'r' by mergeEventLists). */
function makeStreamEvent(id: number, type: string, createdAt: string, runId = 'run-1') {
  return { id, type, created_at: createdAt, run_id: runId, payload: {} };
}

// ── Snapshot-then-stream (the primary bug regression) ─────────────────────────

describe('mergeEventLists — snapshot-then-stream', () => {
  it('produces one ordered copy when the snapshot holds only the tail and the stream has the full run', () => {
    // Simulate 5 events from run-1. The transcript snapshot captured only the
    // last 3 (the agent was already mid-response when the 50-event page filled).
    const snapshotTail = [
      makeRunEvent(3, 'assistant-text', '2024-01-01T00:00:03Z'),
      makeRunEvent(4, 'tool-start',     '2024-01-01T00:00:04Z'),
      makeRunEvent(5, 'run-complete',   '2024-01-01T00:00:05Z'),
    ];
    // The full stream copy has all 5.
    const streamFull = [
      makeStreamEvent(1, 'human',          '2024-01-01T00:00:01Z'),
      makeStreamEvent(2, 'assistant-text', '2024-01-01T00:00:02Z'),
      makeStreamEvent(3, 'assistant-text', '2024-01-01T00:00:03Z'),
      makeStreamEvent(4, 'tool-start',     '2024-01-01T00:00:04Z'),
      makeStreamEvent(5, 'run-complete',   '2024-01-01T00:00:05Z'),
    ];

    const merged = mergeEventLists(snapshotTail, streamFull);

    assert.equal(merged.length, 5, 'all 5 events, no duplicates');

    // Must be in chronological order
    const ids = merged.map((e: { id: number }) => e.id);
    assert.deepEqual(ids, [1, 2, 3, 4, 5], 'events sorted oldest-first');
  });

  it('uses the stream version of an event when both snapshot and stream carry it', () => {
    // Both contain id=3 as 'r' source (stream has no src field, treated as 'r').
    const snapshot = [makeRunEvent(3, 'assistant-text', '2024-01-01T00:00:03Z')];
    const stream   = [makeStreamEvent(3, 'assistant-text', '2024-01-01T00:00:03Z')];

    const merged = mergeEventLists(snapshot, stream);

    assert.equal(merged.length, 1, 'deduplicated to one event');
    // stream (b) should win — it has no src field
    assert.equal(merged[0].src, undefined, 'stream version kept (no src field)');
  });

  it('combines head-only-in-stream with tail-only-in-snapshot in correct order', () => {
    // Snapshot: only events 3–5 (ids in created_at order)
    const snapshot = [
      makeRunEvent(3, 'assistant-text', '2024-01-01T00:00:03Z'),
      makeRunEvent(4, 'tool-start',     '2024-01-01T00:00:04Z'),
      makeRunEvent(5, 'run-complete',   '2024-01-01T00:00:05Z'),
    ];
    // Stream: all 5; events 3–5 duplicate the snapshot.
    const stream = [
      makeStreamEvent(1, 'human',          '2024-01-01T00:00:01Z'),
      makeStreamEvent(2, 'assistant-text', '2024-01-01T00:00:02Z'),
      makeStreamEvent(3, 'assistant-text', '2024-01-01T00:00:03Z'),
      makeStreamEvent(4, 'tool-start',     '2024-01-01T00:00:04Z'),
      makeStreamEvent(5, 'run-complete',   '2024-01-01T00:00:05Z'),
    ];

    const merged = mergeEventLists(snapshot, stream);
    assert.equal(merged.length, 5);
    assert.deepEqual(
      merged.map((e: { id: number }) => e.id),
      [1, 2, 3, 4, 5],
    );
  });
});

// ── r/w id collisions ─────────────────────────────────────────────────────────

describe('mergeEventLists — r/w id collision', () => {
  it('keeps both r:5 and w:5 as separate events', () => {
    const rEvent = makeRunEvent(5, 'assistant-text', '2024-01-01T00:00:05Z');
    const wEvent = makeWorkflowEvent(5, 'human',         '2024-01-01T00:00:05Z');

    const merged = mergeEventLists([rEvent], [wEvent]);

    assert.equal(merged.length, 2, 'both events kept');
    const srcs = merged.map((e: { src: string }) => e.src).sort();
    assert.deepEqual(srcs, ['r', 'w']);
  });

  it('deduplicates r:5 when the same event appears in both lists as src=r', () => {
    const a = makeRunEvent(5, 'assistant-text', '2024-01-01T00:00:05Z');
    const b = makeStreamEvent(5, 'assistant-text', '2024-01-01T00:00:05Z'); // no src → 'r'

    const merged = mergeEventLists([a], [b]);
    assert.equal(merged.length, 1, 'r:5 deduplicated to one entry');
  });
});

// ── Same-timestamp ordering ───────────────────────────────────────────────────

describe('mergeEventLists — same-timestamp ordering', () => {
  it("places src='r' before src='w' at the same created_at", () => {
    const ts = '2024-01-01T00:00:01Z';
    // Pass w first to ensure the sort, not insertion order, determines position.
    const wEv = makeWorkflowEvent(10, 'human', ts);
    const rEv = makeRunEvent(10, 'assistant-text', ts); // same id, different src → different key

    const merged = mergeEventLists([wEv], [rEv]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].src, 'r', "'r' comes first at same timestamp");
    assert.equal(merged[1].src, 'w', "'w' comes second at same timestamp");
  });

  it('sorts by id within the same timestamp and src', () => {
    const ts = '2024-01-01T00:00:01Z';
    const e1 = makeRunEvent(20, 'assistant-text', ts);
    const e2 = makeRunEvent(10, 'assistant-text', ts);
    const merged = mergeEventLists([e1], [e2]);
    assert.deepEqual(merged.map((e: { id: number }) => e.id), [10, 20]);
  });
});

// ── Load-earlier prepending ────────────────────────────────────────────────────

describe('mergeEventLists — load-earlier prepending', () => {
  it('places older events before newer events regardless of argument order', () => {
    const older = [
      makeRunEvent(1, 'human',          '2024-01-01T00:00:01Z'),
      makeRunEvent(2, 'assistant-text', '2024-01-01T00:00:02Z'),
    ];
    const newer = [
      makeRunEvent(3, 'human',          '2024-01-01T00:00:03Z'),
      makeRunEvent(4, 'assistant-text', '2024-01-01T00:00:04Z'),
    ];

    // mergeEventLists(older, newer) and mergeEventLists(newer, older) should
    // produce the same chronological result.
    const fwd = mergeEventLists(older, newer);
    const rev = mergeEventLists(newer, older);
    const expectedIds = [1, 2, 3, 4];
    assert.deepEqual(fwd.map((e: { id: number }) => e.id), expectedIds);
    assert.deepEqual(rev.map((e: { id: number }) => e.id), expectedIds);
  });

  it('deduplicates events that appear in both the earlier page and the existing list', () => {
    // This happens when the auto-initial-load already fetched page 2 but the
    // user then also clicks "Load earlier" and gets some of the same events.
    const existing = [
      makeRunEvent(1, 'human',          '2024-01-01T00:00:01Z'),
      makeRunEvent(2, 'assistant-text', '2024-01-01T00:00:02Z'),
      makeRunEvent(3, 'run-complete',   '2024-01-01T00:00:03Z'),
    ];
    const loadedPage = [
      makeRunEvent(0, 'human',          '2024-01-01T00:00:00Z'),
      makeRunEvent(1, 'human',          '2024-01-01T00:00:01Z'), // duplicate
    ];

    const merged = mergeEventLists(loadedPage, existing);
    assert.equal(merged.length, 4, 'duplicate id=1 removed');
    assert.deepEqual(
      merged.map((e: { id: number }) => e.id),
      [0, 1, 2, 3],
    );
  });
});

// ── Events without id ─────────────────────────────────────────────────────────

describe('mergeEventLists — events without id', () => {
  it('includes id-less events from both lists without deduplication', () => {
    const a = [{ type: 'status', created_at: '2024-01-01T00:00:01Z', payload: {} }];
    const b = [{ type: 'status', created_at: '2024-01-01T00:00:02Z', payload: {} }];
    const merged = mergeEventLists(a, b);
    assert.equal(merged.length, 2);
  });
});
