/**
 * Session slash-command support.
 *
 * Exposes a single endpoint:
 *   POST /api/workflows/:id/command   { command: '/model sonnet' }
 *
 * Any signed-in user who can open the session (viewer or above) may run commands.
 * Commands that change settings only take effect from the NEXT iteration; if the
 * session is currently running, the response says so.
 *
 * Every setting change also writes a session-log entry (same "Settings changed by …"
 * style as the PUT /api/workflows/:id route) and an audit record.
 */

import { post } from './http.ts';
import { all, one, run as exec, type Row } from './db.ts';
import { requireProject, getProject } from './projects.ts';
import { badRequest, now, str } from './util.ts';
import { audit, auditRaw } from './audit.ts';
import { requireModel } from './models.ts';
import { leadChoices } from './kiro-agents.ts';
import { engineProvider, effectiveProvider } from './project-aws.ts';
import { listContext } from './session-context.ts';
import { notifyProject } from './projects.ts';
import { isActive, stopRun } from './agent/runner.ts';
import { view as viewWorkflow } from './workflows.ts';
import { getToolPacks, NON_ADMIN_INSTALL_MESSAGE, getInstallJob } from './tool-packs.ts';
import { getIntegration, BUILTIN_BROWSER_ID, BUILTIN_BROWSER_NAME, canUseIntegration } from './integrations.ts';
import { HttpError, parseJson } from './util.ts';

/* ------------------------------------------------------------------ */
/* Helpers shared with workflows.ts (internal, not exported)          */
/* ------------------------------------------------------------------ */

function getWorkflow(id: string): Row {
  const w = one<Row>('SELECT * FROM workflows WHERE id = ?', id);
  if (!w) throw badRequest('Session not found');
  return w;
}

function logEvent(workflowId: string, kind: string, body: string, data: unknown = {}): void {
  exec(
    'INSERT INTO workflow_events (workflow_id, kind, run_id, body, data, consumed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    workflowId,
    kind,
    null,
    body,
    JSON.stringify(data),
    0,
    now(),
  );
  const w = getWorkflow(workflowId);
  // Notify SSE subscribers — same as the workflows.ts notifyProject call.
  notifyProject(w.project_id, 'workflow.updated', { id: workflowId });
}

