/** Kiro sessions that cannot run ask the user to switch to Claude Code (D-12); nothing switches by itself. */
import { one, run as exec, type Row } from '../db.ts';
import { log } from './store.ts';
import { stopWith } from './lifecycle.ts';

/**
 * A Kiro session that cannot run never switches engine by itself (D-12): it pauses with the reason and an
 * "engine_switch" event stays open until a person accepts (the session continues on Claude Code) or declines (it stays
 * stopped). The event shows in the session workspace and in the Inbox.
 */
export function askEngineSwitch(id: string, reason: string): void {
  const text = reason.slice(0, 400);
  stopWith(id, 'paused', `Kiro cannot run this session: ${text}`);
  if (!one<Row>("SELECT id FROM workflow_events WHERE workflow_id = ? AND kind = 'engine_switch' AND consumed = 0", id)) {
    log(id, 'engine_switch', text);
  }
}

export function pendingEngineSwitch(workflowId: string): Row | null {
  return one<Row>("SELECT id, body, created_at FROM workflow_events WHERE workflow_id = ? AND kind = 'engine_switch' AND consumed = 0 ORDER BY id DESC", workflowId) ?? null;
}

export function closeEngineSwitch(workflowId: string): void {
  exec("UPDATE workflow_events SET consumed = 1 WHERE workflow_id = ? AND kind = 'engine_switch' AND consumed = 0", workflowId);
}
