/**
 * Cursor CLI `--output-format stream-json` → portal run events.
 *
 * Pure module (no portal imports) so the same file runs in the local engine and in the AgentCore
 * runner image. Shapes were captured from the real CLI (test/fixtures/cursor/*.ndjson):
 *
 *   system/init                 → session id, model
 *   thinking/delta              → agent-thought {text}
 *   assistant (delta)           → assistant-text {text}.  With --stream-partial-output the CLI sends many
 *                                 tiny deltas (timestamp_ms, no model_call_id) and then one consolidated copy
 *                                 of the same text (model_call_id set): only the deltas are emitted, so the
 *                                 text is not shown twice.  Without partial output there are no deltas and the
 *                                 whole-message events (no timestamp_ms) are emitted instead.
 *   tool_call started/completed → tool-start / tool-end, or tool-blocked when Cursor rejected the call
 *   result                      → usage, final text
 *
 * Tool names are mapped to the Claude-style names the portal UI and tool policy already know
 * (Read, Write, Edit, Bash, Grep, Glob, LS).
 */

export interface CursorUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export type CursorEmit = (type: string, payload: object) => void;

export interface CursorStreamState {
  sessionId: string | null;
  model: string | null;
  /** The assistant's text across the turn (deltas, or whole messages when there are none). */
  text: string;
  /** The `result` event's text: the CLI's own final answer. */
  resultText: string | null;
  usage: CursorUsage | null;
  isError: boolean;
  /** True once a terminal `result` event was seen. */
  finished: boolean;
  /** Deltas were seen, so the consolidated copy of a message is a repeat. */
  sawDelta: boolean;
  /** A tool call came between two pieces of text: start the next piece on a new paragraph. */
  pendingBreak: boolean;
}

type Json = Record<string, unknown>;

const TOOL_NAMES: Record<string, string> = {
  readToolCall: 'Read',
  editToolCall: 'Edit',
  writeToolCall: 'Write',
  deleteToolCall: 'Write',
  shellToolCall: 'Bash',
  grepToolCall: 'Grep',
  globToolCall: 'Glob',
  lsToolCall: 'LS',
  webFetchToolCall: 'WebFetch',
  webSearchToolCall: 'WebSearch',
};

const asObj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The one tool a tool_call event carries: its Cursor key, the portal name, the args and (when completed) the result. */
export function describeToolCall(event: Json): { key: string; name: string; input: Json; result: Json | null } | null {
  const call = asObj(event.tool_call);
  const key = Object.keys(call)[0];
  if (!key) return null;
  const body = asObj(call[key]);
  const args = asObj(body.args);
  const result = body.result === undefined ? null : asObj(body.result);
  let name = TOOL_NAMES[key];
  let input: Json = {};
  if (key === 'readToolCall') input = { file_path: str(args.path) };
  else if (key === 'editToolCall' || key === 'writeToolCall') {
    // A new file arrives with its whole content (streamContent / fileText); an edit of an existing one with a diff.
    const isNew = 'streamContent' in args || 'fileText' in args;
    name = isNew ? 'Write' : 'Edit';
    input = { file_path: str(args.path) };
  } else if (key === 'shellToolCall') input = { command: str(args.command) };
  else if (key === 'function') {
    name = str(asObj(body).name) || 'Tool';
  } else if (name) input = args;
  else {
    // An unlisted tool (MCP, subagent, ...): "fooBarToolCall" → "FooBar"; an MCP call names its server and tool.
    const base = key.replace(/ToolCall$/, '');
    name = args.toolName ? `mcp__${str(args.providerIdentifier || args.server || 'cursor')}__${str(args.toolName)}`
      : base.charAt(0).toUpperCase() + base.slice(1);
    input = args;
  }
  return { key, name: name ?? 'Tool', input, result };
}

function rejection(result: Json | null): string | null {
  if (!result) return null;
  if (result.rejected) return str(asObj(result.rejected).reason) || 'Rejected: the command is not on the allow list for this session';
  if (result.permissionDenied) return 'Denied by the project permission rules';
  return null;
}

function outputOf(result: Json | null): string {
  if (!result) return '';
  const ok = asObj(result.success ?? result.error ?? result);
  const text = str(ok.stdout) || str(ok.content) || str(ok.diffString) || str(ok.message);
  const code = ok.exitCode;
  const head = typeof code === 'number' && code !== 0 ? `exit ${code}\n` : '';
  return (head + text).slice(0, 2_000);
}

export function newCursorStreamState(): CursorStreamState {
  return { sessionId: null, model: null, text: '', resultText: null, usage: null, isError: false, finished: false, sawDelta: false, pendingBreak: false };
}