function patchWorkflow(id: string, p: Record<string, string | number | null>): Row {
  exec(
    `UPDATE workflows SET ${Object.keys(p).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ...Object.values(p),
    now(),
    id,
  );
  const w = getWorkflow(id);
  notifyProject(w.project_id, 'workflow.updated', { id });
  return w;
}

/** True when the session has an active drive() loop in this process. */
function isDriving(workflowId: string): boolean {
  // A session is "driving" (i.e. an iteration may be in progress) when its DB status is 'running'.
  // We use this to determine whether a setting change needs a "deferred" message.
  // The lightweight check is sufficient: the loop itself reads the workflow row fresh each iteration,
  // so any change written to the DB before the next iteration starts will be picked up.
  const w = one<Row>('SELECT status FROM workflows WHERE id = ?', workflowId);
  return w?.status === 'running';
}

/** Is the engine Kiro for this session? */
function isKiro(projectId: string, engine: string | null | undefined): boolean {
  try {
    return engineProvider(projectId, engine || null) === 'kiro';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Option types returned to the UI                                     */
/* ------------------------------------------------------------------ */

export interface CommandOption {
  id: string;
  label: string;
  description: string;
  current: boolean;
}

export interface CommandResult {
  /** Machine-readable type so the UI can render specialised widgets. */
  type: 'text' | 'options' | 'context';
  /** Human-readable reply text (always present). */
  text: string;
  /** Present when type === 'options'; the UI may show a selection popup. */
  options?: CommandOption[];
  /** Present when type === 'context'. */
  context?: ReturnType<typeof listContext>;
  /** True when the change will take effect at the next iteration (session is currently running). */
  deferred?: boolean;
  /** Updated workflow (formatted, same shape as GET /api/workflows/:id) after a setting change. */
  workflow?: ReturnType<typeof viewWorkflow>;
}

/* ------------------------------------------------------------------ */
/* Command implementations                                             */
/* ------------------------------------------------------------------ */

const COMMANDS: { name: string; usage: string; description: string }[] = [
  { name: '/help',              usage: '/help',                      description: 'List all available commands.' },
  { name: '/model',             usage: '/model [id]',                description: 'Show available models, or set the model for the next iteration.' },
  { name: '/agent',             usage: '/agent [name]',              description: 'Show available lead agents, or set the lead agent.' },
  { name: '/engine',            usage: '/engine [claude|kiro]',      description: 'Show engine choices, or switch the session engine.' },
  { name: '/context',           usage: '/context',                   description: 'Show the context items attached to this session.' },
  { name: '/usage',             usage: '/usage',                     description: 'Show iterations and spend vs budget.' },
  { name: '/status',            usage: '/status',                    description: 'Show session status, engine, model, lead agent and work branch.' },
  { name: '/stop',              usage: '/stop',                      description: 'Stop the session (including the run in progress).' },
  { name: '/resume',            usage: '/resume',                    description: 'Resume a stopped or paused session.' },
  { name: '/tools',             usage: '/tools [install uv|kiro]',   description: 'List optional tool packs, or install uv/kiro (admin only).' },
  { name: '/browser',           usage: '/browser on|off',            description: 'Add or remove the shared Web browser integration on this session.' },
  { name: '/aws',               usage: '/aws on|off',                description: 'Add or remove an AWS integration on this session.' },
];

function cmdHelp(): CommandResult {
  const lines = COMMANDS.map((c) => `  ${c.usage.padEnd(26)} ${c.description}`);
  return {
    type: 'text',
    text: `Available commands:\n\n${lines.join('\n')}`,
  };
}

function cmdModel(w: Row, arg: string): CommandResult {
  if (!arg) {
    // Return the list of valid model IDs for the session's provider.
    // The full list is fetched asynchronously by the API; here we return tiers + an
    // indication that the user can paste a full model ID, plus the current value.
    const provider = (() => {
      try { return engineProvider(w.project_id, w.engine || null); } catch { return effectiveProvider(w.project_id); }
    })();

    const tiers: CommandOption[] = [
      { id: 'haiku',  label: 'Haiku',  description: 'Fastest and cheapest.', current: w.model === 'haiku' },
      { id: 'sonnet', label: 'Sonnet', description: 'Balanced speed and quality.', current: !w.model || w.model === 'sonnet' },
      { id: 'opus',   label: 'Opus',   description: 'Highest capability.', current: w.model === 'opus' },
    ];
    // Mark the current model if it is a full ID (not a tier).
    const isFullId = w.model && !['haiku', 'sonnet', 'opus'].includes(w.model);
    const options: CommandOption[] = isFullId
      ? [{ id: w.model, label: w.model, description: '(current full model ID)', current: true }, ...tiers.map((t) => ({ ...t, current: false }))]
      : tiers;

    const currentLabel = w.model || 'sonnet';
    return {
      type: 'options',
      text: `Provider: ${provider}. Current model: ${currentLabel}.\n\nUse \`/model <id>\` to change. You can also use a full model ID (e.g. \`us.anthropic.claude-sonnet-4-5-20250929-v1:0\`).`,
      options,
    };
  }

  // Validate and set.
  const model = requireModel(arg);
  const current = w.model || 'sonnet';
  if (model === current) return { type: 'text', text: `Model is already set to "${model}". No change.` };

  const running = isDriving(w.id);
  patchWorkflow(w.id, { model });
  logEvent(w.id, 'system', `Settings changed by command: model set to "${model}"`);

  return {
    type: 'text',
    text: running
      ? `Model set to "${model}". This will take effect at the next iteration (the session is currently running).`
      : `Model set to "${model}".`,
    deferred: running,
    workflow: viewWorkflow(getWorkflow(w.id)),
  };
}

