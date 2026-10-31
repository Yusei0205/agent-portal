/**
 * Git progress parser and in-memory tracker for clone/fetch operations.
 *
 * Phase → overall percent weighting (documented here for the frontend contract):
 *   counting:     0 →  3%   (3% of total)
 *   compressing:  3 →  5%   (2% of total)
 *   receiving:    5 → 75%  (70% of total — dominant for large repos)
 *   resolving:   75 → 95%  (20% of total)
 *   checkout:    95 → 100%  (5% of total)
 *
 * Overall percent is monotonically non-decreasing across the whole sync.
 * The `updatedAt` timestamp advances at most ~4× per second (every 250 ms)
 * so polling endpoints do not see churn during fast bursts of progress lines.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type Phase =
  | 'connecting'
  | 'counting'
  | 'compressing'
  | 'receiving'
  | 'resolving'
  | 'checkout'
  | 'finalizing';

/** Progress snapshot exposed through the API. */
export interface ProgressInfo {
  phase: Phase;
  phaseLabel: string;
  /** Overall 0–100, or null when still in the connecting/indeterminate state. */
  percent: number | null;
  /** Per-phase 0–100, or null when git hasn't emitted a percentage yet. */
  phasePercent: number | null;
  /** Human-readable detail, e.g. "1,234 / 3,333 objects · 12.3 MiB · 2.1 MiB/s" */
  detail: string | null;
  startedAt: string;
  updatedAt: string;
}

/** Result of parsing one line. */
export interface ParsedLine {
  phase: Phase;
  phasePercent: number | null;
  detail: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const PHASE_LABELS: Record<Phase, string> = {
  connecting: 'Connecting',
  counting: 'Counting objects',
  compressing: 'Compressing objects',
  receiving: 'Receiving objects',
  resolving: 'Resolving deltas',
  checkout: 'Checking out files',
  finalizing: 'Finalizing',
};

/** Maps the git label text (as it appears in stderr) to our phase enum. */
const GIT_LABEL_TO_PHASE: Record<string, Phase> = {
  'Counting objects': 'counting',
  'Enumerating objects': 'counting',
  'Compressing objects': 'compressing',
  'Receiving objects': 'receiving',
  'Resolving deltas': 'resolving',
  'Updating files': 'checkout',
};

/** Ordered phases; index doubles as a monotonic rank. */
const PHASE_ORDER: readonly Phase[] = [
  'connecting',
  'counting',
  'compressing',
  'receiving',
  'resolving',
  'checkout',
  'finalizing',
] as const;

/**
 * Overall-percent range [start, end] for each phase.
 * During a phase: overall = start + (phasePercent / 100) × (end − start).
 */
const PHASE_RANGES: Readonly<Record<Phase, readonly [number, number]>> = {
  connecting: [0, 0],
  counting: [0, 3],
  compressing: [3, 5],
  receiving: [5, 75],
  resolving: [75, 95],
  checkout: [95, 100],
  finalizing: [100, 100],
} as const;

const THROTTLE_MS = 250; // max ~4 updatedAt advances per second

// ── Regexes ───────────────────────────────────────────────────────────────────

/**
 * Matches standard git progress lines (with or without the "remote: " prefix):
 *   "Receiving objects:  37% (1234/3333), 12.34 MiB | 2.10 MiB/s"
 *   "remote: Compressing objects:  78% (234/300)"
 *   "Updating files: 60% (123/400)"
 *
 * Groups: [1] label  [2] percent  [3] count/total (optional)  [4] remainder
 */
const PROGRESS_PCT_RE =
  /^(?:remote:\s+)?(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Enumerating objects):\s+(\d+)%\s*(?:\(([^)]*)\))?(.*)/;

/**
 * Matches the indeterminate enumeration line:
 *   "remote: Enumerating objects: 400, done."
 *   "remote: Enumerating objects: 400"   (mid-count, no "done." yet)
 */
const ENUM_RE = /^remote:\s+Enumerating objects:\s+\d+/;

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Scrub Authorization headers and userinfo from URLs so credentials are
 * never surfaced in error messages or logs.
 * Git passes credentials via GIT_CONFIG_COUNT env vars (not the URL), but we
 * guard defensively in case any code path constructs a URL with credentials.
 */
