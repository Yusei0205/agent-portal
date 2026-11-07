/**
 * Slash commands the portal handles itself in a Kiro or Claude Code session (the same ones people know from
 * those tools): /help, /model, /agent, /cost, /status, /tools, /rename, /compact. /clear is handled in crud.ts
 * because the conversation recap looks for it. Any other "/something" is passed to the engine as plain text.
 */

import { getSessionsRepository } from '../repositories/sessions.ts';
import type { WorkflowRecord } from '../repositories/sessions.ts';
import { getEngineModels } from '../models.ts';
import { listAgentsForEngine } from '../user-config.ts';
import { now } from '../util.ts';

export const PORTAL_COMMANDS: Array<{ name: string; usage: string; description: string }> = [
  { name: 'help',    usage: '/help',                  description: 'Show the available commands' },
  { name: 'clear',   usage: '/clear',                 description: 'Start fresh: earlier messages are no longer sent to the agent' },
  { name: 'compact', usage: '/compact',               description: 'Start a new engine session with a short recap of this conversation' },
  { name: 'model',   usage: '/model [name|default]',  description: 'Show the available models, or switch the model for the next message' },
  { name: 'agent',   usage: '/agent [name|default]',  description: 'Show the available agents, or switch the lead agent' },
  { name: 'tools',   usage: '/tools [trust|ask]',     description: 'Show or change whether tools run without asking' },
  { name: 'cost',    usage: '/cost',                  description: 'Show the cost of the last turn and of the whole session' },
  { name: 'status',  usage: '/status',                description: 'Show the engine, model, agent and tool mode' },
  { name: 'rename',  usage: '/rename <title>',        description: 'Rename this session' },
];

function usd(n: number): string {
  if (!n) return '$0.00';
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
}

/**
 * Runs a portal-handled command and returns the text to show, or null when `message` is not one of them
 * (the caller then passes it to the engine as before).
 */