function cmdAgent(w: Row, arg: string, ctx: { userId: string; userName: string }): CommandResult {
  const project = getProject(w.project_id);
  const kiro = isKiro(w.project_id, w.engine);
  const choices = leadChoices(project, kiro);

  if (!arg) {
    // Return the selectable lead agents plus a "default / none" option.
    const options: CommandOption[] = [
      { id: '', label: '(default / none)', description: "Use the portal's default main agent.", current: !w.lead_agent },
      ...choices.map((c) => ({
        id: c.name,
        label: c.name,
        description: c.description || `(${c.kind} agent)`,
        current: w.lead_agent === c.name,
      })),
    ];
    const currentLabel = w.lead_agent || '(default / none)';
    return {
      type: 'options',
      text: `Current lead agent: ${currentLabel}. These are the project's own agents.\n\nUse \`/agent <name>\` to change, or \`/agent none\` to clear.`,
      options,
    };
  }

  // Treat "none" or "default" as clear.
  const name = arg === 'none' || arg === 'default' ? '' : arg;

  if (name) {
    // Validate: must be in the project's own agent choices for this engine.
    if (!choices.some((c) => c.name === name)) {
      const kind = choices[0]?.kind === 'kiro' ? 'Kiro agent' : 'agent';
      throw badRequest(
        `"${name}" is not an enabled ${kind} in this project. ` +
        `Available: ${choices.map((c) => c.name).join(', ') || '(none)'}. ` +
        `Use \`/agent\` with no argument to see the list.`,
      );
    }
  }

  const current = w.lead_agent || '';
  if (name === current) {
    return { type: 'text', text: name ? `Lead agent is already "${name}". No change.` : 'Lead agent is already cleared. No change.' };
  }

  const running = isDriving(w.id);
  patchWorkflow(w.id, { lead_agent: name });
  logEvent(w.id, 'system', name ? `Settings changed by command: lead agent set to "${name}"` : 'Settings changed by command: lead agent cleared');

  const msg = name
    ? `Lead agent set to "${name}".`
    : "Lead agent cleared; the portal's default agent will lead.";
  return {
    type: 'text',
    text: running ? `${msg} This will take effect at the next iteration (the session is currently running).` : msg,
    deferred: running,
    workflow: viewWorkflow(getWorkflow(w.id)),
  };
}

function cmdEngine(w: Row, arg: string, ctx: { userId: string; userName: string }): CommandResult {
  if (!arg) {
    // Return engine choices.
    const currentEngine = w.engine || '';
    const options: CommandOption[] = [
      { id: '',       label: '(project default)',  description: 'Use whatever provider the project is configured with.', current: currentEngine === '' },
      { id: 'claude', label: 'Claude Code',        description: 'Anthropic Claude Code or Amazon Bedrock.', current: currentEngine === 'claude' },
      { id: 'kiro',   label: 'Kiro',              description: 'AWS Kiro engine.',                         current: currentEngine === 'kiro' },
    ];
    const currentLabel = currentEngine || '(project default)';
    return {
      type: 'options',
      text: `Current engine: ${currentLabel}.\n\nUse \`/engine claude\` or \`/engine kiro\` to change, or \`/engine default\` to use the project default.`,
      options,
    };
  }

  // Normalise.
  const engine = arg === 'default' ? '' : arg;

  // Validate.
  if (engine !== '' && engine !== 'claude' && engine !== 'kiro') {
    throw badRequest(`Unknown engine "${arg}". Valid choices: claude, kiro, default. Use \`/engine\` with no argument to see options.`);
  }

  // Check the new engine is usable for this project.
  if (engine) {
    try {
      engineProvider(w.project_id, engine);
    } catch (e: any) {
      throw badRequest(`Cannot switch to engine "${engine}": ${String(e?.message ?? e)}`);
    }
  }

  const current = w.engine || '';
  if (engine === current) {
    const label = engine || '(project default)';
    return { type: 'text', text: `Engine is already "${label}". No change.` };
  }

  // Check whether the existing lead agent is still valid on the new engine.
  let leadWarning = '';
  if (w.lead_agent) {
    const project = getProject(w.project_id);
    const newKiro = isKiro(w.project_id, engine || null);
    const newChoices = leadChoices(project, newKiro);
    if (!newChoices.some((c) => c.name === w.lead_agent)) {
      leadWarning =
        `\n\n⚠ The current lead agent "${w.lead_agent}" is not available on the "${engine || 'project default'}" engine. ` +
        `It will be ignored until you set a valid agent with \`/agent\`.`;
    }
  }

  const running = isDriving(w.id);
  patchWorkflow(w.id, { engine });
  const label = engine || '(project default)';
  logEvent(w.id, 'system', `Settings changed by command: engine set to "${label}"`);

  const baseMsg = `Engine set to "${label}".`;
  return {
    type: 'text',
    text: running
      ? `${baseMsg} This will take effect at the next iteration (the session is currently running).${leadWarning}`
      : `${baseMsg}${leadWarning}`,
    deferred: running,
    workflow: viewWorkflow(getWorkflow(w.id)),
  };
}

