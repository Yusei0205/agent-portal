// Fake @anthropic-ai/claude-agent-sdk for portal engine tests
// Scenario is controlled via PORTAL_FAKE_SDK_SCENARIO env var.

// Fake createSdkMcpServer (F7) — returns a minimal McpSdkServerConfigWithInstance
export function createSdkMcpServer(options) {
  return {
    type: 'sdk',
    name: options.name ?? 'fake-sdk-server',
    instance: {},
    tools: options.tools ?? [],
  };
}

// Fake tool() helper (F7)
export function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

export async function* query({ prompt, options }) {
  const scenario = process.env.PORTAL_FAKE_SDK_SCENARIO || 'normal';
  const canUseTool = options?.canUseTool;

  if (scenario === 'home-check') {
    // Emit the HOME value from options.env so the test can verify it was set
    const homeVal = options?.env?.HOME ?? options?.env?.USERPROFILE ?? 'not-set';
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: `HOME=${homeVal}` }],
        usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    };
    yield { type: 'result', subtype: 'success', total_cost_usd: 0.001, num_turns: 1, is_error: false, result: 'done', stop_reason: 'end_turn' };
    return;
  }

  if (scenario === 'abort') {
    // Simulate a slow run so the abort can fire.
    // The abortController is not passed to the fake SDK but the options.abortController is.
    // We just wait and let the engine detect the abort via ctx.signal.
    await new Promise((r) => setTimeout(r, 80));
    return;
  }

  if (scenario === 'write-guard') {
    if (canUseTool) {
      await canUseTool('Write', { file_path: '/etc/passwd' }, { signal: new AbortController().signal });
    }
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Write guard test.' }],
        usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    };
    yield { type: 'result', subtype: 'success', total_cost_usd: 0.001, num_turns: 1, is_error: false, result: 'done', stop_reason: 'end_turn' };
    return;
  }

  if (scenario === 'guardrail-ask') {
    // git push triggers 'ask' in the standard guardrails
    if (canUseTool) {
      await canUseTool('Bash', { command: 'git push origin main' }, { signal: new AbortController().signal });
    }
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Push test.' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
    yield { type: 'result', subtype: 'success', total_cost_usd: 0.002, num_turns: 1, is_error: false, result: 'done', stop_reason: 'end_turn' };
    return;
  }

  if (scenario === 'guardrail-block') {
    // cdk deploy is always blocked
    if (canUseTool) {
      await canUseTool('Bash', { command: 'cdk deploy MyStack' }, { signal: new AbortController().signal });
    }
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Block test.' }],
        usage: { input_tokens: 8, output_tokens: 4 },
      },
    };
    yield { type: 'result', subtype: 'success', total_cost_usd: 0.001, num_turns: 1, is_error: false, result: 'done', stop_reason: 'end_turn' };
    return;
  }

  if (scenario === 'agent-nudge') {
    // Emit multiple Agent tool_use blocks to trigger the nudge threshold
    yield {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Starting sub-agents...' },
          { type: 'tool_use', id: 'tu_agent1', name: 'Agent', input: { description: 'first sub-agent', prompt: 'do something' } },
          { type: 'tool_use', id: 'tu_agent2', name: 'Agent', input: { description: 'second sub-agent', prompt: 'do more' } },
          { type: 'tool_use', id: 'tu_agent3', name: 'Agent', input: { description: 'third sub-agent', prompt: 'even more' } },
        ],
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    };
    yield {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.005,
      num_turns: 1,
      is_error: false,
      result: 'Sub-agents launched.',
      stop_reason: 'end_turn',
    };
    return;
  }

  // Normal scenario: text + tool use + tool result
  const promptStr = typeof prompt === 'string' ? prompt.slice(0, 40) : 'task';
  yield {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'I will help with: ' + promptStr },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'README.md' } },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 30,
      },
    },
  };

  // Simulate tool approval
  if (canUseTool) {
    await canUseTool('Read', { file_path: 'README.md' }, { signal: new AbortController().signal });
  }

  // User message with tool result
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: '# README\nHello.' },
      ],
    },
  };

  yield {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'I have read the README. Task complete.' }],
      usage: {
        input_tokens: 120,
        output_tokens: 15,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 80,
      },
    },
  };

  yield {
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.012,
    num_turns: 2,
    is_error: false,
    result: 'Task done.',
    stop_reason: 'end_turn',
  };
}
