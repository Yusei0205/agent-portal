export function cx(...xs) {
  return xs.filter(Boolean).join(' ');
}

export function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function dateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function duration(a, b) {
  if (!a) return '';
  const ms = (b ? Date.parse(b) : Date.now()) - Date.parse(a);
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function money(usd, digits) {
  if (usd === null || usd === undefined) return '';
  const d = digits ?? (usd !== 0 && Math.abs(usd) < 0.1 ? 4 : 2);
  return `$${Number(usd).toFixed(d)}`;
}

export function tokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Stable colour for a name, picked from a palette that reads on light and dark backgrounds. */
const ROLE_HUES = [174, 212, 262, 36, 140, 196, 288, 228, 96, 312];
export function hueFor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ROLE_HUES[h % ROLE_HUES.length];
}

export function plural(n, word, pl) {
  return `${n} ${n === 1 ? word : pl || word + 's'}`;
}