function cmdContext(w: Row): CommandResult {
  const items = listContext(w.id);
  if (!items.length) {
    return { type: 'context', text: 'This session has no context items.', context: [] };
  }
  const lines = items.map((c) => `  [${c.kind}] ${c.title}${c.path ? ` (${c.path})` : ''}`);
  return {
    type: 'context',
    text: `Context items (${items.length}):\n\n${lines.join('\n')}`,
    context: items,
  };
}

function cmdUsage(w: Row): CommandResult {
  const iterUsed = Number(w.iteration ?? 0);
  const iterMax = Number(w.max_iterations ?? 8);
  const burstStart = Number(w.burst_start ?? 0);
  const burstUsed = iterUsed - burstStart;

  const engine = (() => { try { return engineProvider(w.project_id, w.engine || null); } catch { return effectiveProvider(w.project_id); } })();
  const isKiroSession = engine === 'kiro';

  let costLine: string;
  if (isKiroSession) {
    const creditsUsed = Number(w.spent_credits ?? 0);
    const creditsBudget = Number(w.budget_credits ?? 20);
    costLine = `Kiro credits: ${creditsUsed.toFixed(2)} of ${creditsBudget} used (${Math.round((creditsUsed / creditsBudget) * 100)}%).`;
  } else {
    const spentUsd = Number(w.spent_usd ?? 0);
    const budgetUsd = Number(w.budget_usd ?? 5);
    costLine = `Spend: $${spentUsd.toFixed(4)} of $${budgetUsd.toFixed(2)} (${Math.round((spentUsd / budgetUsd) * 100)}%).`;
  }

  const lines = [
    `Iterations: ${iterUsed} total; ${burstUsed} of ${iterMax} in the current burst.`,
    costLine,
  ];

  return { type: 'text', text: lines.join('\n') };
}

function cmdStatus(w: Row): CommandResult {
  const engine = (() => { try { return engineProvider(w.project_id, w.engine || null); } catch { return effectiveProvider(w.project_id); } })();
  const lines = [
    `Status:      ${w.status}${w.stop_reason ? ` — ${String(w.stop_reason).slice(0, 120)}` : ''}`,
    `Engine:      ${w.engine || '(project default)'} → ${engine}`,
    `Model:       ${w.model || 'sonnet'}`,
    `Lead agent:  ${w.lead_agent || '(none / default)'}`,
    `Work branch: ${w.work_branch || '(none yet)'}`,
    `Iteration:   ${Number(w.iteration ?? 0)} total`,
  ];
  return { type: 'text', text: lines.join('\n') };
}

function cmdStop(w: Row, ctx: { userId: string; userName: string }): CommandResult {
  const OPEN = ['running', 'queued'];
  if (!OPEN.includes(w.status) && !isDriving(w.id)) {
    return { type: 'text', text: `The session is already ${w.status}. Nothing to stop.` };
  }
  // Mirror the POST /api/workflows/:id/stop route logic (inline to avoid circular import).
  exec(
    "UPDATE workflows SET status = 'stopped', stop_reason = ?, updated_at = ? WHERE id = ?",
    `Stopped by ${ctx.userName} (via /stop command).`,
    now(),
    w.id,
  );
  exec(
    'INSERT INTO workflow_events (workflow_id, kind, run_id, body, data, consumed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    w.id, 'status', null, `stopped: Stopped by ${ctx.userName} (via /stop command).`, '{}', 0, now(),
  );
  notifyProject(w.project_id, 'workflow.updated', { id: w.id });
  // Stop the active run if there is one.
  const lastRunId = w.last_run_id;
  if (lastRunId) {
    try {
      if (isActive(String(lastRunId))) stopRun(String(lastRunId));
    } catch { /* best effort */ }
  }
  return {
    type: 'text',
    text: `Session stopped.`,
    workflow: viewWorkflow(getWorkflow(w.id)),
  };
}

