/**
 * The runners' memory guard (server/agent/runner-memory.ts): commands the agent starts are marked kill-first and the
 * biggest one is stopped when memory is nearly gone, so a memory-hungry command no longer takes the run down with it.
 * A stand-in /proc plays the machine; one test reads the real /proc where there is one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KILL_FIRST, MemoryGuard, parseMeminfo, parseStatPpid, parseStatusRssKb, descendantsOf, defaultFloorKb, describeStop,
  agentNote, memoryNotes, claudeCodeMemoryHooks, linuxProcSource, startRunnerMemoryGuard,
  type ProcSource, type ProcInfo, type MemoryStop,
} from '../server/agent/runner-memory.ts';

const GB = 1024 * 1024; // in kB

/** A machine: processes with their memory and oom_score_adj, free memory, and what the guard did to it. */
function machine(procs: Array<ProcInfo & { rssKb: number; adj?: number }>, opts: { totalKb?: number; availableKb?: number; oomKills?: number; unwritable?: number[] } = {}) {
  const state = {
    procs: new Map(procs.map((p) => [p.pid, { ...p, adj: p.adj ?? -998 }])),
    totalKb: opts.totalKb ?? 8 * GB,
    availableKb: opts.availableKb ?? 7 * GB,
    oomKills: opts.oomKills ?? 0,
    killed: [] as number[],
  };
  const source: ProcSource = {
    meminfo: () => ({ totalKb: state.totalKb, availableKb: state.availableKb }),
    processes: () => [...state.procs.values()].map(({ pid, ppid, exe, command }) => ({ pid, ppid, exe, command })),
    oomScoreAdj: (pid) => state.procs.get(pid)?.adj ?? null,
    setOomScoreAdj: (pid, value) => {
      const p = state.procs.get(pid);
      if (!p || opts.unwritable?.includes(pid)) return false;
      p.adj = value;
      return true;
    },
    rssKb: (pid) => state.procs.get(pid)?.rssKb ?? null,
    kill: (pid) => {
      const p = state.procs.get(pid);
      if (!p) return false;
      state.procs.delete(pid);
      state.availableKb += p.rssKb;
      state.killed.push(pid);
      return true;
    },
    oomKills: () => state.oomKills,
  };
  return { state, source };
}

const proc = (pid: number, ppid: number, command: string, rssKb: number, adj?: number) => ({ pid, ppid, exe: command.split(' ')[0], command, rssKb, adj });
const CLAUDE = '/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude';
const protectClaude = (p: ProcInfo): boolean => p.exe.includes('claude-agent-sdk');

/** The cloud runner's tree: the runner (1), Claude Code (15), its shell (39) running tsc (40). */
function runnerTree(tscKb: number) {
  return [
    proc(1, 0, 'node dist/index.mjs', 110 * 1024),
    proc(15, 1, CLAUDE, 250 * 1024),
    proc(39, 15, '/bin/bash -c source /tmp/x && npx tsc --noEmit', 3 * 1024),
    proc(40, 39, 'node /work/node_modules/.bin/tsc --noEmit', tscKb),
  ];
}

describe('reading /proc', () => {
  it('reads total and available memory', () => {
    const text = 'MemTotal:        8209720 kB\nMemFree:         4110440 kB\nMemAvailable:    7538896 kB\nBuffers: 1 kB\n';
    assert.deepEqual(parseMeminfo(text), { totalKb: 8209720, availableKb: 7538896 });
    assert.equal(parseMeminfo('MemTotal: 10 kB\n'), null, 'an old kernel without MemAvailable: nothing to go on');
  });
  it('reads the parent pid even when the program name has spaces and brackets', () => {
    assert.equal(parseStatPpid('40 (node) S 39 40 1 0 -1 4194560'), 39);
    assert.equal(parseStatPpid('41 (my (odd) prog) R 7 41 1 0'), 7);
    assert.equal(parseStatPpid('garbage'), null);
  });
  it('reads a process\'s memory', () => {
    assert.equal(parseStatusRssKb('Name:\tnode\nVmPeak:\t 9 kB\nVmRSS:\t  253984 kB\n'), 253984);
    assert.equal(parseStatusRssKb('Name:\tkworker\n'), null, 'kernel threads have none');
  });
  it('the floor is a tenth of the memory, between 256 MB and 1 GB', () => {
    assert.equal(defaultFloorKb(8 * GB), Math.round(0.8 * GB));
    assert.equal(defaultFloorKb(1 * GB), 256 * 1024);
    assert.equal(defaultFloorKb(64 * GB), 1 * GB);
  });
});

