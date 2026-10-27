/**
 * Demo engine — simulates an agent run without calling any real AI.
 *
 * Produces a realistic sequence of events (thinking, file reads, a file write,
 * a bash command, then completion) in 3-5 seconds total. All tool calls go
 * through the standard guardrails check. Cost is always $0.00.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../util.ts';
import { evaluateCommand } from '../guardrails.ts';
import type { RunContext } from './types.ts';

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run the demo scenario. Emits events via ctx.emit() and respects cancellation.
 * Returns the final result text.
 */
export async function runDemo(ctx: RunContext): Promise<string> {
  const { run, emit, awaitInput, allowAll } = ctx;
  const goal = run.goal;
  const shortGoal = goal.replace(/\s+/g, ' ').slice(0, 80);

  const pause = async (ms: number): Promise<void> => {
    await sleep(ms);
  };

  // 1. Thinking text
  emit('assistant-text', { text: `I'll start by understanding the goal: "${shortGoal}". Let me look at the project structure first.` });
  await pause(400);

  // 2. Read CLAUDE.md
  const claudeMdPath = path.join(run.workDir, 'CLAUDE.md');
  const claudeContent = readFileSafe(claudeMdPath, '(no CLAUDE.md found)');
  const readToolInput = JSON.stringify({ file_path: 'CLAUDE.md', limit: 50 });

  const readDecision = evaluateCommand(
    { command: 'Read CLAUDE.md', category: 'read' },
    run.permissions,
    run.trusted,
  );
  if (readDecision.action === 'block') {
    emit('tool-blocked', { toolName: 'Read', reason: readDecision.reason });
  } else {
    emit('tool-start', { toolName: 'Read', toolInput: readToolInput });
    await pause(300);
    emit('tool-end', { toolName: 'Read', output: claudeContent.slice(0, 500) });
  }

  // 3. Read decisions.md
  const decisionsPath = path.join(run.workDir, 'docs', 'decisions.md');
  const decisionsContent = readFileSafe(decisionsPath, '(empty)');
  emit('tool-start', { toolName: 'Read', toolInput: JSON.stringify({ file_path: 'docs/decisions.md' }) });
  await pause(200);
  emit('tool-end', { toolName: 'Read', output: decisionsContent.slice(0, 300) });

  await pause(300);
  emit('assistant-text', { text: `I understand the project context. Now I'll work on: ${shortGoal}` });
  await pause(400);

  // 4. A bash command (read-only: ls)
  const lsCommand = 'ls -la';
  const lsInput = JSON.stringify({ command: lsCommand });
  const lsDecision = evaluateCommand(
    { command: lsCommand, category: 'bash' },
    run.permissions,
    run.trusted,
  );

  if (lsDecision.action === 'block') {
    emit('tool-blocked', { toolName: 'Bash', toolInput: lsInput, reason: lsDecision.reason });
  } else if (lsDecision.action === 'ask' && !allowAll.has('Bash')) {
    // Request approval
    emit('approval-request', {
      toolName: 'Bash',
      toolInput: lsInput,
      reason: 'This command will list the working directory.',
    });
    const decision = await awaitInput('Bash', lsInput);
    emit('approval-response', { toolName: 'Bash', decision });
    if (decision === 'approve') {
      emit('tool-start', { toolName: 'Bash', toolInput: lsInput });
      await pause(300);
      emit('tool-end', { toolName: 'Bash', output: listWorkDir(run.workDir) });
    }
  } else {
    emit('tool-start', { toolName: 'Bash', toolInput: lsInput });
    await pause(300);
    emit('tool-end', { toolName: 'Bash', output: listWorkDir(run.workDir) });
  }

  await pause(400);

  // 5. Write a plan file
  const planContent = buildPlanContent(goal);
  const planRelPath = 'AGENT_PLAN.md';
  const planAbsPath = path.join(run.workDir, planRelPath);
  const writeInput = JSON.stringify({ file_path: planRelPath, content: planContent });

  const writeDecision = evaluateCommand(
    { command: `Write ${planRelPath}`, category: 'write' },
    run.permissions,
    run.trusted,
  );

  let wroteFile = false;
  if (writeDecision.action === 'block') {
    emit('tool-blocked', { toolName: 'Write', toolInput: writeInput, reason: writeDecision.reason });
  } else if (writeDecision.action === 'ask' && !allowAll.has('Write')) {
    emit('approval-request', {
      toolName: 'Write',
      toolInput: writeInput,
      reason: `Write AGENT_PLAN.md with the action plan.`,
    });
    const decision = await awaitInput('Write', writeInput);
    emit('approval-response', { toolName: 'Write', decision });
    if (decision === 'approve') {
      writeFileSafe(planAbsPath, planContent);
      emit('tool-start', { toolName: 'Write', toolInput: writeInput });
      await pause(350);
      emit('tool-end', { toolName: 'Write', output: `File written: ${planRelPath}` });
      wroteFile = true;
    }
  } else {
    writeFileSafe(planAbsPath, planContent);
    emit('tool-start', { toolName: 'Write', toolInput: writeInput });
    await pause(350);
    emit('tool-end', { toolName: 'Write', output: `File written: ${planRelPath}` });
    wroteFile = true;
  }

  await pause(300);

  // 6. Final summary
  const summary = wroteFile
    ? `Done. I analysed the goal and wrote an action plan to \`${planRelPath}\`.\n\n**Goal:** ${shortGoal}\n\n**Plan written.** Review \`AGENT_PLAN.md\` in the Changes tab and push when ready.`
    : `Done. I analysed the goal: "${shortGoal}".\n\nI could not write the plan file (write not approved). Here is what I would do:\n\n${planContent}`;

  emit('run-complete', { result: summary, cost_usd: 0 });
  return summary;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readFileSafe(filePath: string, fallback: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function writeFileSafe(filePath: string, content: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  } catch {
    // Non-fatal in demo mode
  }
}

function listWorkDir(workDir: string): string {
  try {
    const entries = fs.readdirSync(workDir);
    return entries.join('\n') || '(empty)';
  } catch {
    return '(cannot list directory)';
  }
}

function buildPlanContent(goal: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `# Agent Plan

_Generated by the demo agent on ${date}._

## Goal

${goal}

## Proposed Steps

1. Review the existing codebase and relevant documents.
2. Identify the components that need to change.
3. Implement the changes with tests.
4. Verify the implementation with the project's test suite.
5. Update documentation as needed.

## Notes

This plan was produced by the **Demo engine** — no real AI was called.
Switch to a real provider under **Settings › Model provider** for actual agent runs.
`;
}