function cmdResume(w: Row, ctx: { userId: string; userName: string }): CommandResult {
  const REOPENABLE = ['done', 'blocked', 'paused', 'stopped', 'failed'];
  if (!REOPENABLE.includes(w.status)) {
    if (w.status === 'running') return { type: 'text', text: 'The session is already running.' };
    return { type: 'text', text: `The session is ${w.status} and cannot be resumed with this command.` };
  }
  // Budget check.
  const spentUsd = Number(w.spent_usd ?? 0);
  const budgetUsd = Number(w.budget_usd ?? 5);
  if (spentUsd >= budgetUsd) {
    throw badRequest('This session has used its budget. Raise the budget first (PUT /api/workflows/:id with budgetUsd), then resume.');
  }
  exec(
    "UPDATE workflows SET status = 'running', stop_reason = '', burst_start = ?, waiting_children = 0, pending_push = '', updated_at = ? WHERE id = ?",
    w.iteration,
    now(),
    w.id,
  );
  exec(
    'INSERT INTO workflow_events (workflow_id, kind, run_id, body, data, consumed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    w.id, 'status', null, 'Resumed (via /resume command)', '{}', 0, now(),
  );
  notifyProject(w.project_id, 'workflow.updated', { id: w.id });
  // Kick the drive loop — import dynamically to avoid circular dependency.
  import('./workflows.ts').then(({ kick }) => kick(w.id)).catch(() => {});
  return {
    type: 'text',
    text: 'Session resumed.',
    workflow: viewWorkflow(getWorkflow(w.id)),
  };
}

/* ------------------------------------------------------------------ */
/* /tools                                                              */
/* ------------------------------------------------------------------ */

async function cmdTools(w: Row, arg: string, ctx: { userId: string; userName: string; isAdmin: boolean }): Promise<CommandResult> {
  // '/tools install <id>' — admin-only installation trigger.
  if (arg.startsWith('install ')) {
    const packId = arg.slice('install '.length).trim();
    if (packId !== 'uv' && packId !== 'kiro') {
      throw badRequest(`Unknown pack "${packId}". Use: /tools install uv  or  /tools install kiro`);
    }
    if (!ctx.isAdmin) {
      throw new HttpError(403, NON_ADMIN_INSTALL_MESSAGE);
    }
    const existing = getInstallJob(packId);
    if (existing && (existing.status === 'pending' || existing.status === 'running')) {
      return { type: 'text', text: `An install of "${packId}" is already in progress. Use GET /api/tools/${packId}/install to check progress.` };
    }
    // Redirect the admin to use the API endpoint — /tools install only triggers via the HTTP API
    // so the background job gets its actorId/IP from the HTTP request context.
    return {
      type: 'text',
      text: `To install ${packId}, POST to /api/tools/${packId}/install (Settings › Tools in the UI). This command can only queue installs through the HTTP API.`,
    };
  }

  // '/tools' — list each pack with status, whether it's on for this session.
  const packs = await getToolPacks();
  const sessionIntegrations = parseJson<string[]>(w.integrations, []);

  const lines: string[] = ['Optional tool packs:\n'];
  for (const p of packs) {
    const icon = p.status === 'available' ? '✓' : p.status === 'missing' ? '✗' : '—';
    // Determine if this pack's integration is on for this session.
    let sessionStatus = '';
    if (p.id === 'browser') {
      const on = sessionIntegrations.includes(BUILTIN_BROWSER_ID);
      sessionStatus = on ? ' [on for this session]' : '';
    }
    const hintText = p.status !== 'available' ? `  → ${p.hint}` : '';
    lines.push(`  ${icon} ${p.label} (${p.status})${sessionStatus}  — ${p.neededBy}${hintText}`);
  }
  if (!ctx.isAdmin) {
    lines.push('\n(Admins can install uv and kiro with /tools install <id>)');
  } else {
    lines.push('\nUse /tools install uv  or  /tools install kiro to install.');
  }
  return { type: 'text', text: lines.join('\n') };
}

/* ------------------------------------------------------------------ */
/* /browser on|off                                                     */
/* ------------------------------------------------------------------ */