export async function runPortalCommand(w: WorkflowRecord, message: string, userId: string): Promise<string | null> {
  const [head, ...rest] = message.trim().split(/\s+/);
  const name = head.slice(1).toLowerCase();
  const arg = rest.join(' ').trim();
  const engine = String(w.engine);
  const repo = getSessionsRepository();
  const hasEngine = engine === 'kiro' || engine === 'claude-code' || engine === 'codex';

  switch (name) {
    case 'help':
      return PORTAL_COMMANDS.map((c) => `${c.usage.padEnd(24)} ${c.description}`).join('\n');

    case 'compact':
      await repo.updateWorkflow(w.id, { engine_session_id: null, engine_session_engine: null, updated_at: now() });
      return 'The next message starts a new engine session with a short recap of this conversation.';

    case 'model': {
      if (!hasEngine) return 'Models can be changed in Codex, Kiro and Claude Code sessions.';
      const res = await getEngineModels(engine as 'kiro' | 'claude-code' | 'codex', userId, w.credential_id ?? null, false);
      const models = res.models ?? [];
      const current = w.model || models.find((m) => m.default)?.id || '(default)';
      if (!arg) {
        if (!models.length) return `No models were found${res.error ? `: ${res.error}` : ''}. Current: ${current}`;
        const offered = models.some((m) => m.id === current);
        return [
          `Current model: ${current}`,
          ...(w.model && !offered ? ['  (not in this list: it is not available here, so pick one of these)'] : []),
          '',
          ...models.map((m) => `  ${m.id === current ? '●' : ' '} ${m.id}${m.label && m.label !== m.id ? `  (${m.label})` : ''}`),
          '',
          'Switch with: /model <name>   (or /model default)',
        ].join('\n');
      }
      const q = arg.toLowerCase();
      if (q === 'default' || q === 'none') {
        // '' is "no model of its own" (the column is NOT NULL DEFAULT ''); runs then use the engine's default.
        await repo.updateWorkflow(w.id, { model: '', updated_at: now() });
        const fallback = models.find((m) => m.default);
        return `Model switched to the engine default${fallback ? ` (${fallback.label || fallback.id})` : ''}. It applies from your next message.`;
      }
      const exact = models.filter((m) => m.id.toLowerCase() === q || (m.label ?? '').toLowerCase() === q);
      const matches = exact.length
        ? exact
        : models.filter((m) => m.id.toLowerCase().includes(q) || (m.label ?? '').toLowerCase().includes(q));
      if (matches.length === 0) return `No model matches "${arg}". Type /model to see the list.`;
      if (matches.length > 1) return `"${arg}" matches several models:\n${matches.map((m) => `  ${m.id}`).join('\n')}\nBe more specific.`;
      await repo.updateWorkflow(w.id, { model: matches[0].id, updated_at: now() });
      return `Model switched to ${matches[0].id}. It applies from your next message.`;
    }

    case 'agent': {
      if (engine === 'codex') return 'Codex uses its native agent instructions. Kiro and Claude lead agents do not apply.';
      if (!hasEngine) return 'Agents can be changed in Kiro and Claude Code sessions.';
      const agents = await listAgentsForEngine(userId, engine);
      const current = w.lead_agent || '(default)';
      if (!arg) {
        if (!agents.length) return `No custom agents were found. Current: ${current}`;
        return [
          `Current agent: ${current}`,
          '',
          ...agents.map((a) => `  ${a.name === w.lead_agent ? '●' : ' '} ${a.name}${a.description ? `  ${a.description}` : ''}`),
          '',
          'Switch with: /agent <name>   (or /agent default)',
        ].join('\n');
      }
      if (['default', 'none'].includes(arg.toLowerCase())) {
        await repo.updateWorkflow(w.id, { lead_agent: null, updated_at: now() });
        return 'Agent switched back to the default. It applies from your next message.';
      }
      const q = arg.toLowerCase();
      const exact = agents.filter((a) => a.name.toLowerCase() === q);
      const matches = exact.length ? exact : agents.filter((a) => a.name.toLowerCase().includes(q));
      if (matches.length === 0) return `No agent matches "${arg}". Type /agent to see the list.`;
      if (matches.length > 1) return `"${arg}" matches several agents:\n${matches.map((a) => `  ${a.name}`).join('\n')}\nBe more specific.`;
      await repo.updateWorkflow(w.id, { lead_agent: matches[0].name, updated_at: now() });
      return `Agent switched to ${matches[0].name}. It applies from your next message.`;
    }

    case 'tools':
    case 'trust': {
      const a = arg.toLowerCase();
      if (['trust', 'trust-all', 'all', 'on'].includes(a) || (name === 'trust' && !a)) {
        await repo.updateWorkflow(w.id, { trust_tools: 1, updated_at: now() });
        return 'Tools now run without asking (trust all).';
      }
      if (['ask', 'reset', 'untrust', 'off'].includes(a)) {
        await repo.updateWorkflow(w.id, { trust_tools: 0, updated_at: now() });
        return 'Tools now ask before running (read-only tools stay allowed).';
      }
      return `Tool mode: ${w.trust_tools ? 'trust all (no prompts)' : 'ask before use'}\nChange with: /tools trust   or   /tools ask`;
    }

    case 'cost':
    case 'usage': {
      if (engine === 'codex') {
        const totals = await repo.getRunTotals(w.id);
        return 'Codex uses your ChatGPT plan. Dollar cost is unavailable.\nSession tokens: ' + totals.total_input + ' in / ' + totals.total_output + ' out';
      }
      const latest = await repo.getLatestRun(w.id);
      const totals = await repo.getRunTotals(w.id);
      const tokens = totals.total_input || totals.total_output
        ? ` · ${totals.total_input} in / ${totals.total_output} out tokens`
        : '';
      return `This turn: ${usd(latest?.cost_usd ?? 0)}\nSession total: ${usd(totals.total_cost)}${tokens}`;
    }

    case 'status': {
      const latest = await repo.getLatestRun(w.id);
      return [
        `Engine: ${engine}`,
        `Model: ${w.model || latest?.model || '(default)'}`,
        `Agent: ${w.lead_agent || '(default)'}`,
        `Tools: ${w.trust_tools ? 'trust all' : 'ask before use'}`,
        `Session: ${w.status}`,
      ].join('\n');
    }

    case 'rename': {
      if (!arg) return 'Usage: /rename <new title>';
      await repo.updateWorkflow(w.id, { title: arg.slice(0, 200), updated_at: now() });
      return `Session renamed to "${arg.slice(0, 200)}".`;
    }

    default:
      return null;
  }
}