function handleToolCall(event: Json, emit: CursorEmit): void {
  const d = describeToolCall(event);
  if (!d) return;
  const toolCallId = str(event.call_id);
  if (event.subtype === 'started') {
    emit('tool-start', { toolCallId, toolName: d.name, toolInput: JSON.stringify(d.input), status: 'in_progress' });
  } else if (event.subtype === 'completed') {
    const blocked = rejection(d.result);
    if (blocked) emit('tool-blocked', { toolName: d.name, toolInput: JSON.stringify(d.input), reason: blocked });
    else emit('tool-end', { toolCallId, toolName: d.name, status: 'completed', output: outputOf(d.result) });
  }
}

/** Handle one parsed event; returns nothing and writes to `emit` and `state`. */
export function handleCursorEvent(event: Json, state: CursorStreamState, emit: CursorEmit): void {
  const sid = str(event.session_id);
  if (sid && !state.sessionId) state.sessionId = sid;
  switch (event.type) {
    case 'system': {
      if (event.subtype === 'init') {
        state.model = str(event.model) || state.model;
        emit('status', { state: 'thinking' });
      }
      return;
    }
    case 'thinking': {
      const text = str(event.text);
      if (event.subtype === 'delta' && text) emit('agent-thought', { text });
      return;
    }
    case 'assistant': {
      const parts = asObj(event.message).content;
      const text = Array.isArray(parts) ? parts.map((p) => str(asObj(p).text)).join('') : '';
      if (!text) return;
      const isDelta = event.timestamp_ms !== undefined && event.model_call_id === undefined;
      // Streaming: deltas carry the text, and the CLI then repeats it as whole messages (one before a tool call, with
      // model_call_id; one at the end, with neither field). Once a delta was seen only deltas are shown. Not streaming:
      // only whole messages exist and all of them are shown.
      if (!isDelta && state.sawDelta) return;
      if (isDelta) state.sawDelta = true;
      const out = state.pendingBreak && state.text ? '\n\n' + text : text;
      state.pendingBreak = false;
      state.text += out;
      // Streamed pieces are partial text: `stream: true` tells the session view to join them as they are, not one per line.
      emit('assistant-text', isDelta ? { text: out, stream: true } : { text: out });
      return;
    }
    case 'tool_call': {
      if (event.subtype === 'started') state.pendingBreak = true;
      return handleToolCall(event, emit);
    }
    case 'result': {
      state.finished = true;
      state.isError = event.is_error === true || (event.subtype !== undefined && event.subtype !== 'success');
      state.resultText = str(event.result) || null;
      const u = asObj(event.usage);
      if (event.usage) {
        state.usage = {
          inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens), cacheReadTokens: num(u.cacheReadTokens),
          cacheWriteTokens: num(u.cacheWriteTokens), reasoningTokens: num(u.reasoningTokens),
        };
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Batches the CLI's per-token pieces of text and thought into a few events. Cursor sends one event per token, and every event is
 * stored (a DynamoDB write in the cloud) and pushed to the browser, so a short reply became dozens of writes and some pieces were
 * lost on the way. A batch is sent after `flushMs`, when it reaches `maxChars`, before any other kind of event (so a tool call
 * never overtakes the text before it) and at the end. Anything that is not streamed text passes straight through.
 */
export function createTextCoalescer(emit: CursorEmit, opts: { flushMs?: number; maxChars?: number } = {}) {
  const flushMs = opts.flushMs ?? 120;
  const maxChars = opts.maxChars ?? 800;
  let pending: { type: string; text: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!pending) return;
    const p = pending;
    pending = null;
    emit(p.type, p.type === 'assistant-text' ? { text: p.text, stream: true } : { text: p.text });
  };
  return {
    emit(type: string, payload: object): void {
      const text = (payload as { text?: unknown }).text;
      const streamed = typeof text === 'string' && ((type === 'assistant-text' && (payload as { stream?: unknown }).stream === true) || type === 'agent-thought');
      if (!streamed) { flush(); emit(type, payload); return; }
      if (pending && pending.type !== type) flush();
      if (!pending) pending = { type, text: '' };
      pending.text += text as string;
      if (pending.text.length >= maxChars) flush();
      else if (!timer) { timer = setTimeout(flush, flushMs); timer.unref?.(); }
    },
    flush,
  };
}

/**
 * Line-buffered NDJSON reader. Feed it stdout chunks; it parses each full line and hands the event to
 * handleCursorEvent. A line that is not JSON (a banner, a warning) is passed to `onOther`.
 */
export function createCursorStreamReader(state: CursorStreamState, emit: CursorEmit, onOther?: (line: string) => void) {
  let buf = '';
  const line = (raw: string): void => {
    const s = raw.trim();
    if (!s) return;
    if (s.startsWith('{')) {
      try { handleCursorEvent(JSON.parse(s) as Json, state, emit); return; } catch { /* not an event: fall through */ }
    }
    onOther?.(s);
  };
  return {
    push(chunk: string): void {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); line(l); }
    },
    end(): void { if (buf.trim()) line(buf); buf = ''; },
  };
}