async function cmdBrowser(w: Row, arg: string, ctx: { userId: string; userName: string; isAdmin: boolean }): Promise<CommandResult> {
  if (arg !== 'on' && arg !== 'off') {
    throw badRequest('Usage: /browser on   or   /browser off');
  }

  // Check browser pack availability.
  const packs = await getToolPacks();
  const browserPack = packs.find((p) => p.id === 'browser');
  if (arg === 'on' && browserPack && browserPack.status !== 'available') {
    throw badRequest(browserPack.hint);
  }

  // Find the built-in browser integration.
  const browserInteg = getIntegration(BUILTIN_BROWSER_ID);
  if (arg === 'on' && !browserInteg) {
    throw badRequest('The Web browser integration is not available yet. It is created automatically when the browser pack becomes available.');
  }

  const sessionIntegrations = parseJson<string[]>(w.integrations, []);
  const alreadyOn = browserInteg ? sessionIntegrations.includes(BUILTIN_BROWSER_ID) : false;

  if (arg === 'on' && alreadyOn) {
    return { type: 'text', text: 'The Web browser is already on for this session. No change.' };
  }
  if (arg === 'off' && !alreadyOn) {
    return { type: 'text', text: 'The Web browser is already off for this session. No change.' };
  }

  // Update the session's integrations list.
  let newIntegrations: string[];
  if (arg === 'on') {
    newIntegrations = [...new Set([...sessionIntegrations, BUILTIN_BROWSER_ID])];
  } else {
    newIntegrations = sessionIntegrations.filter((id) => id !== BUILTIN_BROWSER_ID);
  }

  const running = isDriving(w.id);
  exec('UPDATE workflows SET integrations = ?, updated_at = ? WHERE id = ?', JSON.stringify(newIntegrations), now(), w.id);
  const updated = getWorkflow(w.id);
  notifyProject(updated.project_id, 'workflow.updated', { id: w.id });

  const verb = arg === 'on' ? 'added' : 'removed';
  logEvent(w.id, 'system', `Settings changed by command: Web browser integration ${verb} by ${ctx.userName}`);
  audit_session(ctx.userId, w, `browser_integration_${arg}`);

  const msg = arg === 'on'
    ? `Web browser integration added.${running ? ' It will be available from the next iteration.' : ''}`
    : `Web browser integration removed.${running ? ' This takes effect from the next iteration.' : ''}`;

  return {
    type: 'text',
    text: msg,
    deferred: running,
    workflow: viewWorkflow(getWorkflow(w.id)),
  };
}

/* ------------------------------------------------------------------ */
/* /aws on|off                                                         */
/* ------------------------------------------------------------------ */

async function cmdAws(w: Row, arg: string, ctx: { userId: string; userName: string; isAdmin: boolean }): Promise<CommandResult> {
  if (arg !== 'on' && arg !== 'off') {
    throw badRequest('Usage: /aws on   or   /aws off');
  }

  // Check uv pack availability (aws integration needs uvx).
  const packs = await getToolPacks();
  const uvPack = packs.find((p) => p.id === 'uv');
  if (arg === 'on' && uvPack && uvPack.status !== 'available') {
    throw badRequest(uvPack.hint);
  }

  // Find a usable AWS integration for this user (team or own, kind='aws').
  const awsIntegrations = all<Row>(
    "SELECT * FROM integrations WHERE kind = 'aws' AND (scope = 'team' OR owner_id = ?)",
    ctx.userId,
  );

  if (arg === 'on' && awsIntegrations.length === 0) {
    throw badRequest('No AWS integration is available. Set one up under Integrations, then use /aws on.');
  }

  const sessionIntegrations = parseJson<string[]>(w.integrations, []);
  const awsIds = awsIntegrations.map((i) => i.id);
  const currentAwsIds = sessionIntegrations.filter((id) => awsIds.includes(id));
  const alreadyOn = currentAwsIds.length > 0;

  if (arg === 'on' && alreadyOn) {
    return { type: 'text', text: `AWS integration is already on for this session (${awsIntegrations.find((i) => i.id === currentAwsIds[0])?.name ?? currentAwsIds[0]}). No change.` };
  }
  if (arg === 'off' && !alreadyOn) {
    return { type: 'text', text: 'No AWS integration is on for this session. No change.' };
  }

  let newIntegrations: string[];
  if (arg === 'on') {
    // Add the first available AWS integration.
    const toAdd = awsIntegrations[0];
    newIntegrations = [...new Set([...sessionIntegrations, toAdd.id])];
    const running = isDriving(w.id);
    exec('UPDATE workflows SET integrations = ?, updated_at = ? WHERE id = ?', JSON.stringify(newIntegrations), now(), w.id);
    const updated = getWorkflow(w.id);
    notifyProject(updated.project_id, 'workflow.updated', { id: w.id });
    logEvent(w.id, 'system', `Settings changed by command: AWS integration "${toAdd.name}" added by ${ctx.userName}`);
    audit_session(ctx.userId, w, 'aws_integration_on');
    return {
      type: 'text',
      text: `AWS integration "${toAdd.name}" added.${running ? ' It will be available from the next iteration.' : ''}`,
      deferred: running,
      workflow: viewWorkflow(getWorkflow(w.id)),
    };
  } else {
    // Remove all AWS integrations.
    newIntegrations = sessionIntegrations.filter((id) => !awsIds.includes(id));
    const running = isDriving(w.id);
    exec('UPDATE workflows SET integrations = ?, updated_at = ? WHERE id = ?', JSON.stringify(newIntegrations), now(), w.id);
    const updated = getWorkflow(w.id);
    notifyProject(updated.project_id, 'workflow.updated', { id: w.id });
    logEvent(w.id, 'system', `Settings changed by command: AWS integration removed by ${ctx.userName}`);
    audit_session(ctx.userId, w, 'aws_integration_off');
    return {
      type: 'text',
      text: `AWS integration removed.${isDriving(w.id) ? ' This takes effect from the next iteration.' : ''}`,
      deferred: running,
      workflow: viewWorkflow(getWorkflow(w.id)),
    };
  }
}

