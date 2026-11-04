/**
 * Format an ISO date string as a locale date.
 * @param {string | null | undefined} iso
 * @returns {string}
 */
export function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Format an ISO date string as a relative time ("3m ago", "2h ago", "3d").
 * Falls back to formatDate for older items.
 * @param {string | null | undefined} iso
 * @returns {string}
 */
export function formatRelative(iso) {
  if (!iso) return '';
  const secs = (Date.now() - Date.parse(iso)) / 1000;
  if (secs < 60)          return 'just now';
  if (secs < 3600)        return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400)       return `${Math.round(secs / 3600)}h ago`;
  if (secs < 7 * 86400)   return `${Math.round(secs / 86400)}d`;
  return formatDate(iso);
}

/**
 * Truncate a string to at most n characters, appending "…".
 * @param {string | null | undefined} str
 * @param {number} n
 * @returns {string}
 */
export function truncate(str, n) {
  if (!str) return '';
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

/**
 * Format a USD amount as a cost string.
 * @param {number | null | undefined} usd
 * @returns {string}
 */
export function formatCost(usd) {
  if (usd === null || usd === undefined) return '';
  const digits = usd !== 0 && Math.abs(usd) < 0.1 ? 4 : 3;
  return `$${Number(usd).toFixed(digits)}`;
}
