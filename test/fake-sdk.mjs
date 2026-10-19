// A stand-in for @anthropic-ai/claude-agent-sdk that records how the portal calls it.
export function query({ prompt, options }) {
  const call = { options, promptMessages: [], inputClosed: null };
  (globalThis.__fakeSdkCalls ??= []).push(call);

  async function* run() {
    const it = prompt[Symbol.asyncIterator]();
    const first = await it.next();
    call.promptMessages.push(first.value);
    yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-5-5', tools: options.tools ?? [] };

    if (Array.isArray(options.tools) && options.tools.length === 0) {
      yield {
        type: 'assistant',
        session_id: 'sess-1',
        parent_tool_use_id: null,
        message: { id: 'm0', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 20, output_tokens: 2 } },
      };
      yield { type: 'result', subtype: 'success', is_error: false, result: 'OK', total_cost_usd: 0.00001, usage: { input_tokens: 20, output_tokens: 2 }, session_id: 'sess-1' };
    } else {
      const signal = options.abortController.signal;
      await options.hooks.SubagentStart[0].hooks[0]({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'qa-engineer' }, undefined, { signal });
      call.guardOutside = await options.hooks.PreToolUse[0].hooks[0](
        { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/etc/passwd', content: 'x' } },
        't1',
        { signal },
      );
      call.guardRead = await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } }, 't0', { signal });
      call.questionResult = await options.canUseTool(
        'AskUserQuestion',
        { questions: [{ question: 'Which database?', header: 'Database', multiSelect: false, options: [{ label: 'Postgres', description: '' }, { label: 'MySQL', description: '' }] }] },
        { signal, toolUseID: 't2', requestId: 'r1' },
      );
      call.bashResult = await options.canUseTool('Bash', { command: 'npm test' }, { signal, toolUseID: 't3', requestId: 'r2' });
      yield {
        type: 'assistant',
        session_id: 'sess-1',
        parent_tool_use_id: null,
        message: {
          id: 'm1',
          model: 'claude-sonnet-5-5',
          content: [{ type: 'text', text: `Using ${call.questionResult.updatedInput.answers['Which database?']}` }],
          usage: { input_tokens: 1000, output_tokens: 100 },
        },
      };
      yield { type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.0123, usage: { input_tokens: 1000, output_tokens: 100 }, session_id: 'sess-1' };
    }
    const next = await Promise.race([it.next(), new Promise((r) => setTimeout(() => r('timeout'), 2000))]);
    call.inputClosed = next !== 'timeout' && next.done === true;
  }
  return run();
}
