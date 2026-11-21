// A stand-in for the Cursor CLI (`agent`), used through PORTAL_CURSOR_FAKE. Prints stream-json like the real one
// (shapes copied from test/fixtures/cursor). The prompt arrives on stdin; magic words in it pick the behaviour:
//   ECHO_KEY  answer with the CURSOR_API_KEY environment variable (redaction / scrubbing checks)
//   ECHO_ARGS answer with the command-line arguments as JSON
//   HANG      never finish (cancel test)
//   FAIL      print an error to stderr and exit 1
//   NO_RESULT exit 0 without a result event
//   REJECT    a shell command the CLI rejects
// `--list-models` prints a model table like the real one, with colour codes and zero-width characters.
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2026.11.19-fake'); process.exit(0); }
if (args.includes('--list-models')) {
  console.log('\u001b[1mAvailable models\u001b[0m\n');
  console.log('auto - Auto (default)');
  console.log('composer-2.5 - Composer 2.5');
  console.log('grok-4.7-low-fast - Grok 4.7  Low Fast​​');
  process.exit(0);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let prompt = '';
for await (const c of process.stdin) prompt += c;
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const sid = flag('--resume') || 'fake-session-0001';
out({ type: 'system', subtype: 'init', apiKeySource: process.env.CURSOR_API_KEY || process.env.CURSOR_AUTH_TOKEN ? 'env' : 'login', cwd: process.cwd(), session_id: sid, model: flag('--model') || 'Auto', permissionMode: 'default' });
out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, session_id: sid });
if (prompt.includes('FAIL')) { process.stderr.write('Error: model unavailable\n'); process.exit(1); }
if (prompt.includes('HANG')) { out({ type: 'thinking', subtype: 'delta', text: 'hmm', session_id: sid, timestamp_ms: 1 }); setInterval(() => {}, 1000); await new Promise(() => {}); }
const say = (text, final = false) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: sid, timestamp_ms: 1, ...(final ? { model_call_id: 'm1' } : {}) });
let answer = 'Done.';
if (prompt.includes('ECHO_KEY')) answer = `key=${process.env.CURSOR_API_KEY ?? 'none'};token=${process.env.CURSOR_AUTH_TOKEN ?? 'none'}`;
else if (prompt.includes('ECHO_ARGS')) answer = JSON.stringify(args);
out({ type: 'thinking', subtype: 'delta', text: 'Planning.', session_id: sid, timestamp_ms: 1 });
out({ type: 'thinking', subtype: 'completed', session_id: sid, timestamp_ms: 2 });
say('Working on it.'); say('Working on it.', true);
out({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { readToolCall: { args: { path: 'notes.txt' } } }, session_id: sid });
out({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { readToolCall: { args: { path: 'notes.txt' }, result: { success: { content: 'hi\n', totalLines: 1 } } } }, session_id: sid });
if (prompt.includes('REJECT')) {
  out({ type: 'tool_call', subtype: 'started', call_id: 'c2', tool_call: { shellToolCall: { args: { command: 'git status' } } }, session_id: sid });
  out({ type: 'tool_call', subtype: 'completed', call_id: 'c2', tool_call: { shellToolCall: { args: { command: 'git status' }, result: { rejected: { command: 'git status', reason: '' } } } }, session_id: sid });
}
if (prompt.includes('NO_RESULT')) process.exit(0);
say(answer); say(answer, true);
out({ type: 'result', subtype: 'success', duration_ms: 5, duration_api_ms: 5, is_error: false, result: 'Working on it.' + answer, session_id: sid, request_id: 'r1',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 5 } });
