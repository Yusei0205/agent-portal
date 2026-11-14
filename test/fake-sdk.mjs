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

  if (scenario === 'echo-prompt') {
    // Hands the prompt the engine sent back as the reply, so a test can see exactly what the model would have read.
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: `PROMPT<<${typeof prompt === 'string' ? prompt : JSON.stringify(prompt)}>>` }],
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

  if (scenario === 'sdk-session-resume') {
    const resumeId = options?.resume;
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: resumeId ? `Resuming:${resumeId}` : 'New session started.' }],
        usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    };
    yield {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.001,
      num_turns: 1,
      is_error: false,
      result: 'done',
      stop_reason: 'end_turn',
      session_id: 'sdk-session-001',
    };
    return;
  }

  if (scenario === 'sdk-session-resume-fail') {
    const resumeId = options?.resume;
    // Throw an error when asked to resume 'sdk-session-bad'
    if (resumeId === 'sdk-session-bad') {
      throw new Error('Claude Code session not found: ' + resumeId);
    }
    // Otherwise (no resume, or a different session id) succeed normally
    const promptStr = typeof prompt === 'string' ? prompt.slice(0, 60) : '';
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: `New session. Prompt starts: ${promptStr.slice(0, 40)}` }],
        usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    };
    yield {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.001,
      num_turns: 1,
      is_error: false,
      result: 'done',
      stop_reason: 'end_turn',
      session_id: 'sdk-session-002',
    };
    return;
  }

  if (scenario === 'agent-nudge') {    // Emit multiple Agent tool_use blocks to trigger the nudge threshold
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

  // ── approvals scenario ──────────────────────────────────────────────────────
  // Used by approval-binding.test.ts.
  if (scenario === 'approvals') {
    globalThis.__fakeSdkCalls = globalThis.__fakeSdkCalls ?? [];
    const calls = {};
    globalThis.__fakeSdkCalls.push(calls);

    // 1. A Bash command that is exactly 5005 chars (over 4000, under 20 000)
    const longCmd = 'x'.repeat(5000) + ' -v';
    calls.longBash = canUseTool ? await canUseTool('Bash', { command: longCmd }, {}) : { behavior: 'allow' };

    // 2. WebFetch host 1 (should ask, remember=true)
    calls.fetch1 = canUseTool ? await canUseTool('WebFetch', { url: 'https://docs.example.com/a' }, {}) : { behavior: 'allow' };
    // 3. WebFetch same host (should be auto-allowed by remember)
    calls.fetch2 = canUseTool ? await canUseTool('WebFetch', { url: 'https://docs.example.com/b' }, {}) : { behavior: 'allow' };
    // 4. WebFetch different host (should ask again)
    calls.fetch3 = canUseTool ? await canUseTool('WebFetch', { url: 'https://evil.example.net/x' }, {}) : { behavior: 'allow' };
    // 5. Bash command > 20 000 chars (should be auto-denied)
    const hugeCmd = 'y'.repeat(20_001);
    calls.huge = canUseTool ? await canUseTool('Bash', { command: hugeCmd }, {}) : { behavior: 'allow' };

    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Approvals scenario done.' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
    yield { type: 'result', subtype: 'success', total_cost_usd: 0.001, num_turns: 1, is_error: false, result: 'done', stop_reason: 'end_turn' };
    return;
  }

  // ── expiry scenario ──────────────────────────────────────────────────────────
  // Used by approval-binding.test.ts to verify that unanswered approvals expire.
  if (scenario === 'expiry') {
    globalThis.__fakeSdkCalls = globalThis.__fakeSdkCalls ?? [];
    const calls = {};
    globalThis.__fakeSdkCalls.push(calls);

    // Bash — will time out (test sets approvalExpiryMinutes very short)
    const resp = canUseTool ? await canUseTool('Bash', { command: 'ls .' }, {}) : { behavior: 'deny', message: 'none' };
    calls.expiredBash = resp;

    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Expiry scenario done.' }],
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    };
    yield { type: 'result', subtype: 'success', total_cost_usd: 0.001, num_turns: 1, is_error: false, result: 'done', stop_reason: 'end_turn' };
    return;
  }

  // ── budget scenario ──────────────────────────────────────────────────────────
  // Used by run-limits.test.ts. Simulates a run that hits the budget cap.
  if (scenario === 'budget') {
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Starting work...' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    };
    yield {
      type: 'result',
      subtype: 'error_max_budget_usd',
      // Like the real engine: the budget stop is in subtype; stop_reason is the model's own.
      stop_reason: null,
      total_cost_usd: 5.01,
      num_turns: 1,
      is_error: true,
      result: 'Budget cap reached.',
    };
    return;
  }

  // ── spend-then-hang scenario ─────────────────────────────────────────────────
  // Used by run-limits.test.ts. Hangs so the time limit fires.
  if (scenario === 'spend-then-hang') {
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Working...' }],
        usage: { input_tokens: 50, output_tokens: 20 },
      },
    };
    // Hang until aborted — the runner's time-limit timer will abort the SDK.
    await new Promise((_r, _j) => {
      options?.abortController?.signal?.addEventListener('abort', () => _j(new DOMException('Run cancelled', 'AbortError')));
    });
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
    session_id: 'sdk-session-001',
  };
}

// ── sdk-session-resume scenario ───────────────────────────────────────────────
// Used by kiro-session.test.ts to verify Claude Code session ID storage and resume.
// Returns session_id: 'sdk-session-001' in the result.
// If options.resume is set, emits a marker text so the test can verify it.
export async function* _sessionScenario({ options }) {
  const resumeId = options?.resume;
  yield {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: resumeId ? `Resuming:${resumeId}` : 'New session started.' }],
      usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
  yield {
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.001,
    num_turns: 1,
    is_error: false,
    result: 'done',
    stop_reason: 'end_turn',
    session_id: 'sdk-session-001',
  };
}