describe('which processes the guard watches', () => {
  it('only the runner\'s descendants, not the runner itself', () => {
    const procs = [...runnerTree(100), proc(900, 0, 'someone-elses-program', 5), proc(901, 900, 'its-child', 5)];
    assert.deepEqual(descendantsOf(1, procs).map((p) => p.pid), [15, 39, 40]);
  });
  it('a broken parent chain cannot loop', () => {
    assert.deepEqual(descendantsOf(1, [proc(5, 6, 'a', 1), proc(6, 5, 'b', 1)]), []);
  });
});

describe('MemoryGuard', () => {
  it('marks the agent\'s commands kill-first, and leaves the runner and Claude Code alone', () => {
    const { state, source } = machine(runnerTree(500 * 1024));
    new MemoryGuard({ source, rootPid: 1, protect: protectClaude }).tick();
    assert.equal(state.procs.get(1)!.adj, -998, 'the runner');
    assert.equal(state.procs.get(15)!.adj, -998, 'Claude Code');
    assert.equal(state.procs.get(39)!.adj, KILL_FIRST, 'the shell');
    assert.equal(state.procs.get(40)!.adj, KILL_FIRST, 'tsc');
    assert.deepEqual(state.killed, [], 'plenty of memory: nothing stopped');
  });

  it('never touches processes outside the runner\'s tree', () => {
    const { state, source } = machine([...runnerTree(100), proc(900, 0, 'firefox', 6 * GB)], { availableKb: 0.1 * GB });
    new MemoryGuard({ source, rootPid: 1, protect: protectClaude }).tick();
    assert.equal(state.procs.get(900)!.adj, -998);
    assert.ok(!state.killed.includes(900));
  });

  it('stops the biggest command when memory is nearly gone, and says which one', () => {
    const stops: MemoryStop[] = [];
    const { state, source } = machine(runnerTree(6.4 * GB), { availableKb: 0.7 * GB });
    new MemoryGuard({ source, rootPid: 1, protect: protectClaude, onStop: (s) => stops.push(s) }).tick();
    assert.deepEqual(state.killed, [40]);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].by, 'guard');
    assert.equal(stops[0].command, 'node /work/node_modules/.bin/tsc --noEmit');
    assert.match(describeStop(stops[0]), /^Stopped `node \/work\/node_modules\/\.bin\/tsc --noEmit`: it was using 6\.4 GB and the machine \(8\.0 GB\) was almost out of memory\. The run goes on\.$/);
  });

  it('never stops Claude Code, even when it is the biggest', () => {
    const procs = runnerTree(10 * 1024);
    procs[1].rssKb = 7 * GB;
    const { state, source } = machine(procs, { availableKb: 0.5 * GB });
    new MemoryGuard({ source, rootPid: 1, protect: protectClaude }).tick();
    assert.deepEqual(state.killed, [40], 'the biggest of the others');
  });

  it('waits after a stop before stopping another', () => {
    let t = 1_000;
    const procs = [...runnerTree(3 * GB), proc(41, 39, 'node build.js', 2 * GB)];
    const { state, source } = machine(procs, { availableKb: 0.5 * GB });
    const guard = new MemoryGuard({ source, rootPid: 1, protect: protectClaude, now: () => t });
    guard.tick();
    state.availableKb = 0.5 * GB; // the freed memory has not shown yet
    t += 1_000;
    guard.tick();
    assert.deepEqual(state.killed, [40], 'one stop within the cooldown');
    t += 3_000;
    guard.tick();
    assert.deepEqual(state.killed, [40, 41], 'the next one after it');
  });

  it('notes a stop by the kernel', () => {
    const stops: MemoryStop[] = [];
    const { state, source } = machine(runnerTree(100), { oomKills: 2 });
    const guard = new MemoryGuard({ source, rootPid: 1, protect: protectClaude, onStop: (s) => stops.push(s) });
    guard.tick();
    assert.equal(stops.length, 0, 'kills before the guard started are not news');
    state.oomKills = 3;
    guard.tick();
    assert.equal(stops.length, 1);
    assert.equal(stops[0].by, 'kernel');
    assert.match(describeStop(stops[0]), /ran out of memory \(8\.0 GB\), so it stopped a command/);
  });

  it('logs once when it cannot mark a process, and keeps going', () => {
    const logs: Array<Record<string, unknown>> = [];
    const { state, source } = machine(runnerTree(100), { unwritable: [39, 40] });
    const guard = new MemoryGuard({ source, rootPid: 1, protect: protectClaude, log: (e) => logs.push(e) });
    guard.tick();
    guard.tick();
    assert.equal(logs.filter((e) => e.event === 'memory_guard_mark_failed').length, 1);
    assert.equal(guard.unmarked, 4);
    assert.equal(state.procs.get(40)!.adj, -998);
  });

  it('a look that throws never stops the runner', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const { source } = machine(runnerTree(100));
    source.processes = () => { throw new Error('boom'); };
    const stop = new MemoryGuard({ source, rootPid: 1, log: (e) => logs.push(e) }).start(5);
    await new Promise((r) => setTimeout(r, 40));
    stop();
    assert.ok(logs.some((e) => e.event === 'memory_guard_error'));
  });
});

