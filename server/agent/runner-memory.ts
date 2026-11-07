/**
 * Keeps a cloud run alive when a command the agent runs uses up the machine's memory.
 *
 * AgentCore starts the runner with oom_score_adj -998, and every process the agent starts inherits it. When memory runs
 * out, the kernel then kills a process outside the container instead, most likely the service that carries the run's
 * stream. The run is lost with no result ("The AgentCore run ended without a result."), although the runner itself is
 * fine. Tested on the Claude runtime: the same memory-hungry command lost the run, until it was marked kill-first.
 *
 * The guard watches the processes the runner started (its descendants):
 *  - it marks each one kill-first (oom_score_adj 1000), so the kernel stops the agent's command and not the machine's
 *    own services. The runner and the agent engine (Claude Code, kiro-cli) are not marked: they hold the run;
 *  - when free memory drops under a floor, it stops the biggest marked process itself, before the kernel has to;
 *  - it reports each stop (its own, or the kernel's), so the person and the agent see why the command ended.
 *
 * Linux only (it reads /proc). Self-contained (node built-ins only) because the Docker images copy this file into the
 * runners as shared/.
 */

import fs from 'node:fs';

/** oom_score_adj of a process the kernel should stop first. */
export const KILL_FIRST = 1000;

export interface MemInfo { totalKb: number; availableKb: number }

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** The program (argv[0]). */
  exe: string;
  /** The whole command line, arguments joined by spaces. */
  command: string;
}

/** What the guard reads and does: /proc on Linux, a stand-in in tests. */
export interface ProcSource {
  meminfo(): MemInfo | null;
  processes(): ProcInfo[];
  oomScoreAdj(pid: number): number | null;
  setOomScoreAdj(pid: number, value: number): boolean;
  rssKb(pid: number): number | null;
  kill(pid: number): boolean;
  /** The kernel's count of processes it killed for memory, or null when unknown. */
  oomKills(): number | null;
}

export interface MemoryStop {
  by: 'guard' | 'kernel';
  /** The stopped command (the guard's own stops only; the kernel does not say which one it stopped). */
  pid?: number;
  command?: string;
  rssKb?: number;
  availableKb: number;
  totalKb: number;
  at: number;
  /** Counts up from 1 with each stop. */
  seq: number;
}

export interface MemoryGuardOptions {
  source: ProcSource;
  /** The runner: its descendants are watched; it is never marked or stopped. */
  rootPid: number;
  /** Processes that hold the run (the agent engine): never marked or stopped. */
  protect?: (p: ProcInfo) => boolean;
  /** Stop the biggest command when free memory is under this. Default: a tenth of the memory, 256 MB to 1 GB. */
  floorKb?: number;
  /** After a stop, wait this long before stopping another (freed memory takes a moment to show). */
  cooldownMs?: number;
  onStop?: (stop: MemoryStop) => void;
  /** Structured log lines (CloudWatch). */
  log?: (event: Record<string, unknown>) => void;
  now?: () => number;
}

// ── Reading /proc ────────────────────────────────────────────────────────────

/** MemTotal and MemAvailable from /proc/meminfo, in kB. */
export function parseMeminfo(text: string): MemInfo | null {
  const kb = (name: string): number | null => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const totalKb = kb('MemTotal');
  const availableKb = kb('MemAvailable');
  return totalKb != null && availableKb != null ? { totalKb, availableKb } : null;
}

/** The parent pid from /proc/<pid>/stat. The program name (in brackets) may hold spaces and brackets of its own. */
export function parseStatPpid(text: string): number | null {
  const end = text.lastIndexOf(')');
  if (end < 0) return null;
  const fields = text.slice(end + 2).split(' ');
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

/** VmRSS from /proc/<pid>/status, in kB. */
export function parseStatusRssKb(text: string): number | null {
  const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(text);
  return m ? Number(m[1]) : null;
}

const read = (file: string): string | null => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
};

/** /proc of this machine, or null where there is none (macOS, Windows). */
export function linuxProcSource(): ProcSource | null {
  if (process.platform !== 'linux' || read('/proc/meminfo') == null) return null;
  return {
    meminfo: () => { const t = read('/proc/meminfo'); return t ? parseMeminfo(t) : null; },
    processes: () => {
      const out: ProcInfo[] = [];
      let names: string[] = [];
      try { names = fs.readdirSync('/proc'); } catch { return out; }
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        const stat = read(`/proc/${name}/stat`);
        const ppid = stat ? parseStatPpid(stat) : null;
        if (ppid == null) continue;
        const args = (read(`/proc/${name}/cmdline`) ?? '').split('\0').filter(Boolean);
        out.push({ pid: Number(name), ppid, exe: args[0] ?? '', command: args.join(' ') });
      }
      return out;
    },
    oomScoreAdj: (pid) => { const t = read(`/proc/${pid}/oom_score_adj`); return t == null ? null : Number(t.trim()); },
    setOomScoreAdj: (pid, value) => {
      try { fs.writeFileSync(`/proc/${pid}/oom_score_adj`, String(value)); return true; } catch { return false; }
    },
    rssKb: (pid) => { const t = read(`/proc/${pid}/status`); return t ? parseStatusRssKb(t) : null; },
    kill: (pid) => { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } },
    oomKills: () => {
      const m = /^oom_kill\s+(\d+)/m.exec(read('/proc/vmstat') ?? '');
      return m ? Number(m[1]) : null;
    },
  };
}

