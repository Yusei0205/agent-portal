/** The label and tone of a session's status pill in its header, from the session's `status`. */
export function sessionStatusPill(workflow) {
  switch (workflow?.status) {
    case 'running': return { label: 'Running', tone: 'live' };
    case 'pending': return { label: 'Starting', tone: 'live' };
    case 'failed': return { label: 'Failed', tone: 'bad' };
    case 'done': return { label: 'Completed', tone: 'ok' };
    case 'stopped': return { label: 'Stopped', tone: 'idle' };
    case 'paused': return { label: 'Paused', tone: 'idle' };
    default: return null;
  }
}

/** How many sessions are running (or starting) and how many failed, for the counts on the list's filters. */
export function statusCounts(workflows) {
  let running = 0;
  let failed = 0;
  for (const w of workflows ?? []) {
    if (w.status === 'running' || w.status === 'pending') running += 1;
    else if (w.status === 'failed') failed += 1;
  }
  return { running, failed };
}

/**
 * How long a run has been going (still running: until `now`) or took (finished), in milliseconds; null when the run has not
 * started or its times are unusable.
 */
export function runElapsedMs(run, now = Date.now()) {
  const start = Date.parse(run?.started_at ?? '');
  if (!Number.isFinite(start)) return null;
  const end = run?.finished_at ? Date.parse(run.finished_at) : now;
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/**
 * What a "#note" in the message box does: the note text, or null when the message is not one. "#note" with no space after
 * the hash is a memory note; "# Heading" and "##" stay ordinary messages (markdown).
 */
export function parseMemoryNote(text) {
  const m = /^#([^\s#][\s\S]*)$/.exec(String(text ?? '').trim());
  return m ? m[1].trim() : null;
}

/** The guide text with the note added as a bullet at the end (one blank line kept between earlier text and the bullet). */
export function appendMemoryNote(existing, note) {
  const base = String(existing ?? '').replace(/\s+$/, '');
  const line = `- ${note.replace(/\s*\n\s*/g, ' ').trim()}`;
  return base ? `${base}\n${line}\n` : `${line}\n`;
}

/** What a "!command" in the message box runs in the terminal, or null. A lone "!" is not a command. */
export function parseShellCommand(text) {
  const m = /^!\s*(\S[\s\S]*)$/.exec(String(text ?? '').trim());
  return m ? m[1].trim() : null;
}
