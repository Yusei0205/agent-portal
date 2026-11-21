import type { RpcParams } from '../codex-client.ts';
import type { CodexSessionContext } from './codex-session.ts';
import { decideToolCall } from './tool-policy.ts';

export const isCodexMcpPrompt = (method: string): boolean =>
  ['mcpServer/elicitation/request', 'item/tool/requestUserInput', 'tool/requestUserInput'].includes(method);

/** Bridge native connector confirmations; never invent answers to arbitrary forms or questions. */
export async function approveCodexMcpPrompt(ctx: CodexSessionContext, method: string, params: RpcParams, items: Map<string, RpcParams>): Promise<unknown> {
  const elicitation = method === 'mcpServer/elicitation/request';
  const cancelled = () => elicitation ? { action: 'cancel', content: null } : { answers: {} };
  if (ctx.signal?.aborted) return cancelled();
  const meta = params._meta && typeof params._meta === 'object' ? params._meta : {};
  const questions: RpcParams[] = Array.isArray(params.questions) ? params.questions : [];
  const schema = params.requestedSchema;
  const isEmptyConfirmation = elicitation && ['form', 'openai/form', 'openaiForm'].includes(params.mode)
    && meta.codex_approval_kind === 'mcp_tool_call' && schema?.type === 'object'
    && schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    && Object.keys(schema.properties).length === 0 && (!schema.required || Array.isArray(schema.required) && !schema.required.length);
  const isChoiceConfirmation = !elicitation && questions.length === 1
    && typeof params.itemId === 'string' && params.itemId.length > 0
    && questions[0].header === 'Approve app tool call?' && !questions[0].isSecret && !questions[0].isOther
    && typeof questions[0].id === 'string' && questions[0].id.length > 0
    && Array.isArray(questions[0].options) && questions[0].options.some((option: RpcParams) => option.label === 'Accept')
    && questions[0].options.some((option: RpcParams) => option.label === 'Cancel');
  if (!isEmptyConfirmation && !isChoiceConfirmation) {
    ctx.emit('status', { text: 'Agent Portal cannot display this Codex form or question yet. The request was cancelled by the portal, not rejected by you.' });
    return cancelled();
  }

  const active = [...items.values()].filter(item => item.type === 'mcpToolCall'
    && ['inProgress', 'in_progress', 'pending'].includes(item.status)
    && (!params.itemId || item.id === params.itemId)
    && (!params.serverName || item.server === params.serverName));
  // Native MCP elicitation may omit turnId and itemId. Only a uniquely identified
  // active call is eligible for trust; never guess between concurrent tools.
  const item = active.length === 1 ? active[0] : null;
  const server = typeof params.serverName === 'string' ? params.serverName : item?.server || 'connector';
  const tool = item?.tool || 'confirmation';
  const toolName = `mcp__${server}__${tool}`;
  const input = JSON.parse(JSON.stringify({ server, tool, arguments: item?.arguments ?? meta.tool_params ?? null,
    description: params.message || questions[0]?.question || 'Connector tool confirmation',
    nativeRequest: { method, ...params } }));
  if (JSON.stringify(input).length > 64000) {
    ctx.emit('tool-blocked', { toolName, reason: 'The connector confirmation is too large to review. Split the request into smaller calls.' });
    return cancelled();
  }
  const policy = decideToolCall({ toolName, input, workDir: ctx.run.workDir, rules: ctx.run.permissions.rules,
    trusted: ctx.run.trusted, allowed: ctx.allowed, planMode: (ctx.run as { planMode?: boolean }).planMode });
  if (policy.action === 'deny') {
    ctx.emit('tool-blocked', { toolName, toolInput: JSON.stringify(input), reason: policy.reason });
    return cancelled();
  }
  const requiresUser = meta.codex_requires_user_input === true || meta.codex_sensitive_action === true || meta.codex_strict_auto_review === true;
  const auto = Boolean(item) && !requiresUser && ctx.run.trusted && policy.action === 'allow';
  if (requiresUser) ctx.emit('status', { text: 'The connector requires confirmation for this action, even with Trust tools enabled. Review the approval in the conversation or Inbox.' });
  if (!item) ctx.emit('status', { text: 'This connector confirmation could not be matched to one active tool call. Review it explicitly; Trust tools cannot auto-answer it.' });
  const answer = auto ? { decision: 'allow' } : await ctx.awaitInput(toolName, input);
  if (ctx.signal?.aborted) return cancelled();
  const accepted = answer.decision === 'allow' && !ctx.signal?.aborted;
  // One-call consent only. Do not silently save a connector-wide or permanent grant.
  return elicitation ? { action: accepted ? 'accept' : 'decline', content: null }
    : { answers: { [questions[0].id]: { answers: [accepted ? 'Accept' : 'Cancel'] } } };
}
