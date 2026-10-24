// @ts-check
// How a session's state reads in the list and the header.
// Sessions are WorkflowView objects (see lib/api-types.js).
/** @type {Record<string, { tone: string, label: string }>} */
export const STATUS = {
  queued: { tone: 'muted', label: 'Queued' },
  running: { tone: 'accent', label: 'Running by itself' },
  done: { tone: 'ok', label: 'Ready for review' },
  paused: { tone: 'warn', label: 'Paused' },
  blocked: { tone: 'warn', label: 'Needs you' },
  failed: { tone: 'danger', label: 'Failed' },
  stopped: { tone: 'muted', label: 'Stopped' },
};

/** @param {Pick<import('../../lib/api-types.js').WorkflowView, 'status'>} w */
export const statusOf = (w) => STATUS[w.status] ?? { tone: 'muted', label: w.status };

/** A session needs a person when it is blocked or its current run waits for an answer or approval. */
/** @param {Pick<import('../../lib/api-types.js').WorkflowView, 'status' | 'pending_inputs' | 'last_run_status' | 'pending_push'>} w */
export const needsYou = (w) => w.status === 'blocked' || w.pending_inputs > 0 || w.last_run_status === 'waiting' || Boolean(w.pending_push);

export const PUSH_MODES = [
  { value: 'never', label: 'Never', hint: 'Agents never push; a person pushes from the Changes tab.' },
  { value: 'ask', label: 'Ask me each time', hint: 'When the agents ask, the session waits until a person allows or declines the push.' },
  { value: 'auto', label: 'Allowed', hint: 'The portal pushes when the agents ask, without waiting.' },
];

/** List groups, in the order people should look at them.
 * @type {{ key: string, label: string, test: (w: import('../../lib/api-types.js').WorkflowView) => boolean }[]}
 */
export const GROUPS = [
  { key: 'needs', label: 'Needs you', test: needsYou },
  { key: 'queued', label: 'Queued', test: (w) => w.status === 'queued' },
  { key: 'running', label: 'Running', test: (w) => w.status === 'running' },
  { key: 'review', label: 'Ready for review', test: (w) => w.status === 'done' },
  { key: 'other', label: 'Paused and stopped', test: () => true },
];

/** @param {import('../../lib/api-types.js').WorkflowView[]} items */
export function groupSessions(items) {
  /** @type {(typeof GROUPS[number] & { items: import('../../lib/api-types.js').WorkflowView[] })[]} */
  const out = GROUPS.map((g) => ({ ...g, items: [] }));
  for (const w of items) out.find((g) => g.test(w))?.items.push(w);
  return out.filter((g) => g.items.length);
}

/** @param {Pick<import('../../lib/api-types.js').WorkflowView, 'provider'>} w */
export const isKiro = (w) => w.provider === 'kiro';

/** Spent and budget in the unit the session is billed in. */
/**
 * @param {Pick<import('../../lib/api-types.js').WorkflowView, 'provider' | 'spent_credits' | 'budget_credits' | 'spent_usd' | 'budget_usd'>} w
 * @returns {{ spent: number, total: number, unit: 'credits' | 'usd' }}
 */
export function budgetOf(w) {
  return isKiro(w)
    ? { spent: Number(w.spent_credits ?? 0), total: Number(w.budget_credits ?? 20), unit: 'credits' }
    : { spent: Number(w.spent_usd ?? 0), total: Number(w.budget_usd ?? 5), unit: 'usd' };
}