// ── Deciding ─────────────────────────────────────────────────────────────────

/** A tenth of the memory, at least 256 MB and at most 1 GB. */
export function defaultFloorKb(totalKb: number): number {
  return Math.round(Math.min(1024 * 1024, Math.max(256 * 1024, totalKb / 10)));
}

/** The processes under root (not root itself). A process whose parent chain does not reach root is left out. */
export function descendantsOf(rootPid: number, procs: ProcInfo[]): ProcInfo[] {
  const children = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    if (p.pid === rootPid) continue;
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const out: ProcInfo[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

const gb = (kb: number): string => `${(kb / 1024 / 1024).toFixed(1)} GB`;
const shortCommand = (command: string): string => (command.length > 120 ? `${command.slice(0, 117)}…` : command);

/** What the person sees in the session when a command was stopped. */
export function describeStop(stop: MemoryStop): string {
  const machine = gb(stop.totalKb);
  if (stop.by === 'kernel') {
    return `The machine ran out of memory (${machine}), so it stopped a command the agent was running. The run goes on.`;
  }
  return `Stopped \`${shortCommand(stop.command ?? 'a command')}\`: it was using ${gb(stop.rssKb ?? 0)} and the machine (${machine}) was almost out of memory. The run goes on.`;
}

/** What the agent is told after a tool call during which a command was stopped for memory. */
export function agentNote(stops: MemoryStop[]): string | null {
  if (!stops.length) return null;
  const machine = gb(stops[stops.length - 1].totalKb);
  const named = stops.filter((s) => s.command).map((s) => `\`${shortCommand(s.command!)}\``);
  const what = named.length ? `stopped ${named.join(', ')}` : 'stopped the biggest command';
  return `This machine has ${machine} of memory and it ran out while this ran, so it ${what} (a command that ends with "Killed" or exit code 137 was stopped this way). `
    + 'Do not run it again unchanged. Use less memory: check or test one package, project or file at a time, '
    + 'and avoid running several heavy commands at once.';
}

// ── The guard ────────────────────────────────────────────────────────────────

export class MemoryGuard {
  readonly stops: MemoryStop[] = [];
  private readonly opts: MemoryGuardOptions;
  private readonly now: () => number;
  private lastStopAt = -Infinity;
  private seq = 0;
  private lastOomKills: number | null;
  private markFailures = 0;
  private loggedMarkFailure = false;

  constructor(opts: MemoryGuardOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.lastOomKills = opts.source.oomKills();
  }

  /** One look: mark new processes, stop the biggest one if memory is nearly gone, note the kernel's stops. */
  tick(): void {
    const { source } = this.opts;
    const watched = descendantsOf(this.opts.rootPid, source.processes()).filter((p) => !this.isProtected(p));

    for (const p of watched) {
      if (source.oomScoreAdj(p.pid) === KILL_FIRST) continue;
      if (source.setOomScoreAdj(p.pid, KILL_FIRST)) continue;
      // The process may have just ended; only a failure on a live one matters.
      if (source.oomScoreAdj(p.pid) == null) continue;
      this.markFailures++;
      if (!this.loggedMarkFailure) {
        this.loggedMarkFailure = true;
        this.opts.log?.({ event: 'memory_guard_mark_failed', pid: p.pid, command: shortCommand(p.command) });
      }
    }

    const mem = source.meminfo();
    const oomKills = source.oomKills();
    if (mem && oomKills != null && this.lastOomKills != null && oomKills > this.lastOomKills) {
      this.record({ by: 'kernel', availableKb: mem.availableKb, totalKb: mem.totalKb, at: this.now() });
    }
    if (oomKills != null) this.lastOomKills = oomKills;

    if (!mem) return;
    const floor = this.opts.floorKb ?? defaultFloorKb(mem.totalKb);
    if (mem.availableKb >= floor) return;
    if (this.now() - this.lastStopAt < (this.opts.cooldownMs ?? 3000)) return;

    let victim: { p: ProcInfo; rssKb: number } | null = null;
    for (const p of watched) {
      const rssKb = source.rssKb(p.pid);
      if (rssKb != null && (!victim || rssKb > victim.rssKb)) victim = { p, rssKb };
    }
    if (!victim || !source.kill(victim.p.pid)) return;
    this.lastStopAt = this.now();
    this.record({ by: 'guard', pid: victim.p.pid, command: victim.p.command, rssKb: victim.rssKb, availableKb: mem.availableKb, totalKb: mem.totalKb, at: this.lastStopAt });
  }

  /** Looks every intervalMs until the returned function is called. A failing look never stops the runner. */
  start(intervalMs = 250): () => void {
    const timer = setInterval(() => {
      try { this.tick(); } catch (e) { this.opts.log?.({ event: 'memory_guard_error', error: String((e as Error)?.message ?? e).slice(0, 200) }); }
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Processes the guard could not mark kill-first (they keep AgentCore's setting). */
  get unmarked(): number { return this.markFailures; }

  private isProtected(p: ProcInfo): boolean {
    return p.pid === process.pid || (this.opts.protect?.(p) ?? false);
  }

  private record(fields: Omit<MemoryStop, 'seq'>): void {
    const stop: MemoryStop = { ...fields, seq: ++this.seq };
    this.stops.push(stop);
    if (this.stops.length > 50) this.stops.shift();
    this.opts.log?.({
      event: 'memory_guard_stop', by: stop.by, ...(stop.pid ? { pid: stop.pid } : {}),
      ...(stop.command ? { command: shortCommand(stop.command) } : {}),
      ...(stop.rssKb != null ? { rssMb: Math.round(stop.rssKb / 1024) } : {}),
      availableMb: Math.round(stop.availableKb / 1024), totalMb: Math.round(stop.totalKb / 1024),
    });
    this.opts.onStop?.(stop);
  }
}

/**
 * Starts the guard for a runner, or returns null when it should not run. It runs by default only as the container's
 * main process (pid 1), so a runner started on someone's own Linux machine never marks or stops their processes.
 * AGENT_RUNNER_MEMORY_GUARD=on starts it anyway, =off never.
 */
export function startRunnerMemoryGuard(opts: Omit<MemoryGuardOptions, 'source' | 'rootPid'> & { env?: NodeJS.ProcessEnv; intervalMs?: number }): MemoryGuard | null {
  const setting = String((opts.env ?? process.env).AGENT_RUNNER_MEMORY_GUARD ?? '').toLowerCase();
  if (setting === 'off' || (setting !== 'on' && process.pid !== 1)) return null;
  const source = linuxProcSource();
  if (!source) return null;
  const guard = new MemoryGuard({ ...opts, source, rootPid: process.pid });
  guard.start(opts.intervalMs);
  const mem = source.meminfo();
  opts.log?.({
    event: 'memory_guard_started',
    totalMb: mem ? Math.round(mem.totalKb / 1024) : null,
    floorMb: mem ? Math.round((opts.floorKb ?? defaultFloorKb(mem.totalKb)) / 1024) : null,
    oomScoreAdj: source.oomScoreAdj(process.pid),
  });
  return guard;
}

/**
 * Claude Code hooks that run after every tool call (finished or failed). When the memory guard or the kernel stopped a
 * command during the call, the agent gets a note saying so: otherwise it sees only "Killed" and tends to run it again.
 */
export function claudeCodeMemoryHooks(memoryNote: () => string | null): Record<string, Array<{ hooks: Array<(input: unknown) => Promise<Record<string, unknown>>> }>> {
  const after = async (input: unknown): Promise<Record<string, unknown>> => {
    const note = memoryNote();
    if (!note) return {};
    const failed = (input as { hook_event_name?: string } | null)?.hook_event_name === 'PostToolUseFailure';
    return { hookSpecificOutput: { hookEventName: failed ? 'PostToolUseFailure' : 'PostToolUse', additionalContext: note } };
  };
  return { PostToolUse: [{ hooks: [after] }], PostToolUseFailure: [{ hooks: [after] }] };
}

/**
 * Notes for the agent, one per tool call: what was stopped for memory since the last note. Hand it to the engine's
 * after-tool hook (claudeCodeMemoryHooks for Claude Code).
 */
export function memoryNotes(guard: MemoryGuard | null): () => string | null {
  let lastSeq = guard?.stops.at(-1)?.seq ?? 0;
  return () => {
    if (!guard) return null;
    const fresh = guard.stops.filter((s) => s.seq > lastSeq);
    if (fresh.length) lastSeq = fresh[fresh.length - 1].seq;
    return agentNote(fresh);
  };
}
