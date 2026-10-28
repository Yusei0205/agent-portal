/** Controlling a session: messages, resume, engine switch, pause, stop, cancel and delete. */
import { run as exec, type Row } from '../db.ts';
import { del, post, type Ctx } from '../http.ts';
import { notifyProject, requireProject } from '../projects.ts';
import { isActive, stopRun } from '../agent/runner.ts';
import { badRequest, now, str } from '../util.ts';
import { engineProvider } from '../project-aws.ts';
import { removeContextFiles } from '../session-context.ts';
import { concurrencyReason, queueReasonLabel } from '../control-plane.ts';
import { audit } from '../audit.ts';
import { OPEN, REOPENABLE, driving, getWorkflow, readPermissionMode, patch, log, overBudget } from './store.ts';
import { view } from './views.ts';
import { pendingEngineSwitch, closeEngineSwitch } from './engine-switch.ts';
import { stopWith } from './lifecycle.ts';
import { kick } from './driver.ts';
import { readContextItems, addContextItems, checkSafetyChange } from './validation.ts';

/** Start a stopped session again: queued when the concurrency cap or a server drain says so, running otherwise. */
function resumeSession(w: Row, ctx: Ctx): void {
  if (!w.parent_id) {
    const reason = concurrencyReason(ctx.user!.id, w.project_id);
    if (reason) {
      const label = queueReasonLabel(reason);
      patch(w.id, { status: 'queued', queue_reason: reason, queued_at: now(), stop_reason: label });
      log(w.id, 'status', reason === 'drain' ? 'Queued during server drain.' : `Queued: ${label}`);
      audit(ctx, 'session.resume', `workflow:${w.id}`, { projectId: w.project_id, queued: true });
      return;
    }
  }
  patch(w.id, { status: 'running', stop_reason: '', queue_reason: '', queued_at: null, burst_start: w.iteration, waiting_children: 0, pending_push: '' });
  log(w.id, 'status', 'Resumed');
  audit(ctx, 'session.resume', `workflow:${w.id}`, { projectId: w.project_id });
  kick(w.id);
}

export function registerControlRoutes(): void {
  // Tell the session something. It is read at the next iteration, and a finished or stopped session starts again.
  post('/api/workflows/:id/messages', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    const body = await ctx.json();
    const text = str(body.body, 'Instruction', { max: 4000 }).trim();
    if (REOPENABLE.includes(w.status) && overBudget(w)) throw badRequest('This session has used its budget. Raise the budget first, then send the instruction.');
    const permissionMode = body.permissionMode === undefined ? undefined : readPermissionMode(body.permissionMode);
    if (permissionMode !== undefined) checkSafetyChange(ctx, w as any, { permission_mode: permissionMode });
    addContextItems(w.id, { id: ctx.user!.id, name: ctx.user!.name }, readContextItems(body.context));
    if (permissionMode !== undefined && permissionMode !== (w.permission_mode || '')) patch(w.id, { permission_mode: permissionMode });
    log(w.id, 'human', text, { data: { by: ctx.user!.name } });
    if (REOPENABLE.includes(w.status)) {
      patch(w.id, { status: 'running', stop_reason: '', burst_start: w.iteration, waiting_children: 0, pending_push: '' });
      // A session that makes a diagram, document or deck shows it as being made again until this message is answered.
      await (await import('../outputs.ts')).markFollowUp(w.id).catch(() => undefined);
      kick(w.id);
    }
    return { workflow: view(getWorkflow(w.id)) };
  });

  post('/api/workflows/:id/resume', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    if (OPEN.includes(w.status) && driving.has(w.id)) return { workflow: view(w) };
    if (overBudget(w)) throw badRequest('This session has used its budget. Raise the budget first.');
    resumeSession(w, ctx);
    return { workflow: view(getWorkflow(w.id)) };
  });

  // Kiro could not run this session: the person decides whether it continues on Claude Code. Nothing switches by itself.
  post('/api/workflows/:id/engine-switch', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    const body = await ctx.json();
    if (typeof body.accept !== 'boolean') throw badRequest('Say whether to switch: {"accept": true} or {"accept": false}');
    if (!pendingEngineSwitch(w.id)) throw badRequest('This session is not waiting for an engine decision');
    if (body.accept) {
      engineProvider(w.project_id, 'claude');
      if (overBudget(w)) throw badRequest('This session has used its budget. Raise the budget first.');
      closeEngineSwitch(w.id);
      patch(w.id, { engine: 'claude' });
      log(w.id, 'system', `${ctx.user!.name} switched this session to Claude Code because Kiro could not run it.`);
      audit(ctx, 'session.engine-switch', `workflow:${w.id}`, { projectId: w.project_id, accept: true });
      resumeSession(getWorkflow(w.id), ctx);
    } else {
      closeEngineSwitch(w.id);
      log(w.id, 'system', `${ctx.user!.name} kept this session on Kiro; it stays stopped.`);
      audit(ctx, 'session.engine-switch', `workflow:${w.id}`, { projectId: w.project_id, accept: false });
      stopWith(w.id, 'stopped', 'Kiro could not run this session and you chose not to switch to Claude Code.');
    }
    return { workflow: view(getWorkflow(w.id)) };
  });

  // Finish the current iteration, then wait.
  post('/api/workflows/:id/pause', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    if (w.status !== 'running') throw badRequest('This session is not running');
    stopWith(w.id, 'paused', 'Paused after the current iteration.');
    audit(ctx, 'session.pause', `workflow:${w.id}`, { projectId: w.project_id });
    return { workflow: view(getWorkflow(w.id)) };
  });

  // Stop now, including the run in progress.
  post('/api/workflows/:id/stop', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    stopWith(w.id, 'stopped', `Stopped by ${ctx.user!.name}.`);
    const runId = driving.get(w.id)?.runId ?? w.last_run_id;
    if (runId && isActive(runId)) stopRun(runId);
    audit(ctx, 'session.stop', `workflow:${w.id}`, { projectId: w.project_id });
    return { workflow: view(getWorkflow(w.id)) };
  });

  // Cancel a queued (waiting) session. Changes its status to 'stopped'.
  post('/api/workflows/:id/cancel-queued', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    if (w.status !== 'queued') throw badRequest('This session is not queued');
    patch(w.id, { status: 'stopped', queue_reason: '', queued_at: null, stop_reason: `Cancelled while queued by ${ctx.user!.name}.` });
    log(w.id, 'status', `Cancelled while queued by ${ctx.user!.name}`);
    audit(ctx, 'session.stop', `workflow:${w.id}`, { projectId: w.project_id, wasQueued: true });
    return { workflow: view(getWorkflow(w.id)) };
  });

  del('/api/workflows/:id', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    if (w.status === 'running') throw badRequest('Stop the session first');
    // Sessions it delegated to stay, on their own.
    exec('UPDATE workflows SET parent_id = NULL WHERE parent_id = ?', w.id);
    exec('DELETE FROM workflows WHERE id = ?', w.id);
    removeContextFiles(w.project_id, w.id);
    notifyProject(w.project_id, 'workflow.deleted', { id: w.id });
    return { ok: true };
  });
}