export function redactCredentials(text: string): string {
  return text
    .replace(/\bAuthorization:\s*\S+/gi, 'Authorization: [REDACTED]')
    .replace(/https?:\/\/[^:@\s"'<>]+:[^@\s"'<>]+@/gi, 'https://[REDACTED]@');
}

/**
 * Return the monotonic rank of a phase.
 * Higher rank = later in the lifecycle.
 */
export function phaseOrder(phase: Phase): number {
  const idx = PHASE_ORDER.indexOf(phase);
  return idx === -1 ? 0 : idx;
}

/**
 * Compute the overall progress percentage (0–100) from a phase and
 * its per-phase completion.
 *
 * Returns null when the phase maps to [0,0] (connecting = indeterminate).
 */
export function computeOverallPercent(phase: Phase, phasePercent: number | null): number | null {
  const [start, end] = PHASE_RANGES[phase];
  if (start === 0 && end === 0) return null; // connecting: genuinely indeterminate
  if (start === end) return start;            // finalizing: 100
  if (phasePercent === null) return start;   // phase started but no % yet
  return Math.round(start + (phasePercent / 100) * (end - start));
}

/**
 * Parse one git progress line.
 * Returns null for lines that carry no progress information.
 */
export function parseProgressLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Indeterminate enumeration ("remote: Enumerating objects: N")
  if (ENUM_RE.test(trimmed)) {
    return { phase: 'counting', phasePercent: null, detail: null };
  }

  const m = PROGRESS_PCT_RE.exec(trimmed);
  if (!m) return null;

  const rawLabel = m[1] as string;
  const phase = GIT_LABEL_TO_PHASE[rawLabel];
  if (!phase) return null;

  const phasePercent = parseInt(m[2] as string, 10);
  const countStr = (m[3] ?? '').trim();   // "1234/3333"
  const rest = (m[4] ?? '').trim();       // ", 12.34 MiB | 2.10 MiB/s"

  let detail: string | null = null;

  if (countStr) {
    const slashIdx = countStr.indexOf('/');
    if (slashIdx !== -1) {
      const currentRaw = countStr.slice(0, slashIdx).replace(/[, ]/g, '');
      const totalRaw   = countStr.slice(slashIdx + 1).replace(/[, ]/g, '');
      const current = parseInt(currentRaw, 10);
      const total   = parseInt(totalRaw, 10);
      if (!isNaN(current) && !isNaN(total)) {
        const fmt = (n: number) => n.toLocaleString('en-US');
        detail = `${fmt(current)} / ${fmt(total)} objects`;

        // Parse transferred size and speed from the remainder
        // rest looks like: ", 12.34 MiB | 2.10 MiB/s" (speed part is optional)
        const pipeIdx = rest.indexOf('|');
        const sizePart  = pipeIdx >= 0 ? rest.slice(0, pipeIdx) : rest;
        const speedPart = pipeIdx >= 0 ? rest.slice(pipeIdx + 1) : '';
        const sizeM  = /[\d.]+\s*[KMGT]?iB/.exec(sizePart);
        const speedM = /[\d.]+\s*[KMGT]?iB/.exec(speedPart);
        if (sizeM) {
          detail += ` · ${sizeM[0]}`;
          if (speedM) detail += ` · ${speedM[0]}/s`;
        }
      }
    }
  }

  return { phase, phasePercent, detail };
}

/**
 * Parse a raw stderr chunk from git into individual progress updates.
 *
 * Git uses `\r` (carriage-return) to overwrite the current terminal line for
 * live progress; `\n` terminates a completed phase line. We split on both so
 * the caller doesn't need to buffer manually.
 *
 * @param chunk     Raw chunk received from the git process stderr stream.
 * @param partial   Accumulated bytes that have not yet been terminated by \r or \n.
 * @returns         All parsed updates found in the chunk, and the new partial tail.
 */
export function parseProgressChunk(
  chunk: string,
  partial: string,
): { updates: ParsedLine[]; newPartial: string } {
  const text = partial + chunk;
  const segments = text.split(/[\r\n]/);
  // The last element is either empty (text ended with \r/\n) or an incomplete line
  const newPartial = segments.pop() ?? '';
  const updates: ParsedLine[] = [];
  for (const seg of segments) {
    const parsed = parseProgressLine(seg);
    if (parsed) updates.push(parsed);
  }
  return { updates, newPartial };
}

// ── ProgressTracker ────────────────────────────────────────────────────────────

/**
 * Tracks live progress for a single git clone/fetch operation.
 *
 * Feed raw stderr chunks via `feedChunk()`; call `finalize()` when the git
 * process exits successfully.  Read the current snapshot via `snapshot`.
 *
 * All mutations are synchronous (single-threaded Node.js event loop).
 */
export class ProgressTracker {
  private _phase: Phase = 'connecting';
  private _phasePercent: number | null = null;
  private _percent: number | null = null;
  private _detail: string | null = null;
  private readonly _startedAt: string;
  private _updatedAt: string;

  // For monotonicity enforcement
  private _lastPercent: number | null = null;
  private _lastPhaseOrder: number;

  // For throttling updatedAt advances (~4/sec)
  private _lastEmitMs: number = 0;

  // Accumulates bytes that do not yet end in \r or \n
  private _partial: string = '';

  constructor() {
    const iso = new Date().toISOString();
    this._startedAt = iso;
    this._updatedAt = iso;
    this._lastPhaseOrder = phaseOrder('connecting');
  }

  /** Immutable snapshot of current state. */
  get snapshot(): ProgressInfo {
    return {
      phase: this._phase,
      phaseLabel: PHASE_LABELS[this._phase],
      percent: this._percent,
      phasePercent: this._phasePercent,
      detail: this._detail,
      startedAt: this._startedAt,
      updatedAt: this._updatedAt,
    };
  }

  /**
   * Feed a raw Buffer or string chunk from the git process stderr stream.
   * Progress lines are extracted and state is updated.
   */
  feedChunk(rawChunk: Buffer | string): void {
    const chunk = typeof rawChunk === 'string' ? rawChunk : rawChunk.toString('utf8');
    const { updates, newPartial } = parseProgressChunk(chunk, this._partial);
    this._partial = newPartial;
    for (const u of updates) this._applyUpdate(u, false);
  }

  /**
   * Flush any remaining partial line and mark the operation complete.
   * Call this once the git process exits with code 0.
   */
  finalize(): void {
    if (this._partial.trim()) {
      const parsed = parseProgressLine(this._partial);
      if (parsed) this._applyUpdate(parsed, true);
      this._partial = '';
    }
    const iso = new Date().toISOString();
    this._phase = 'finalizing';
    this._phasePercent = 100;
    this._percent = 100;
    this._lastPercent = 100;
    this._updatedAt = iso;
  }

  private _applyUpdate(u: ParsedLine, force: boolean): void {
    const nowMs = Date.now();
    const newOrder = phaseOrder(u.phase);

    // Phases only move forward
    if (newOrder < this._lastPhaseOrder) return;

    const rawPct = computeOverallPercent(u.phase, u.phasePercent);
    const pct = this._enforceMonotonic(rawPct);

    const phaseChanged = newOrder > this._lastPhaseOrder;

    // Always update computed values immediately
    this._phase = u.phase;
    this._phasePercent = u.phasePercent;
    this._percent = pct;
    this._lastPhaseOrder = newOrder;

    // Keep detail fresh: reset on phase change so stale receiving detail
    // doesn't bleed into the resolving phase
    if (phaseChanged) {
      this._detail = u.detail;
    } else if (u.detail !== null) {
      this._detail = u.detail;
    }

    // Throttle updatedAt to avoid excessive churn for pollers
    const shouldEmit = force || phaseChanged || (nowMs - this._lastEmitMs >= THROTTLE_MS);
    if (shouldEmit) {
      this._updatedAt = new Date().toISOString();
      this._lastEmitMs = nowMs;
    }
  }

  private _enforceMonotonic(pct: number | null): number | null {
    if (pct === null) return this._lastPercent;
    if (this._lastPercent !== null && pct < this._lastPercent) return this._lastPercent;
    this._lastPercent = pct;
    return pct;
  }
}
