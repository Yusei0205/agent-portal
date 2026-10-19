/**
 * Simulated agent. Emits the same message shapes as the Claude Agent SDK (system init,
 * assistant/user messages, subagent messages tagged with parent_tool_use_id, result) and
 * goes through the same approval and AskUserQuestion callbacks, so the whole portal can be
 * tested without an API key. File reads and searches are real; writes happen only after approval.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ContentBlock, DemoContext, ProviderRunOptions, SdkMessage } from './types.ts';
import { keywords, reviewDiff } from './heuristics.ts';
import { estimateCost, tierOf } from './pricing.ts';
import { sleep } from '../util.ts';

const id = (p: string) => `${p}_${randomBytes(8).toString('hex')}`;

function modelId(alias: string): string {
  const t = tierOf(alias);
  return `claude-${t}-5-5`;
}

interface Totals {
  input: number;
  output: number;
  cost: number;
  turns: number;
}

export async function* demoRun(opts: ProviderRunOptions): AsyncIterable<SdkMessage> {
  if (!opts.demo) throw new Error('Demo context missing');
  const d: DemoContext = opts.demo;
  const session = opts.resume || id('demo-session');
  const signal = opts.abort.signal;
  const totals: Totals = { input: 0, output: 0, cost: 0, turns: 0 };
  const mainModel = modelId(opts.model);
  const started = Date.now();

  const pause = async (ms: number) => {
    if (d.speed > 0) await sleep(ms * d.speed);
    if (signal.aborted) throw new DOMException('Run stopped', 'AbortError');
  };

  const assistant = (parent: string | null, content: ContentBlock[], model = mainModel): SdkMessage => {
    const usage = {
      input_tokens: 900 + Math.floor(Math.random() * 2600),
      output_tokens: 80 + Math.floor(Math.random() * 500),
      cache_read_input_tokens: parent ? 0 : 1800,
    };
    totals.input += usage.input_tokens;
    totals.output += usage.output_tokens;
    totals.cost += estimateCost(model, usage);
    totals.turns++;
    return {
      type: 'assistant',
      uuid: id('msg'),
      session_id: session,
      parent_tool_use_id: parent,
      message: { id: id('msg'), role: 'assistant', model, content, usage },
    };
  };

  const toolResult = (parent: string | null, toolUseId: string, content: string, isError = false): SdkMessage => ({
    type: 'user',
    uuid: id('msg'),
    session_id: session,
    parent_tool_use_id: parent,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
  });

  /** Ask for permission the way Claude Code would, then run the tool. */
  async function* tool(
    parent: string | null,
    name: string,
    input: Record<string, unknown>,
    exec: (input: Record<string, unknown>) => string | Promise<string>,
    needsPermission: boolean,
    model = mainModel,
  ): AsyncGenerator<SdkMessage, { ok: boolean; output: string; input: Record<string, unknown> }> {
    const toolId = id('toolu');
    yield assistant(parent, [{ type: 'tool_use', id: toolId, name, input }], model);
    await pause(250);
    const blocked = opts.guard?.(name, input);
    if (blocked) {
      yield toolResult(parent, toolId, blocked, true);
      return { ok: false, output: blocked, input };
    }
    let finalInput = input;
    if (needsPermission) {
      const decision = await opts.canUseTool(name, input, { signal, toolUseID: toolId });
      if (decision.behavior === 'deny') {
        yield toolResult(parent, toolId, decision.message || 'The user denied this action.', true);
        return { ok: false, output: decision.message, input };
      }
      finalInput = decision.updatedInput ?? input;
    }
    try {
      const output = await exec(finalInput);
      yield toolResult(parent, toolId, output);
      await pause(200);
      return { ok: true, output, input: finalInput };
    } catch (e: any) {
      yield toolResult(parent, toolId, `Error: ${e?.message ?? e}`, true);
      return { ok: false, output: String(e?.message ?? e), input: finalInput };
    }
  }

  const grep = (query: string, limit = 6) => {
    const hits = d.search(query, limit);
    if (!hits.length) return 'No matches found.';
    return hits.map((h) => `${h.file}:${h.line}: ${h.snippet}`).join('\n');
  };

  const readRel = (rel: string, maxChars = 1800) => {
    const abs = path.resolve(d.projectDir, rel);
    if (!abs.startsWith(path.resolve(d.projectDir))) throw new Error('Path is outside the project');
    if (!fs.existsSync(abs)) throw new Error(`File does not exist: ${rel}`);
    const text = fs.readFileSync(abs, 'utf8');
    return text.length > maxChars ? text.slice(0, maxChars) + '\n…' : text;
  };

  yield {
    type: 'system',
    subtype: 'init',
    session_id: session,
    model: mainModel,
    cwd: opts.cwd,
    permissionMode: opts.permissionMode,
    tools: opts.tools ?? ['Agent', 'AskUserQuestion', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Skill', 'TodoWrite', 'Write'],
    agents: d.agents.map((a) => a.name),
    skills: d.skills,
    demo: true,
  };
  await pause(300);

  let finalText: string;
  if (d.kind === 'review') {
    finalText = yield* reviewScenario();
  } else {
    finalText = yield* workScenario();
  }

  yield assistant(null, [{ type: 'text', text: finalText }]);
  yield {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: session,
    result: finalText,
    num_turns: totals.turns,
    duration_ms: Date.now() - started,
    // Demo runs cost nothing; the estimate shows what the same run would cost on Claude.
    total_cost_usd: 0,
    estimated_cost_usd: Number(totals.cost.toFixed(4)),
    usage: { input_tokens: totals.input, output_tokens: totals.output },
  };

  /* ---------------------------------------------------------------- */

  async function* reviewScenario(): AsyncGenerator<SdkMessage, string> {
    const diff = opts.prompt.match(/<diff>\n?([\s\S]*?)<\/diff>/)?.[1] ?? '';
    yield assistant(null, [{ type: 'text', text: 'I will read the changed files around each hunk, then check them against the review checklist.' }]);
    await pause(300);
    const files = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((m) => m[2]).slice(0, 4);
    for (const f of files) {
      const rel = path.posix.join(d.writeDirRel, f);
      yield* tool(null, 'Read', { file_path: rel, limit: 80 }, () => {
        try {
          return readRel(rel, 1200);
        } catch {
          return '(file removed in this change)';
        }
      }, false);
    }
    const reviewer = d.agents.find((a) => /review/.test(a.name));
    if (reviewer) {
      const agentId = id('toolu');
      yield assistant(null, [{ type: 'tool_use', id: agentId, name: 'Agent', input: { description: 'Second look at security and tests', prompt: 'Check the diff for security issues and missing tests.', subagent_type: reviewer.name } }]);
      await pause(300);
      yield assistant(agentId, [{ type: 'text', text: 'Checking for hard-coded secrets, injection risks and test coverage.' }], modelId(reviewer.model));
      await pause(400);
      yield toolResult(null, agentId, 'Security and test checks done; findings merged into the main list.');
    }
    const findings = reviewDiff(diff);
    const summary = findings.length
      ? `Found ${findings.length} issue(s): ${['critical', 'high', 'medium', 'low', 'info']
          .map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
          .filter(([, n]) => n)
          .map(([s, n]) => `${n} ${s}`)
          .join(', ')}.`
      : 'No issues found by the checklist.';
    return `${summary}\n\n\`\`\`json\n${JSON.stringify({ summary, findings }, null, 2)}\n\`\`\``;
  }

  async function* workScenario(): AsyncGenerator<SdkMessage, string> {
    const prompt = opts.prompt;
    const userAsk = prompt.split('\n---\n').pop()!.trim();
    const shortAsk = userAsk.replace(/\s+/g, ' ').slice(0, 80);
    const kw = keywords(userAsk, 4);

    yield assistant(null, [{ type: 'text', text: 'I’ll start with the decisions log and the project documents before doing anything else.' }]);
    await pause(300);

    if (d.skills.includes('project-docs')) {
      yield* tool(null, 'Skill', { skill: 'project-docs' }, () => 'Loaded skill: project-docs', false);
    }
    yield* tool(null, 'Read', { file_path: 'docs/decisions.md' }, () => d.decisions.slice(0, 1600) || '(empty)', false);
    const grepOut = (yield* tool(null, 'Grep', { pattern: kw.join('|') || shortAsk, path: 'docs/md' }, () => grep(kw.join(' ') || shortAsk), false)).output;

    // Clarifying questions, unless the decisions log already answers them.
    const approachQ = `Which approach should the team take for: “${shortAsk}”?`;
    let approach = '';
    let chosenRoles: string[] = [];
    const isDesign = /\b(build|design|implement|plan|create|architect|develop|add|migrate|refactor|solution)\b/i.test(userAsk);
    const already = d.decisions.includes(approachQ);
    if (isDesign && !already && d.kind !== 'test') {
      const roleOptions = (d.agents.length ? d.agents : [{ name: 'general-purpose', description: 'General work', model: 'sonnet' }])
        .slice(0, 4)
        .map((a) => ({ label: a.name, description: a.description.slice(0, 80) }));
      const questions = [
        {
          question: approachQ,
          header: 'Approach',
          multiSelect: false,
          options: [
            { label: 'Extend existing code', description: 'Change the current modules; least new code.' },
            { label: 'New module', description: 'Build it alongside the existing code behind a clear interface.' },
            { label: 'Prototype first', description: 'A quick throwaway version to validate the idea.' },
          ],
        },
        ...(roleOptions.length >= 2
          ? [{ question: 'Which roles should work on this?', header: 'Roles', multiSelect: true, options: roleOptions }]
          : []),
      ];
      const r = yield* tool(null, 'AskUserQuestion', { questions }, (input) => {
        const answers = (input.answers ?? {}) as Record<string, string | string[]>;
        const pairs = Object.entries(answers).map(([q, a]) => `"${q}"="${Array.isArray(a) ? a.join(', ') : a}"`);
        return `User has answered your questions: ${pairs.join(', ')}. You can now continue with the user's answers in mind.`;
      }, true);
      if (r.ok) {
        const answers = (r.input.answers ?? {}) as Record<string, string | string[]>;
        const a = answers[approachQ];
        approach = Array.isArray(a) ? a.join(', ') : a ?? '';
        const roles = answers['Which roles should work on this?'];
        chosenRoles = (Array.isArray(roles) ? roles : String(roles ?? '').split(','))
          .map((s) => s.trim())
          .filter((s) => d.agents.some((x) => x.name === s));
      }
    } else if (already) {
      const line = d.decisions.split('\n').find((l, i, arr) => arr[i - 1]?.includes(approachQ) && l.startsWith('**A:**')) ?? '';
      approach = line.replace(/^\*\*A:\*\*\s*/, '');
      yield assistant(null, [{ type: 'text', text: `The decisions log already answers how to approach this (${approach || 'see decisions.md'}), so I won't ask again.` }]);
      await pause(200);
    }

    // Delegate to role subagents.
    let roles = chosenRoles.length ? d.agents.filter((a) => chosenRoles.includes(a.name)) : [];
    const named = d.agents.filter((a) => userAsk.includes(a.name));
    if (!roles.length && named.length) roles = named;
    if (!roles.length) roles = d.agents.slice(0, 2);
    const subagents = roles.length ? roles.slice(0, 3) : [{ name: 'general-purpose', description: 'General-purpose agent', model: 'sonnet' }];

    const calls = subagents.map((a) => ({ a, toolId: id('toolu') }));
    yield assistant(
      null,
      [
        { type: 'text', text: `Delegating to ${calls.map((c) => c.a.name).join(', ')} in parallel.` },
        ...calls.map((c) => ({
          type: 'tool_use',
          id: c.toolId,
          name: 'Agent',
          input: { description: `${c.a.name}: ${shortAsk}`.slice(0, 60), prompt: `${userAsk}\n\nUse the project documents and decisions log. Report concrete findings with sources.`, subagent_type: c.a.name },
        })),
      ],
    );
    await pause(400);

    const reports = new Map<string, string>();
    const steps = calls.map((c) => subagentSteps(c.a, c.toolId, userAsk, kw));
    // Interleave subagent messages so they visibly run side by side.
    let active = steps.map((s) => s[Symbol.asyncIterator]());
    while (active.length) {
      const next: typeof active = [];
      for (const it of active) {
        const r = await it.next();
        if (r.done) {
          reports.set(r.value.name, r.value.report);
        } else {
          yield r.value;
          next.push(it);
        }
      }
      active = next;
      await pause(250);
    }
    for (const c of calls) {
      yield toolResult(null, c.toolId, reports.get(c.a.name) ?? 'Done.');
    }
    await pause(200);

    const plan = renderPlan(shortAsk, approach, calls.map((c) => ({ name: c.a.name, report: reports.get(c.a.name) ?? '' })), grepOut);

    if (opts.permissionMode === 'plan') {
      return `Here is the plan (plan mode, so no files were changed):\n\n${plan}`;
    }
    const target = path.posix.join(d.writeDirRel, 'AGENT_PLAN.md');
    const w = yield* tool(
      null,
      'Write',
      { file_path: target, content: plan },
      (input) => {
        const abs = path.resolve(d.projectDir, String(input.file_path));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(input.content));
        return `File created successfully at: ${input.file_path}`;
      },
      opts.permissionMode !== 'acceptEdits',
    );
    const decisionNote = approach ? `\n- Approach: **${approach}** (saved to the decisions log).` : '';
    return w.ok
      ? `Done. I wrote the plan to \`${target}\`.${decisionNote}\n- Roles consulted: ${calls.map((c) => c.a.name).join(', ')}.\n\n${plan}`
      : `I did not write the file because the write was not approved. Here is the plan instead:${decisionNote}\n\n${plan}`;
  }

  async function* subagentSteps(
    a: { name: string; description: string; model: string },
    parent: string,
    ask: string,
    kw: string[],
  ): AsyncGenerator<SdkMessage, { name: string; report: string }> {
    const model = modelId(a.model);
    const focus = roleFocus(a.name);
    yield assistant(parent, [{ type: 'text', text: `${a.name}: looking for ${focus.lookFor} related to the request.` }], model);
    const query = [...kw, ...focus.terms].join(' ');
    const g = yield* tool(parent, 'Grep', { pattern: [...kw, ...focus.terms].slice(0, 4).join('|'), path: 'docs/md' }, () => grep(query, 4), false, model);
    const firstFile = g.output.match(/^(docs\/md\/[^:]+):(\d+)/m);
    let excerpt = '';
    if (firstFile) {
      const r = yield* tool(parent, 'Read', { file_path: firstFile[1], offset: Number(firstFile[2]), limit: 30 }, () => readRel(firstFile[1], 900), false, model);
      excerpt = r.output;
    }
    const docLines = g.output.split('\n').filter((l) => !l.startsWith('docs/decisions.md'));
    const bullets = !docLines.length || g.output === 'No matches found.'
      ? [`No ${focus.lookFor} found in the documents for “${ask.slice(0, 60)}”. This needs input from the team.`]
      : docLines
          .slice(0, 3)
          .map((l) => {
            const m = l.match(/^(docs\/md\/[^:]+):\d+: (.*)$/);
            return m ? `${m[2].slice(0, 160)} _(source: ${m[1]})_` : l;
          });
    const report = `**${focus.deliverable}**\n${bullets.map((b) => `- ${b}`).join('\n')}${excerpt ? '' : ''}`;
    yield assistant(parent, [{ type: 'text', text: report }], model);
    return { name: a.name, report };
  }
}

