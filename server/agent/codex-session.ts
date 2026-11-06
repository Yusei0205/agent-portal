import path from 'node:path';
import type { CodexClient, RpcParams } from '../codex-client.ts';
import { decideToolCall, type PolicyRule } from './tool-policy.ts';
import type { ChatgptAuthTokens } from '../codex-device-protocol.ts';

export interface CodexSessionContext {
  run: { workDir: string; goal: string; trusted: boolean; model: string | null; engineSessionId: string | null; permissions: { rules: readonly PolicyRule[] } };
  signal: AbortSignal | null;
  emit(type: string, payload: object): void;
  awaitInput(tool: string, input: Record<string, unknown>): Promise<{ decision: 'allow' | 'deny'; remember: boolean; message: string }>;
  allowed: Set<string>;
}

const abortError = () => new DOMException('Run cancelled', 'AbortError');

/** Fail closed for unsupported approval methods and incomplete file-change previews. */
export async function approveCodexRequest(
  ctx: CodexSessionContext, method: string, params: RpcParams, items: Map<string, RpcParams>,
): Promise<unknown> {
  if (ctx.signal?.aborted) return { decision: 'cancel' };
  const fileChange = method === 'item/fileChange/requestApproval';
  if (!fileChange && method !== 'item/commandExecution/requestApproval') {
    throw new Error('Unsupported Codex server request: ' + method);
  }
  const toolName = fileChange ? 'Write' : 'Bash';
  const item = items.get(String(params.itemId)) ?? {};
  const changes: RpcParams[] = Array.isArray(item.changes) ? item.changes : [];
  if (fileChange && !changes.length) return { decision: 'decline' };
  const command = params.command ?? item.command;
  if (!fileChange && (typeof command !== 'string' || !command)) return { decision: 'decline' };
  // Check every path of a patch, not just the first path shown in the approval.
  const inputs: RpcParams[] = fileChange
    ? changes.flatMap(change => [
      { file_path: change.path, diff: change.diff, kind: change.kind },
      ...(change.kind?.move_path ? [{ file_path: change.kind.move_path }] : []),
    ])
    : [{ command, cwd: params.cwd ?? item.cwd, reason: params.reason,
        networkApprovalContext: params.networkApprovalContext, additionalPermissions: params.additionalPermissions }];
  for (const input of inputs) {
    if (fileChange && !input.file_path) return { decision: 'decline' };
    const decision = decideToolCall({ toolName, input, workDir: ctx.run.workDir,
      rules: ctx.run.permissions.rules, trusted: ctx.run.trusted, allowed: ctx.allowed });
    if (decision.action === 'deny') {
      ctx.emit('status', { text: decision.reason });
      return { decision: 'decline' };
    }
  }
  // Native requests can grant access beyond the sandbox. They always need a person.
  const input = fileChange ? { file_path: changes.map(c => c.path).join(', '), changes, reason: params.reason }
    : inputs[0];
  const answer = await ctx.awaitInput(toolName, input);
  return { decision: answer.decision === 'allow' && !ctx.signal?.aborted ? 'accept' : 'decline' };
}

export interface CodexTurnResult { text: string; threadId: string; model: string; inputTokens: number; outputTokens: number; cacheTokens: number }
export interface CodexTurnOptions {
  openClient: () => Promise<CodexClient>;
  managedAuth: boolean;
  prompt?: string;
  onThread?: (id: string) => Promise<void>;
  onUsage?: (usage: Omit<CodexTurnResult, 'text'>) => Promise<void>;
  config?: Record<string, unknown>;
  instructions?: string;
  refreshAuth?: (previousAccountId?: string) => Promise<ChatgptAuthTokens>;
}