describe('telling the agent', () => {
  it('a note names what was stopped and how to use less memory', () => {
    const note = agentNote([{ by: 'guard', command: 'npx tsc --noEmit', rssKb: 6 * GB, availableKb: 0.5 * GB, totalKb: 8 * GB, at: 1, seq: 1 }])!;
    assert.match(note, /8\.0 GB of memory/);
    assert.match(note, /stopped `npx tsc --noEmit`/);
    assert.match(note, /exit code 137/);
    assert.match(note, /Do not run it again unchanged/);
    assert.equal(agentNote([]), null);
  });

  it('each stop reaches the agent once, after the tool call it happened in', () => {
    const { source } = machine(runnerTree(6.4 * GB), { availableKb: 0.7 * GB });
    const guard = new MemoryGuard({ source, rootPid: 1, protect: protectClaude });
    const next = memoryNotes(guard);
    assert.equal(next(), null);
    guard.tick();
    assert.match(next() ?? '', /stopped `node \/work\/node_modules\/\.bin\/tsc --noEmit`/);
    assert.equal(next(), null, 'not again on the next tool call');
    assert.equal(memoryNotes(null)(), null, 'no guard (not Linux): never a note');
  });

  it('Claude Code hooks add the note after a finished or a failed tool call', async () => {
    const notes = ['the note', null];
    const hooks = claudeCodeMemoryHooks(() => notes.shift() ?? null);
    const failed = await hooks.PostToolUseFailure[0].hooks[0]({ hook_event_name: 'PostToolUseFailure' });
    assert.deepEqual(failed, { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 'the note' } });
    assert.deepEqual(await hooks.PostToolUse[0].hooks[0]({ hook_event_name: 'PostToolUse' }), {}, 'nothing to say: no output');
  });
});

describe('starting the guard', () => {
  it('runs only as the container\'s main process unless told otherwise', () => {
    assert.equal(startRunnerMemoryGuard({ env: {} }), null, 'a runner started by hand (not pid 1) leaves the machine alone');
    assert.equal(startRunnerMemoryGuard({ env: { AGENT_RUNNER_MEMORY_GUARD: 'off' } }), null);
  });

  it('reads this machine\'s /proc where there is one', { skip: process.platform !== 'linux' && 'Linux only' }, () => {
    const source = linuxProcSource()!;
    assert.ok(source.meminfo()!.totalKb > 0);
    const self = source.processes().find((p) => p.pid === process.pid)!;
    assert.ok(self && self.exe.length > 0, 'this test is listed');
    assert.ok((source.rssKb(process.pid) ?? 0) > 0);
    assert.equal(typeof source.oomScoreAdj(process.pid), 'number');
  });
});
