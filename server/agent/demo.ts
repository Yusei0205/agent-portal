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
    const blocked = await opts.guard?.(name, input);
    if (blocked) {
      yield toolResult(parent, toolId, blocked, true);
      return { ok: false, output: blocked as string, input };
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

  if (opts.prompt.includes('WORKFLOW_STATUS {')) finalText += '\n\n' + demoWorkflowStatus(opts.prompt);
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
    // A single run is wrapped in the session prompt; what the person asked is its Goal section.
    const goalOfSingleRun = prompt.includes('You are doing a single run (') ? prompt.match(/## Goal\r?\n([\s\S]*?)\r?\n\r?\n## /)?.[1] : undefined;
    const userAsk = (goalOfSingleRun ?? prompt.split('\n---\n').pop()!).trim();
    const shortAsk = userAsk.replace(/\s+/g, ' ').slice(0, 80);
    const kw = keywords(userAsk, 4);

    if (userAsk.startsWith('Architecture diagram request')) return yield* diagramScenario(userAsk);
    if (userAsk.startsWith('Presentation request: ')) return yield* presentationScenario(userAsk);
    if (userAsk.startsWith('Documentation request: ')) return yield* documentationScenario(userAsk);

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

  /**
   * A presentation request (NEW-7): read the source, write a make-doc spec with notes, build the deck, and report the file.
   * Goal markers for tests: [demo-no-deck] saves nothing, [demo-bad-deck] saves a file that is not a deck.
   */
  async function* presentationScenario(ask: string): AsyncGenerator<SdkMessage, string> {
    const kind = ask.match(/^Presentation request: (\w+)/)?.[1] ?? 'topic';
    const title = ask.match(/titled "([^"]*)"/)?.[1] ?? 'Presentation';
    const audience = ask.match(/ for ([^\n]*?)\.\nLength:/)?.[1] ?? '';
    const target = Math.max(3, Math.min(12, Number(ask.match(/about (\d+) slides/)?.[1] ?? 8)));
    const templatePath = ask.match(/"template": "([^"]+)"/)?.[1];
    yield assistant(null, [{ type: 'text', text: 'I will read the source, plan the story, then build the deck with make-doc.' }]);
    await pause(200);

    let material = '';
    let mermaid = '';
    let mermaidCaption = '';
    if (kind === 'document') {
      const mdPath = ask.match(/at (docs\/md\/[^\s]+?\.md)/)?.[1];
      if (mdPath) {
        const r = yield* tool(null, 'Read', { file_path: mdPath, limit: 120 }, () => readRel(mdPath, 6000), false);
        material = r.ok ? r.output : '';
      }
    } else if (kind === 'session') {
      material = ask.match(/<<<RESULT\n([\s\S]*?)\nRESULT>>>/)?.[1] ?? '';
    } else if (kind === 'diagram') {
      const block = ask.match(/<<<DIAGRAM\n([\s\S]*?)DIAGRAM>>>/)?.[1] ?? '';
      mermaid = block.match(/```mermaid\n([\s\S]*?)\n```/)?.[1] ?? '';
      material = block.replace(/```mermaid[\s\S]*?```/, '').trim();
      mermaidCaption = ask.match(/the architecture diagram "([^"]*)"/)?.[1] ?? 'Architecture';
    } else {
      material = ask.match(/<<<TOPIC\n([\s\S]*?)\nTOPIC>>>/)?.[1] ?? '';
      yield* tool(null, 'Grep', { pattern: keywords(material, 3).join('|') || title, path: 'docs/md' }, () => grep(keywords(material, 3).join(' ') || title), false);
    }

    const sentences = material
      .replace(/^#+\s*/gm, '')
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.replace(/[*_`#>|-]+/g, ' ').replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 12)
      .slice(0, 60);
    const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
    const first = (s: string) => clip(s.split(' ').slice(0, 6).join(' '), 50);
    const body = Math.max(1, target - 2 - (mermaid ? 1 : 0));
    const slides: Record<string, unknown>[] = [{ layout: 'title', title, subtitle: audience ? `For ${audience}` : 'Prepared with Agent Portal', notes: `Welcome the audience and state the purpose: ${clip(title, 80)}.` }];
    if (mermaid) slides.push({ title: mermaidCaption, mermaid: { source: mermaid, caption: mermaidCaption }, notes: 'Walk through the diagram from left to right, naming each part once.' });
    for (let i = 0; i < body; i++) {
      const group = sentences.slice(i * 3, i * 3 + 3);
      if (!group.length) break;
      slides.push({ title: first(group[0]), bullets: group.map((g) => clip(g, 90)), notes: `Say it in your own words. Source: ${kind === 'topic' ? 'the requester’s topic' : kind === 'document' ? 'the project document' : kind === 'session' ? 'the session result' : 'the diagram description'}.` });
    }
    if (slides.length < 3) slides.push({ title: 'Summary', bullets: [clip(title, 80), 'Details to be confirmed with the team'], notes: 'Summarise and ask for questions.' });
    slides.push({ title: 'Next steps', bullets: ['Confirm the open points', 'Agree owners and dates', 'Review again after the first results'], notes: 'Close with the decision you need from the audience.' });

    const outRel = `${d.writeDirRel}/presentation.pptx`;
    const specRel = `${d.writeDirRel}/deck.spec.json`;
    const spec = { type: 'pptx', output: outRel, title, ...(templatePath ? { template: templatePath } : {}), slides };
    yield* tool(
      null,
      'Write',
      { file_path: specRel, content: JSON.stringify(spec, null, 2) },
      (input) => {
        const abs = path.resolve(d.projectDir, String(input.file_path));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(input.content));
        return `File created successfully at: ${input.file_path}`;
      },
      true,
    );
    if (ask.includes('[demo-no-deck]')) return 'I planned the deck but could not build it.';
    let warnings: string[] = [];
    const built = yield* tool(
      null,
      'Bash',
      { command: `node dist/make-doc.mjs ${specRel}`, description: 'Build the deck with make-doc' },
      async () => {
        if (ask.includes('[demo-bad-deck]')) {
          const abs = path.resolve(d.projectDir, outRel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, 'this is not a presentation');
          return JSON.stringify({ ok: true, output: abs });
        }
        const { generate } = await import('../docgen.ts');
        const r = await generate(JSON.parse(fs.readFileSync(path.resolve(d.projectDir, specRel), 'utf8')), { baseDir: d.projectDir });
        warnings = r.warnings ?? [];
        return JSON.stringify({ ok: true, ...r });
      },
      true,
    );
    if (!built.ok) return `I could not build the deck: ${built.output}`;
    const titles = slides.map((s, i) => `${i + 1}. ${String(s.title)}`).join('\n');
    return `Presentation: ${outRel}\n${titles}${warnings.length ? `\nWarnings: ${warnings.join(' | ')}` : ''}`;
  }

  /**
   * A documentation request (NEW-6): list the repositories, read the project documents, write Markdown that cites what it
   * found, place the diagram markers, and report the file. Goal markers for tests (put them in the title):
   * [demo-no-doc] saves nothing, [demo-empty-doc] saves a stub, [demo-bad-citation] cites a missing file and a line past
   * the end, [demo-skip-diagram] leaves the diagram markers out, [demo-no-cite] cites nothing.
   */
  async function* documentationScenario(ask: string): AsyncGenerator<SdkMessage, string> {
    const type = ask.match(/^Documentation request: ([\w-]+)/)?.[1] ?? 'overview';
    const title = ask.match(/^Write the [^"\n]*"([^"\n]*)" for /m)?.[1] ?? 'Document';
    const slugs = [...ask.matchAll(/in repos\/([\w.-]+)\//g)].map((m) => m[1]).slice(0, 4);
    const markers = [...ask.matchAll(/\{\{diagram:([\w.-]+)\}\}/g)].map((m) => m[1]);
    const useKnowledge = !ask.includes('do not use docs/md/');
    yield assistant(null, [{ type: 'text', text: 'I will look at the repositories and the project documents, then write the document.' }]);
    const found: { repo: string; file: string }[] = [];
    for (const slug of slugs) {
      yield* tool(
        null,
        'Glob',
        { pattern: `repos/${slug}/*` },
        () => {
          const dir = path.resolve(d.projectDir, 'repos', slug);
          const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n !== '.git' && n !== 'node_modules' && fs.statSync(path.join(dir, n)).isFile()).sort().slice(0, 6) : [];
          for (const n of names) found.push({ repo: slug, file: n });
          return names.map((n) => `repos/${slug}/${n}`).join('\n') || '(empty)';
        },
        false,
      );
    }
    const knowledge: { file: string; heading: string }[] = [];
    if (useKnowledge) {
      const kw = keywords(title, 3);
      const out = (yield* tool(null, 'Grep', { pattern: kw.join('|') || title, path: 'docs/md' }, () => grep(kw.join(' ') || title, 3), false)).output;
      for (const m of out.matchAll(/^(docs\/md\/[^:]+):\d+: (.*)$/gm)) knowledge.push({ file: m[1], heading: m[2].replace(/[`|]/g, '').slice(0, 40).trim() || 'Overview' });
    }

    const cite = (i: number) => (found[i] ? `\`${found[i].repo}/${found[i].file}:1\`` : '');
    const noCite = ask.includes('[demo-no-cite]');
    const sections: Record<string, string[]> = {
      overview: ['Purpose', 'Components', 'Key flows', 'Open questions'],
      architecture: ['Context', 'Components', 'Interfaces and data flow', 'Risks'],
      api: ['Overview', 'Endpoints', 'Errors'],
      runbook: ['Service summary', 'Deploy and roll back', 'Troubleshooting'],
      'user-guide': ['Introduction', 'Getting started', 'Troubleshooting'],
    };
    const lines: string[] = [`# ${title}`, '', `This ${type.replace('-', ' ')} was written from ${slugs.length ? `the repositories ${slugs.join(', ')}` : 'the project documents'}${noCite || !cite(0) ? '' : ` (see ${cite(0)})`}.`, ''];
    (sections[type] ?? sections.overview).forEach((s, si) => {
      lines.push(`## ${s}`, '');
      if (type === 'api' && s === 'Endpoints') {
        lines.push('| Item | Where |', '|---|---|', ...found.slice(0, 4).map((f, i) => `| ${f.file} | ${noCite ? f.repo : cite(i)} |`), '');
      } else if (/Deploy|Getting started/.test(s)) {
        lines.push(...found.slice(0, 3).map((f, i) => `${i + 1}. Check \`${f.file}\`${noCite ? '' : ` (${cite(i)})`}.`), '');
      } else {
        const f = found[si % Math.max(1, found.length)];
        lines.push(f ? `${s} is described by the file ${noCite ? `\`${f.file}\`` : cite(si % found.length)}, which belongs to ${f.repo}.` : `No repository was included, so ${s.toLowerCase()} rests on the project documents.`, '');
        if (!noCite && knowledge[si % Math.max(1, knowledge.length)]) {
          const k = knowledge[si % knowledge.length];
          lines.push(`Related project document: \`${k.file} › ${k.heading}\`.`, '');
        }
      }
      if (si === 1 && markers.length && !ask.includes('[demo-skip-diagram]')) for (const m of markers) lines.push(`{{diagram:${m}}}`, '');
    });
    if (ask.includes('[demo-bad-citation]')) {
      lines.push('## Notes', '', `The retry logic lives in \`${slugs[0] ?? 'repo'}/src/does/not/exist.py:10\`.`, '', found[0] ? `The first file also continues at \`${found[0].repo}/${found[0].file}:99999\`.` : '', '');
    }
    lines.push('Link: [project](https://example.com/docs).', '');
    const md = ask.includes('[demo-empty-doc]') ? '# stub' : lines.join('\n');
    const outRel = `${d.writeDirRel}/document.md`;
    if (ask.includes('[demo-no-doc]')) return 'I looked around but could not write the document.';
    yield* tool(
      null,
      'Write',
      { file_path: outRel, content: md },
      (input) => {
        const abs = path.resolve(d.projectDir, String(input.file_path));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(input.content));
        return `File created successfully at: ${input.file_path}`;
      },
      true,
    );
    return `Document: ${outRel}\n${(sections[type] ?? sections.overview).map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
  }

  /** An architecture diagram request (NEW-1): list the repository folders, then reply with Mermaid and a cited description. */
  async function* diagramScenario(ask: string): AsyncGenerator<SdkMessage, string> {
    const kind = ask.match(/^Architecture diagram request: (\w+)/)?.[1] ?? 'components';
    const title = (ask.match(/Draw the architecture diagram "([^"]*)"/)?.[1] ?? 'Architecture').replace(/[^\w .:,/-]/g, '');
    const slugs = [...ask.matchAll(/in repos\/([\w.-]+)\//g)].map((m) => m[1]).slice(0, 3);
    yield assistant(null, [{ type: 'text', text: 'I will look at the layout of the repository, then draw the diagram.' }]);
    const found: { repo: string; file: string }[] = [];
    for (const slug of slugs) {
      yield* tool(
        null,
        'Glob',
        { pattern: `repos/${slug}/*` },
        () => {
          const dir = path.resolve(d.projectDir, 'repos', slug);
          const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n !== '.git' && n !== 'node_modules').sort().slice(0, 6) : [];
          for (const n of names) found.push({ repo: slug, file: n });
          return names.map((n) => `repos/${slug}/${n}`).join('\n') || '(empty)';
        },
        false,
      );
    }
    const clean = (t: string) => t.replace(/[^\w .-]/g, '');
    const cite = found.slice(0, 3).map((f) => `\`${f.repo}/${f.file}:1\``).join(', ') || 'the repository root';
    const description = `Description: Demo ${kind.replace('_', ' ')} diagram of ${found.length} top-level item(s), based on ${cite}.`;
    if (ask.includes('[demo-no-diagram]')) return 'I looked at the repository but I am not able to draw a diagram for it.';
    if (ask.includes('[demo-invalid-mermaid]')) return '```mermaid\nflowchart LR\n  A[Request] -->\n```\n\n' + description;
    if (ask.includes('[demo-huge-mermaid]')) {
      const lines = Array.from({ length: 1500 }, (_, i) => `  n${i}["Node number ${i} with a long label to fill the space"] --> n${i + 1}`);
      return '```mermaid\nflowchart LR\n' + lines.join('\n') + '\n```\n\n' + description;
    }
    let body: string;
    if (kind === 'data_flow') {
      body = ['sequenceDiagram', '  actor U as User', ...slugs.map((s, i) => `  participant R${i} as ${clean(s)}`), ...slugs.map((s, i) => `  U->>R${i}: request`), ...found.slice(0, 4).map((f) => `  Note over R${Math.max(0, slugs.indexOf(f.repo))}: reads ${clean(f.file)}`)].join('\n');
    } else if (kind === 'system_context') {
      body = ['flowchart LR', '  users(["Users"])', `  system["${clean(title)}"]`, '  users --> system', ...found.slice(0, 6).map((f, i) => `  system --> dep${i}["${clean(f.repo)}/${clean(f.file)}"]`)].join('\n');
    } else {
      body = ['flowchart TB', ...slugs.flatMap((s, si) => [`  subgraph g${si}["${clean(s)}"]`, ...found.filter((f) => f.repo === s).map((f, i) => `    c${si}_${i}["${clean(f.file)}"]`), '  end'])].join('\n');
      if (slugs.length === 0) body = 'flowchart TB\n  empty["No repository"]';
    }
    return '```mermaid\n' + body + '\n```\n\n' + description;
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

/**
 * The status line a demo iteration ends with, so autonomous workflows can be tried without a model. The goal can steer it:
 * [demo-block] reports blocked, [demo-stuck] never finishes, [demo-iterations: N] finishes at iteration N (default 2).
 */
function demoWorkflowStatus(prompt: string): string {
  const n = Number(prompt.match(/This iteration \((\d+) of/)?.[1] ?? 1);
  const goalDone = Number(prompt.match(/\[demo-iterations: (\d+)\]/)?.[1] ?? 2);
  let state = n >= goalDone ? 'done' : 'continue';
  if (prompt.includes('[demo-stuck]')) state = 'continue';
  if (prompt.includes('[demo-block]')) state = 'blocked';
  const summary = prompt.includes('[demo-stuck]') ? 'Still working on it.' : `Demo iteration ${n}: made progress and verified it.`;
  // [demo-delegate: title] hands one task to a separate session, once: when delegating is offered and none exists yet.
  const delegateTitle = prompt.match(/\[demo-delegate: ([^\]]+)\]/)?.[1];
  const delegate = delegateTitle && prompt.includes('"delegate":[') && !prompt.includes('## Delegated sessions') ? [{ title: delegateTitle, goal: `Do the ${delegateTitle} part [demo-iterations: 1]` }] : undefined;
  // [demo-push] asks the portal to push when the work is done, if the session offers it and nobody said not to.
  const push = prompt.includes('[demo-push]') && state === 'done' && prompt.includes('"push":{"message"') && !prompt.includes('Do not push yet') ? { message: 'Demo: refund limit check', pr: false } : undefined;
  return `WORKFLOW_STATUS ${JSON.stringify({ state, summary, next: state === 'continue' ? 'Keep going.' : '', needs: state === 'blocked' ? 'A decision from a person.' : '', branch: prompt.match(/\[demo-branch: ([^\]]+)\]/)?.[1] ?? 'feature/demo-work', ...(delegate ? { delegate } : {}), ...(push ? { push } : {}) })}`;
}
