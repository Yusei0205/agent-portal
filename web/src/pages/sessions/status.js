// How a session's state reads in the list and the header.
export const STATUS = {
  running: { tone: 'accent', label: 'Running by itself' },
  done: { tone: 'ok', label: 'Ready for review' },
  paused: { tone: 'warn', label: 'Paused' },
  blocked: { tone: 'warn', label: 'Needs you' },
  failed: { tone: 'danger', label: 'Failed' },
  stopped: { tone: 'muted', label: 'Stopped' },
};

export const statusOf = (w) => STATUS[w.status] ?? { tone: 'muted', label: w.status };

/** A session needs a person when it is blocked or its current run waits for an answer or approval. */
export const needsYou = (w) => w.status === 'blocked' || w.pending_inputs > 0 || w.last_run_status === 'waiting' || Boolean(w.pending_push);

export const PUSH_MODES = [
  { value: 'never', label: 'Never', hint: 'Agents never push; a person pushes from the Changes tab.' },
  { value: 'ask', label: 'Ask me each time', hint: 'When the agents ask, the session waits until a person allows or declines the push.' },
  { value: 'auto', label: 'Allowed', hint: 'The portal pushes when the agents ask, without waiting.' },
];

/** List groups, in the order people should look at them. */
export const GROUPS = [
  { key: 'needs', label: 'Needs you', test: needsYou },
  { key: 'running', label: 'Running', test: (w) => w.status === 'running' },
  { key: 'review', label: 'Ready for review', test: (w) => w.status === 'done' },
  { key: 'other', label: 'Paused and stopped', test: () => true },
];

export function groupSessions(items) {
  const out = GROUPS.map((g) => ({ ...g, items: [] }));
  for (const w of items) out.find((g) => g.test(w)).items.push(w);
  return out.filter((g) => g.items.length);
}

export const isKiro = (w) => w.provider === 'kiro';

/** Spent and budget in the unit the session is billed in. */
export function budgetOf(w) {
  return isKiro(w)
    ? { spent: Number(w.spent_credits ?? 0), total: Number(w.budget_credits ?? 20), unit: 'credits' }
    : { spent: Number(w.spent_usd ?? 0), total: Number(w.budget_usd ?? 5), unit: 'usd' };
}