/** Shared native Codex protocol driver. No portal database, HTTP, credentials, or AWS dependencies. */
export async function driveCodexTurn(ctx: CodexSessionContext, options: CodexTurnOptions): Promise<CodexTurnResult> {
  const { run, emit, signal } = ctx;
  if (signal?.aborted) throw abortError();
  let client: CodexClient | undefined;
  let threadId = '';
  let turnId = '';
  let model = run.model ?? '';
  let inputTokens = 0, outputTokens = 0, cacheTokens = 0;
  let usageBaseline: RpcParams | null = null;
  const initialUsage = new Map<string, RpcParams>();
  let turnRequested = false;
  const items = new Map<string, RpcParams>();
  const text = new Map<string, string>();
  let resolveTurn: (() => void) | undefined;
  let rejectTurn: ((error: Error) => void) | undefined;
  let abortCleanup: Promise<void> | null = null;
  const completed = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  // Startup can fail before we await this promise.
  void completed.catch(() => {});
  const onAbort = () => {
    rejectTurn?.(abortError());
    const activeClient = client;
    // Give Codex a bounded chance to stop its tools, then kill the transport even if an approval is pending.
    if (activeClient && threadId && turnId) {
      abortCleanup = activeClient.request('turn/interrupt', { threadId, turnId }, 2000)
        .then(() => {}, () => {}).finally(() => activeClient.close());
    } else activeClient?.close();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    client = await options.openClient();
    if (signal?.aborted) throw abortError();
    client.onClose = error => rejectTurn?.(signal?.aborted ? abortError() : error);
    client.onRequest = async (method, params) => {
      if (method === 'account/chatgptAuthTokens/refresh' && options.refreshAuth) return options.refreshAuth(params.previousAccountId);
      if (params.threadId !== threadId || (turnId && params.turnId !== turnId)) throw new Error('Mismatched Codex approval');
      return approveCodexRequest(ctx, method, params, items);
    };
    client.subscribe((method, params) => {
      // A resume can publish usage in the same stdout chunk as its response, before our await resumes.
      if (!threadId && method === 'thread/tokenUsage/updated') {
        initialUsage.set(String(params.threadId), params.tokenUsage?.total ?? {});
        return;
      }
      if (params.threadId !== threadId) return;
      if (method === 'turn/started') turnId = params.turn?.id ?? turnId;
      if (method === 'item/agentMessage/delta') {
        const id = String(params.itemId);
        const delta = String(params.delta ?? '');
        text.set(id, (text.get(id) ?? '') + delta);
        emit('assistant-text', { text: delta, stream: true });
      } else if (method === 'item/started' || method === 'item/completed') {
        const item = params.item ?? {};
        items.set(String(item.id), item);
        if (item.type === 'agentMessage' && method === 'item/completed' && !text.has(String(item.id))) {
          text.set(String(item.id), String(item.text ?? ''));
          emit('assistant-text', { text: String(item.text ?? ''), stream: false });
        }
        const toolName = item.type === 'commandExecution' ? 'Bash' : item.type === 'fileChange' ? 'Write'
          : item.type === 'mcpToolCall' ? String(item.tool) : null;
        if (toolName) {
          const toolInput = item.type === 'commandExecution' ? { command: item.command, cwd: item.cwd }
            : item.type === 'fileChange' ? { changes: item.changes } : item.arguments;
          if (method === 'item/started') emit('tool-start', { toolCallId: item.id, toolName, toolInput: JSON.stringify(toolInput ?? {}) });
          else emit('tool-end', { toolCallId: item.id, toolName, status: item.status,
            output: item.aggregatedOutput ?? JSON.stringify(item.changes ?? item.result ?? '') });
        }
      } else if (method === 'thread/tokenUsage/updated') {
        const usage = params.tokenUsage?.last;
        const total = params.tokenUsage?.total;
        if (!turnRequested || params.turnId !== turnId) { usageBaseline = total ?? null; return; }
        if (usage && total) {
          usageBaseline ??= Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens'].map(k => [k, (total[k] ?? 0) - (usage[k] ?? 0)]));
          inputTokens = Math.max(0, (total.inputTokens ?? 0) - (usageBaseline.inputTokens ?? 0));
          outputTokens = Math.max(0, (total.outputTokens ?? 0) - (usageBaseline.outputTokens ?? 0));
          cacheTokens = Math.max(0, (total.cachedInputTokens ?? 0) - (usageBaseline.cachedInputTokens ?? 0));
        }
      } else if (method === 'turn/completed') {
        const turn = params.turn ?? {};
        if (turn.status === 'completed') resolveTurn?.();
        else if (turn.status === 'interrupted') rejectTurn?.(abortError());
        else rejectTurn?.(new Error(String(turn.error?.message ?? 'Codex turn failed')));
      } else if (method === 'error' && !params.willRetry) {
        // turn/completed is authoritative; report a short, actionable status meanwhile.
        emit('status', { text: String(params.error?.message ?? 'Codex reported an error') });
      }
    });

    if (options.managedAuth) {
      const account = await client.request('account/read', { refreshToken: true });
      if (account.account?.type !== 'chatgpt') throw new Error('Sign in to Codex with ChatGPT in Connect > Agent sign-ins before running Codex.');
    }
    // Native read-only mode asks for file writes. The portal never uses danger-full-access or bypass flags.
    const threadOptions = { cwd: path.resolve(run.workDir), approvalPolicy: 'untrusted', approvalsReviewer: 'user',
      sandbox: run.trusted ? 'workspace-write' : 'read-only', ...(run.model ? { model: run.model } : {}),
      config: { ...options.config, 'sandbox_workspace_write.network_access': false },
      developerInstructions: 'You are running inside Agent Portal. Work only in the current run folder and its repositories. Read AGENTS.md and CLAUDE.md if present for project context. Do not read credentials, change tool configuration, or access other users\' work folders.' + (options.instructions ? '\n\n' + options.instructions : '') };
    const result = await client.request(run.engineSessionId ? 'thread/resume' : 'thread/start',
      { ...threadOptions, ...(run.engineSessionId ? { threadId: run.engineSessionId } : {}) });
    threadId = result.thread.id;
    usageBaseline = initialUsage.get(threadId) ?? usageBaseline;
    model = result.model ?? model;
    await options.onThread?.(threadId);
    emit('status', { text: 'Codex is running with your ChatGPT sign-in. Dollar cost is not reported by Codex.' });
    turnRequested = true;
    await client.request('turn/start', { threadId, input: [{ type: 'text', text: options.prompt ?? run.goal }] });
    await completed;
    if (signal?.aborted) throw abortError();
    const summary = [...text.values()].join('\n').trim() || 'Run complete.';
    return { text: summary, threadId, model, inputTokens, outputTokens, cacheTokens };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await abortCleanup;
    client?.close();
    await client?.waitClosed();
    await options.onUsage?.({ threadId, model, inputTokens, outputTokens, cacheTokens });
  }
}
