/**
 * The Execution View's numbers, derived from a session's run events (pure, no page needed):
 * the agent's task list, every tool call with its state and duration, which tools ran how often, which files were changed.
 *
 * Input: events in time order, where tool calls are already paired (a `tool-start` event with its `tool-end` in `_end`),
 * as SessionLive builds them.
 */

const FILE_WRITING_TOOLS = /^(edit|multiedit|write|notebookedit|str_replace|strreplace|apply_patch|applypatch|create|fs_write|write_file|edit_file)/i;

function toolNameOf(p) { return p?.toolName || p?.tool || p?.name || 'Tool'; }
function inputOf(p) { return p?.toolInput ?? p?.input ?? p?.command ?? p?.path ?? ''; }

/** The file a tool call writes, or ''. Looks at the usual argument names of the engines' edit tools. */
export function fileOfToolCall(name, input) {
  if (!FILE_WRITING_TOOLS.test(String(name).replace(/[\s-]/g, '_'))) return '';
  let obj = input;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { obj = null; } }
  if (!obj || typeof obj !== 'object') return '';
  const f = obj.file_path ?? obj.filePath ?? obj.path ?? obj.file ?? obj.notebook_path ?? '';
  return typeof f === 'string' ? f : '';
}

/** The agent's task list from its latest TodoWrite-style call: { items: [{ text, status }], done, total } or null. */
export function latestTodos(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'tool-start') continue;
    const name = toolNameOf(e.payload);
    if (!/^(todowrite|todo_write|update_plan|updateplan|plan)$/i.test(name.replace(/[\s-]/g, '_'))) continue;
    let input = inputOf(e.payload);
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { continue; } }
    const list = input?.todos ?? input?.plan ?? input?.items;
    if (!Array.isArray(list) || !list.length) continue;
    const items = list.map((t) => {
      const raw = String(t.status ?? '').toLowerCase();
      const status = raw === 'completed' || raw === 'done' ? 'done' : raw === 'in_progress' || raw === 'in-progress' || raw === 'active' ? 'active' : 'pending';
      return { text: String(t.content ?? t.step ?? t.text ?? t.activeForm ?? '').trim(), status };
    }).filter((t) => t.text);
    if (!items.length) continue;
    return { items, done: items.filter((t) => t.status === 'done').length, total: items.length };
  }
  return null;
}

/**
 * Everything the Execution View shows.
 * @returns {{
 *   calls: Array<{ id: string, name: string, preview: string, status: 'running'|'done'|'failed', at: number, durationMs: number|null, file: string }>,
 *   counts: { total: number, running: number, failed: number, done: number },
 *   byTool: Array<{ name: string, count: number, failed: number }>,
 *   files: Array<{ path: string, edits: number }>,
 *   todos: ReturnType<typeof latestTodos>,
 *   startedAt: number|null, lastAt: number|null, elapsedMs: number|null,
 * }}
 */
export function summarizeExecution(events) {
  const calls = [];
  let startedAt = null;
  let lastAt = null;
  for (const e of events) {
    const t = Date.parse(e.created_at);
    if (Number.isFinite(t)) {
      if (startedAt === null || t < startedAt) startedAt = t;
      if (lastAt === null || t > lastAt) lastAt = t;
    }
    if (e.type !== 'tool-start') continue;
    const name = toolNameOf(e.payload);
    const input = inputOf(e.payload);
    const inputStr = typeof input === 'string' ? input : JSON.stringify(input ?? '');
    const end = e._end ?? null;
    const endAt = end ? Date.parse(end.created_at) : NaN;
    const status = !end ? 'running' : end.payload?.status === 'failed' ? 'failed' : 'done';
    calls.push({
      id: String(e.id ?? `${calls.length}`),
      name,
      preview: inputStr && inputStr !== '{}' && inputStr !== '[]' ? inputStr.replace(/\s+/g, ' ').slice(0, 160) : '',
      status,
      at: Number.isFinite(t) ? t : 0,
      durationMs: Number.isFinite(endAt) && Number.isFinite(t) ? Math.max(0, endAt - t) : null,
      file: fileOfToolCall(name, input),
    });
  }
  const counts = { total: calls.length, running: 0, failed: 0, done: 0 };
  const tools = new Map();
  const files = new Map();
  for (const c of calls) {
    counts[c.status] += 1;
    const row = tools.get(c.name) ?? { name: c.name, count: 0, failed: 0 };
    row.count += 1;
    if (c.status === 'failed') row.failed += 1;
    tools.set(c.name, row);
    if (c.file && c.status !== 'failed') files.set(c.file, (files.get(c.file) ?? 0) + 1);
  }
  return {
    calls,
    counts,
    byTool: [...tools.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    files: [...files.entries()].map(([path, edits]) => ({ path, edits })).sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path)),
    todos: latestTodos(events),
    startedAt,
    lastAt,
    elapsedMs: startedAt !== null && lastAt !== null ? lastAt - startedAt : null,
  };
}
