/**
 * Sort keys for the Jira ticket list.
 *
 * A ticket's status is an object ({ name, category }) and sorting it as-is turns every row into "[object Object]", so
 * nothing moves. Status sorts by where it sits in the workflow (to do, then in progress, then done) and then by name;
 * priority sorts from the most to the least urgent instead of alphabetically ("High" would come before "Highest").
 * Both return text that sorts correctly with the table's natural-order comparison.
 */

const STATUS_RANK = { new: 0, indeterminate: 1, done: 2 };
const PRIORITY_RANK = ['highest', 'critical', 'blocker', 'high', 'major', 'medium', 'normal', 'low', 'minor', 'lowest', 'trivial'];

/** @param {{ name?: string, category?: string } | string | null | undefined} status */
export function statusSortKey(status) {
  if (!status) return null;
  const name = typeof status === 'object' ? status.name : String(status);
  if (!name) return null;
  const cat = typeof status === 'object' ? String(status.category || '').toLowerCase() : '';
  const rank = cat in STATUS_RANK ? STATUS_RANK[cat] : 1;
  return `${rank}-${name}`;
}

/** @param {string | null | undefined} priority */
export function prioritySortKey(priority) {
  if (!priority) return null;
  const i = PRIORITY_RANK.indexOf(String(priority).toLowerCase());
  return `${String(i >= 0 ? i : 50).padStart(2, '0')}-${priority}`;
}