function roleFocus(name: string): { lookFor: string; deliverable: string; terms: string[] } {
  const n = name.toLowerCase();
  if (n.includes('analyst')) return { lookFor: 'requirements and business rules', deliverable: 'User stories and acceptance criteria', terms: ['must', 'shall', 'user'] };
  if (n.includes('architect')) return { lookFor: 'components and interfaces', deliverable: 'Design notes', terms: ['service', 'component', 'interface'] };
  if (n.includes('backend')) return { lookFor: 'APIs, data and business logic', deliverable: 'Backend changes', terms: ['api', 'endpoint', 'database'] };
  if (n.includes('frontend')) return { lookFor: 'screens and user flows', deliverable: 'Screen changes', terms: ['screen', 'page', 'button'] };
  if (n.includes('qa') || n.includes('test')) return { lookFor: 'acceptance criteria and edge cases', deliverable: 'Test cases', terms: ['error', 'invalid', 'limit'] };
  if (n.includes('writer') || n.includes('trainer')) return { lookFor: 'terms and flows to explain', deliverable: 'Documentation outline', terms: ['overview', 'process'] };
  if (n.includes('review')) return { lookFor: 'risks and conventions', deliverable: 'Risks', terms: ['security', 'risk'] };
  return { lookFor: 'relevant information', deliverable: 'Findings', terms: [] };
}

function renderPlan(ask: string, approach: string, reports: { name: string; report: string }[], grepOut: string): string {
  const sources = [...new Set([...grepOut.matchAll(/^(docs\/md\/[^:]+):/gm)].map((m) => m[1]))];
  return `# Plan: ${ask}

_Generated by the demo agent on ${new Date().toISOString().slice(0, 10)}._

## Decisions used

- ${approach ? `Approach: ${approach}` : 'No approach decision recorded yet.'}

## Findings by role

${reports.map((r) => `### ${r.name}\n\n${r.report}`).join('\n\n')}

## Next steps

1. Confirm the open points above with the team.
2. Turn the user stories into tickets with acceptance criteria.
3. Implement behind a feature flag, with tests for each acceptance criterion.

## Sources

${sources.length ? sources.map((s) => `- ${s}`).join('\n') : '- No matching documents yet. Upload the FSD and TSD in Knowledge.'}
`;
}

/** Map the run's model alias to the demo's display model. */
export function demoModel(alias: string): string {
  return modelId(alias);
}

export type { DemoContext };