/** Write audit record for a session integration change. */
function audit_session(userId: string, w: Row, change: string): void {
  try {
    auditRaw(userId, 'session.settings_change', `workflow:${w.id}`, { projectId: w.project_id, change, via: 'command' }, null);
  } catch { /* non-fatal */ }
}

/* ------------------------------------------------------------------ */
/* Route                                                               */
/* ------------------------------------------------------------------ */

/**
 * POST /api/workflows/:id/command
 *
 * Request body: { "command": "/model sonnet" }
 * Response:     CommandResult (see above)
 */
export function registerSessionCommandRoutes(): void {
  post('/api/workflows/:id/command', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    // Read-only commands (/help, /status, /context, /usage, /tools list) need only 'viewer'.
    // State-changing commands need 'editor'.
    requireProject(ctx, w.project_id, 'viewer');

    const body = await ctx.json();
    const raw = str(body.command, 'command', { max: 2000 }).trim();
    if (!raw.startsWith('/')) {
      throw badRequest(`Commands must start with "/". ${raw ? `Did you mean "/${raw}"?` : ''} Use /help to see what is available.`);
    }

    // Parse: /name [arg...]
    const spaceIdx = raw.indexOf(' ');
    const name = (spaceIdx < 0 ? raw : raw.slice(0, spaceIdx)).toLowerCase();
    const arg = spaceIdx < 0 ? '' : raw.slice(spaceIdx + 1).trim();

    // Commands that change session state require at least 'editor'.
    const STATE_CHANGING = new Set(['/model', '/agent', '/engine', '/stop', '/resume', '/browser', '/aws']);
    if (STATE_CHANGING.has(name)) {
      requireProject(ctx, w.project_id, 'editor');
    }

    const userCtx = { userId: ctx.user!.id, userName: ctx.user!.name, isAdmin: Boolean(ctx.user!.is_admin) };

    let result: CommandResult;
    switch (name) {
      case '/help':
        result = cmdHelp();
        break;
      case '/model':
        result = cmdModel(w, arg);
        if (result.workflow) {
          audit(ctx, 'session.settings_change', `workflow:${w.id}`, { projectId: w.project_id, change: 'model', value: arg });
        }
        break;
      case '/agent':
        result = cmdAgent(w, arg, userCtx);
        if (result.workflow) {
          audit(ctx, 'session.settings_change', `workflow:${w.id}`, { projectId: w.project_id, change: 'lead_agent', value: arg });
        }
        break;
      case '/engine':
        result = cmdEngine(w, arg, userCtx);
        if (result.workflow) {
          audit(ctx, 'session.settings_change', `workflow:${w.id}`, { projectId: w.project_id, change: 'engine', value: arg });
        }
        break;
      case '/context':
        result = cmdContext(w);
        break;
      case '/usage':
        result = cmdUsage(w);
        break;
      case '/status':
        result = cmdStatus(w);
        break;
      case '/stop':
        result = cmdStop(w, userCtx);
        if (result.workflow) {
          audit(ctx, 'session.stop', `workflow:${w.id}`, { projectId: w.project_id, via: 'command' });
        }
        break;
      case '/resume':
        result = cmdResume(w, userCtx);
        if (result.workflow) {
          audit(ctx, 'session.resume', `workflow:${w.id}`, { projectId: w.project_id, via: 'command' });
        }
        break;
      case '/tools':
        result = await cmdTools(w, arg, userCtx);
        break;
      case '/browser':
        result = await cmdBrowser(w, arg, userCtx);
        break;
      case '/aws':
        result = await cmdAws(w, arg, userCtx);
        break;
      default:
        throw badRequest(
          `Unknown command "${name}". Use /help to see available commands.`,
        );
    }

    return result;
  });
}
