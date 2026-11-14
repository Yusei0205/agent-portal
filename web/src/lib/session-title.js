/** Short session titles: what the header and the session list show, so a session is easy to pick out. */

export const SHORT_TITLE_MAX = 60;

/** One line, at most `max` characters, cut at a word where it can be, with an ellipsis when cut. */
export function shortenTitle(text, max = SHORT_TITLE_MAX) {
  const line = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const one = line.replace(/\s+/g, ' ');
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The title the user set, else the start of the goal, else "Session <id>". */
export function sessionTitle(w) {
  const set = String(w?.title ?? '').trim();
  if (set) return set;
  return shortenTitle(w?.goal) || `Session ${String(w?.id ?? '').slice(0, 8)}`;
}

/** True when the user (or the portal) set a title, as opposed to it being taken from the goal. */
export function hasOwnTitle(w) {
  return Boolean(String(w?.title ?? '').trim());
}
