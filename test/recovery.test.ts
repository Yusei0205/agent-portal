/**
 * A turn cut off by something that is not the person (a dropped connection to the runner, a lost process, the runner's time limit) must
 * not leave the session quiet: the person is told (inbox), the next turn gets what it needs to carry on (recap + a brief of what the
 * cut-off turn had done), and the leftover task goes on by itself, a limited number of times in a row.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup, createTestServer, fetchJson } from './fixtures.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { all } from '../server/db.ts';
import { queuedDeps, sweepLostRuns } from '../server/workflows/driver.ts';
import {
  interruptionOf, buildRecoveryBrief, recoverAfterInterruption, trailingRecoveries, RECOVERY_PREFIX, MAX_AUTO_RECOVERIES,
} from '../server/workflows/recovery.ts';
import { AgentCoreStallError } from '../server/agent/kiro-agentcore.ts';
import { _setEngineOverride } from '../server/agent/runner.ts';
import { HttpError } from '../server/util.ts';

describe('what counts as an interruption', () => {
  it('a dropped connection and the runner time limit do; the agent failing, a Stop and an ordinary error do not', () => {
    assert.equal(interruptionOf(new AgentCoreStallError(95))?.kind, 'connection-lost', 'the real error class is recognised');
    assert.equal(interruptionOf(new HttpError(504, 'AgentCore kiro-run timed out'))?.kind, 'timed-out');
    assert.equal(interruptionOf(new HttpError(500, 'kiro-cli exited with code 1')), null);
    assert.equal(interruptionOf(new HttpError(504, 'Gateway busy')), null, 'a 504 that is not a time limit');
    assert.equal(interruptionOf(new DOMException('Run cancelled', 'AbortError')), null, 'the person pressing Stop');
    assert.equal(interruptionOf(new Error('boom')), null);
    assert.equal(interruptionOf(null), null);
  });

  it("Kiro's own service dropping the connection counts too (the error a real session showed), but an ordinary Kiro failure does not", () => {
    const real = new Error('AgentCore kiro-run error: ACP error: ACP error -32603: Internal error (Encountered an error in the response stream: An unknown error occurred: dispatch failure) [session/prompt]');
    const hit = interruptionOf(real);
    assert.equal(hit?.kind, 'engine-connection');
    assert.match(hit!.why, /engine's service had a connection problem/);
    assert.equal(interruptionOf(new Error('kiro-cli exited with code 1')), null);
    assert.equal(interruptionOf(new Error('Kiro credential has no API key stored')), null);
    assert.equal(interruptionOf(new Error('ACP error -32602: Invalid params')), null, 'a different ACP error is the agent or the request, not the connection');
  });

  it("the engine's process stopping mid-turn counts (the runner's 29-minute turn limit shows up only as this text), a start-up failure does not", () => {
    const real = new Error('AgentCore kiro-run error: ACP error: kiro-cli process exited');
    const hit = interruptionOf(real);
    assert.equal(hit?.kind, 'engine-stopped');
    assert.match(hit!.why, /process stopped before the turn finished/);
    assert.equal(interruptionOf(new Error('kiro-cli exited with code 1')), null, 'it never started: an ordinary failure');
  });

  it('counts the recoveries sent in a row since the person last wrote', () => {
    assert.equal(trailingRecoveries([]), 0);
    assert.equal(trailingRecoveries(['check the scan']), 0);
    assert.equal(trailingRecoveries(['check the scan', `${RECOVERY_PREFIX} Continue`]), 1);
    assert.equal(trailingRecoveries([`${RECOVERY_PREFIX} a`, 'my reply', `${RECOVERY_PREFIX} b`, `${RECOVERY_PREFIX} c`]), 2);
    assert.equal(trailingRecoveries([`${RECOVERY_PREFIX} a`, `${RECOVERY_PREFIX} b`, 'my reply']), 0, 'a message from the person resets it');
  });
});

describe('recovering a session', () => {
  let baseUrl = '', cookie = '', projectId = '';
  const repo = () => getSessionsRepository();
  const realStart = queuedDeps.startRun;

  before(async () => {
    createTestDb();
    baseUrl = (await createTestServer()).baseUrl;
    cookie = (await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: `rec-${Date.now()}@test.com`, name: 'Admin', password: 'password1234', provider: 'demo' } })).cookie ?? '';
    projectId = (((await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: `Rec-${Date.now()}` }, cookie })).body as any).project as any).id;
  });
  afterEach(() => { queuedDeps.startRun = realStart; _setEngineOverride(null); });
  after(async () => { queuedDeps.startRun = realStart; _setEngineOverride(null); await cleanup(); });

  const session = async (goal = 'Check the scan', engine = 'demo'): Promise<string> => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', cookie, body: { goal, engine, start: false } });
    return String(((r.body as any).workflow ?? r.body).id);
  };
  const say = (wid: string, body: string, kind = 'human') =>
    repo().appendWorkflowEvent({ workflow_id: wid, kind, body, data: '{}', created_at: new Date().toISOString() });
  /** The person's request that the cut-off turn had already read (so it is not a message waiting for the next turn). */
  const asked = async (wid: string, body: string): Promise<void> => {
    await say(wid, body);
    const pending = await repo().listUnconsumedWorkflowEvents(wid);
    await repo().markWorkflowEventsConsumedUpTo(wid, pending[pending.length - 1].id);
  };
  /** What a started turn does first: read the messages that were waiting. */
  const turnReads = async (wid: string): Promise<void> => {
    const pending = await repo().listUnconsumedWorkflowEvents(wid);
    if (pending.length) await repo().markWorkflowEventsConsumedUpTo(wid, pending[pending.length - 1].id);
  };
  /** A cut-off turn: its run, with the steps it took and what it said, as the portal saved them. */
  const cutOffTurn = async (wid: string, steps: string[], said: string[]): Promise<string> => {
    const id = `run-${Math.random().toString(36).slice(2, 10)}`;
    const t = new Date(Date.now() - 3600_000).toISOString();
    await repo().createRun({ id, workflow_id: wid, status: 'failed', started_at: t, finished_at: t, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: t });
    for (const s of steps) await repo().appendRunEvent(id, 'tool-start', JSON.stringify({ toolName: s, toolInput: '{}' }), new Date().toISOString());
    for (const s of said) await repo().appendRunEvent(id, 'assistant-text', JSON.stringify({ text: s, stream: true }), new Date().toISOString());
    return id;
  };
  const inboxOf = (wid: string) => all<{ type: string; payload: string; project_id: string; run_id: string }>('SELECT type, payload, project_id, run_id FROM p6_inbox WHERE workflow_id = ? ORDER BY created_at', wid)
    .map((i) => ({ ...i, payload: JSON.parse(i.payload) as Record<string, unknown> }));
  const humans = async (wid: string) => (await repo().listHumanWorkflowEvents(wid, null, null, null)).map((m) => String(m.body));

  it('the brief tells the agent what it was asked, the last steps it took and what it last said, and to carry on without starting over', async () => {
    const wid = await session();
    await asked(wid, 'Check through the sonarqube scanning result and say which findings need a fix');
    const steps = Array.from({ length: 15 }, (_, i) => `Running: grep -n finding${i + 1} report.txt`);
    const rid = await cutOffTurn(wid, steps, ['I found ', 'that 12 of the 20 findings are in vendored code. '.repeat(3)]);

    const brief = await buildRecoveryBrief(wid, rid, 'the connection to the runner was lost');
    assert.match(brief, /cut off before you finished: the connection to the runner was lost/);
    assert.match(brief, /What you were asked:\nCheck through the sonarqube scanning result/);
    assert.match(brief, /15 steps; the last ones/);
    assert.ok(brief.includes('finding15') && brief.includes('finding4'), 'the last twelve steps');
    assert.ok(!brief.includes('finding3 ') && !brief.includes('finding1 '), 'not the earliest ones');
    assert.match(brief, /What you had said last:\nI found that 12 of the 20 findings/);
    assert.match(brief, /Do not start over and do not repeat what is finished/);
    assert.match(brief, /check the state of the work/);
    assert.match(brief, /kept in \/tmp .* is gone when a turn is cut off/, 'told that /tmp does not survive, so it keeps work in the work folder');
    assert.match(brief, /inside the work folder, not in \/tmp/);
  });

  it('the brief asks about the person\'s own message, not a recovery the portal sent', async () => {
    const wid = await session();
    await asked(wid, 'Fix the failing build');
    await asked(wid, `${RECOVERY_PREFIX} Continue where you left off (the last turn was cut off: x).`);
    const brief = await buildRecoveryBrief(wid, null, 'it did not finish');
    assert.match(brief, /What you were asked:\nFix the failing build/);
  });

  it('tells the person in the inbox and, on its own, queues a continue message and starts the next turn', async () => {
    const wid = await session();
    await asked(wid, 'Check the scan');
    const rid = await cutOffTurn(wid, ['Running: ls', 'Running: grep -rn secret .'], ['Looking at the scan.']);
    const started: string[] = [];
    queuedDeps.startRun = (async (id: string) => { started.push(id); return 'next-run'; }) as typeof realStart;

    const out = await recoverAfterInterruption(wid, rid, 'the connection to the runner was lost');
    assert.deepEqual(out, { notified: true, continued: true });
    assert.deepEqual(started, [wid], 'the turn was started');

    const pending = await repo().listUnconsumedWorkflowEvents(wid);
    const msg = pending.filter((e) => e.kind === 'human').pop()!;
    assert.ok(String(msg.body).startsWith(RECOVERY_PREFIX), msg.body);
    assert.match(String(msg.body), /Continue where you left off \(the last turn was cut off: the connection to the runner was lost\)/);
    const data = JSON.parse(String(msg.data)) as { by: string; recovery: boolean; prompt: string };
    assert.equal(data.by, 'system');
    assert.equal(data.recovery, true);
    assert.match(data.prompt, /grep -rn secret/, 'the agent is given the brief, not just the short line');
    const { eventPrompt } = await import('../server/workflows/session-commands.ts');
    assert.equal(eventPrompt(msg), data.prompt, 'the run uses the brief as its prompt');

    const [item] = inboxOf(wid);
    assert.equal(item.type, 'blocked');
    assert.equal(item.project_id, projectId);
    assert.equal(item.run_id, rid);
    assert.equal(item.payload.kind, 'turn-interrupted');
    assert.equal(item.payload.continued, true);
    assert.equal(item.payload.canContinue, false);
    assert.match(String(item.payload.message), /portal is continuing it/);
  });

  it('stops carrying on by itself after two in a row (the person is told, and can press Continue), and a message from the person starts the count again', async () => {
    const wid = await session();
    await asked(wid, 'Check the scan');
    const rid = await cutOffTurn(wid, ['Running: ls'], ['hi']);
    const started: string[] = [];
    queuedDeps.startRun = (async (id: string) => { started.push(id); return 'next-run'; }) as typeof realStart;

    for (let i = 0; i < MAX_AUTO_RECOVERIES; i++) {
      assert.equal((await recoverAfterInterruption(wid, rid, 'it was cut off')).continued, true, `recovery ${i + 1}`);
      await turnReads(wid);
    }
    const third = await recoverAfterInterruption(wid, rid, 'it was cut off');
    assert.deepEqual(third, { notified: true, continued: false }, 'no third automatic turn');
    assert.equal(started.length, MAX_AUTO_RECOVERIES);
    const last = inboxOf(wid).pop()!;
    assert.equal(last.payload.continued, false);
    assert.equal(last.payload.canContinue, true, 'the Continue button is offered instead');
    assert.match(String(last.payload.message), /press Continue, or send a message/);
    assert.equal((await humans(wid)).filter((b) => b.startsWith(RECOVERY_PREFIX)).length, MAX_AUTO_RECOVERIES, 'no third message was written');

    await asked(wid, 'yes, keep going');
    assert.equal((await recoverAfterInterruption(wid, rid, 'it was cut off')).continued, true, 'the count started again');
  });

  it('a message the person sent while the turn was going is the next instruction, and no recovery message is added', async () => {
    const wid = await session();
    const rid = await cutOffTurn(wid, ['Running: ls'], ['hi']);
    await say(wid, 'actually only look at the Lambda code');
    const started: string[] = [];
    queuedDeps.startRun = (async (id: string) => { started.push(id); return 'next-run'; }) as typeof realStart;
    const out = await recoverAfterInterruption(wid, rid, 'the connection to the runner was lost');
    assert.equal(out.continued, true);
    assert.deepEqual(started, [wid]);
    assert.equal((await humans(wid)).filter((b) => b.startsWith(RECOVERY_PREFIX)).length, 0);
    assert.equal(inboxOf(wid).length, 1, 'the person is still told');
  });

  it('with automatic continuing off it only tells the person', async () => {
    const wid = await session();
    const rid = await cutOffTurn(wid, [], []);
    queuedDeps.startRun = (async () => { assert.fail('must not start a turn'); }) as typeof realStart;
    const out = await recoverAfterInterruption(wid, rid, 'the connection to the runner was lost', { auto: false });
    assert.deepEqual(out, { notified: true, continued: false });
    assert.equal(inboxOf(wid)[0].payload.canContinue, true);
  });

  it('/continue by hand sends the same brief as the prompt, shown in the chat as the person typed it', async () => {
    const wid = await session('Check the scan', 'kiro'); // a demo session answers every slash command itself
    await asked(wid, 'Check the scan and list what needs fixing');
    await cutOffTurn(wid, ['Running: sed -n 1,20p findings.txt'], ['Reading the findings.']);
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wid}/message`, { method: 'POST', cookie, body: { message: '/continue' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const msg = all<{ body: string; data: string }>("SELECT body, data FROM p6_workflow_events WHERE workflow_id = ? AND body = '/continue'", wid)[0];
    assert.ok(msg, 'the command was saved as a message to the agent');
    assert.equal(msg.body, '/continue');
    const prompt = (JSON.parse(String(msg.data)) as { prompt: string }).prompt;
    assert.match(prompt, /Check the scan and list what needs fixing/);
    assert.match(prompt, /sed -n 1,20p findings\.txt/);
    assert.match(prompt, /Do not start over/);
    const menu = (await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wid}/commands`, { cookie })).body as { commands: Array<{ name: string }> };
    assert.ok(menu.commands.some((c) => c.name === 'continue'), 'it is in the command menu');
  });

  it('the sweep that closes a lost run also tells the person and carries on', async () => {
    const wid = await session();
    await asked(wid, 'Check the scan');
    const lost = `run-${Math.random().toString(36).slice(2, 10)}`;
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    await repo().createRun({ id: lost, workflow_id: wid, status: 'running', started_at: old, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: old });
    await repo().updateRun(lost, { heartbeat_at: new Date(Date.now() - 40 * 60_000).toISOString() });
    await repo().updateWorkflow(wid, { status: 'running', updated_at: old });
    const started: string[] = [];
    queuedDeps.startRun = (async (id: string) => { started.push(id); return 'next-run'; }) as typeof realStart;

    assert.ok(await sweepLostRuns() >= 1);
    assert.equal((await repo().getRunById(lost))!.status, 'failed');
    assert.deepEqual(started, [wid]);
    assert.ok((await humans(wid)).some((b) => b.startsWith(RECOVERY_PREFIX)));
    const [item] = inboxOf(wid);
    assert.equal(item.payload.kind, 'turn-interrupted');
    assert.match(String(item.payload.reason), /process running it was lost/);
  });

  it('end to end through the real runner: a turn whose connection drops fails, the person is told, and the portal runs the next turn, which finishes the task', async () => {
    const wid = await session('Check the scan');
    let turns = 0;
    const prompts: string[] = [];
    _setEngineOverride(async (ctx) => {
      turns++;
      prompts.push(ctx.run.goal);
      if (turns === 1) {
        ctx.emit('tool-start', { toolName: 'Running: grep -rn secret .', toolInput: '{}', toolCallId: 't1' });
        ctx.emit('assistant-text', { text: 'Scanning the code for secrets. ', stream: true });
        throw new AgentCoreStallError(95);
      }
      ctx.emit('assistant-text', { text: 'Finished the scan.', stream: true });
      return 'Finished the scan.';
    });
    const { startRun } = await import('../server/workflows/driver.ts');
    const first = await startRun(wid);

    const waitFor = async <T,>(f: () => Promise<T | undefined | false>, what: string): Promise<T> => {
      for (let i = 0; i < 200; i++) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
      throw new Error(`timed out waiting for ${what}`);
    };
    await waitFor(async () => (await repo().getRunById(first))?.status === 'failed', 'the first turn to fail');
    assert.match(String((await repo().getRunById(first))!.error), /Lost contact with the runner/);

    const second = await waitFor(async () => {
      const runs = all<{ id: string; status: string }>('SELECT id, status FROM p6_runs WHERE workflow_id = ? ORDER BY created_at', wid);
      return runs.length >= 2 && runs[1].status === 'done' ? runs[1].id : undefined;
    }, 'the next turn to finish');
    assert.notEqual(second, first);
    assert.equal(turns, 2, 'exactly one automatic turn');

    assert.ok((await humans(wid)).some((b) => b.startsWith(`${RECOVERY_PREFIX} Continue where you left off`)), 'the chat shows the portal carried on');
    const [item] = inboxOf(wid);
    assert.equal(item.payload.kind, 'turn-interrupted');
    assert.equal(item.payload.continued, true);
    assert.match(String(item.payload.reason), /connection to the runner was lost/);
    assert.equal(item.run_id, first);
    assert.match(prompts[1], /Scanning the code for secrets/, 'the second turn was given what the first had done');
    assert.match(prompts[1], /grep -rn secret/);
  });

  it('waits the given time before an automatic turn, so a retry does not hit the same hiccup', async () => {
    const wid = await session();
    await asked(wid, 'Check the scan');
    const rid = await cutOffTurn(wid, ['Running: ls'], ['hi']);
    let startedAt = 0;
    queuedDeps.startRun = (async () => { startedAt = Date.now(); return 'next-run'; }) as typeof realStart;
    const t0 = Date.now();
    const out = await recoverAfterInterruption(wid, rid, 'it was cut off', { delayMs: 250 });
    assert.equal(out.continued, true);
    assert.ok(startedAt - t0 >= 240, `started after ${startedAt - t0} ms`);
  });

  it('end to end: the engine service drops the connection mid-turn (the real error text), the person is told and the turn is carried on after the short wait', async () => {
    const was = process.env.PORTAL_ENGINE_RETRY_DELAY_MS;
    process.env.PORTAL_ENGINE_RETRY_DELAY_MS = '150';
    try {
      const wid = await session('Capture the console pages');
      let turns = 0;
      _setEngineOverride(async (ctx) => {
        turns++;
        if (turns === 1) {
          ctx.emit('tool-start', { toolName: 'Running: @browser/capture', toolInput: '{}', toolCallId: 't1' });
          throw new Error('AgentCore kiro-run error: ACP error: ACP error -32603: Internal error (Encountered an error in the response stream: An unknown error occurred: dispatch failure) [session/prompt]');
        }
        return 'Captured the pages.';
      });
      const { startRun } = await import('../server/workflows/driver.ts');
      await startRun(wid);
      for (let i = 0; i < 200; i++) {
        const runs = all<{ status: string }>('SELECT status FROM p6_runs WHERE workflow_id = ? ORDER BY created_at', wid);
        if (runs.length >= 2 && runs[1].status === 'done') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(turns, 2);
      const [item] = inboxOf(wid);
      assert.equal(item.payload.kind, 'turn-interrupted');
      assert.match(String(item.payload.reason), /engine's service had a connection problem/);
      assert.equal(item.payload.continued, true);
      assert.ok((await humans(wid)).some((b) => b.startsWith(RECOVERY_PREFIX)));
    } finally { if (was === undefined) delete process.env.PORTAL_ENGINE_RETRY_DELAY_MS; else process.env.PORTAL_ENGINE_RETRY_DELAY_MS = was; }
  });

  it('end to end: the runner stops a long turn at its limit ("kiro-cli process exited"): the person is told and the next turn carries on, with the /tmp warning in its prompt', async () => {
    const wid = await session('Generate the Excel of findings');
    const prompts: string[] = [];
    _setEngineOverride(async (ctx) => {
      prompts.push(ctx.run.goal);
      if (prompts.length === 1) {
        ctx.emit('tool-start', { toolName: 'Running: python3 build_report.py', toolInput: '{}', toolCallId: 't1' });
        throw new Error('AgentCore kiro-run error: ACP error: kiro-cli process exited');
      }
      return 'Wrote the Excel file.';
    });
    const { startRun } = await import('../server/workflows/driver.ts');
    await startRun(wid);
    for (let i = 0; i < 200; i++) {
      const runs = all<{ status: string }>('SELECT status FROM p6_runs WHERE workflow_id = ? ORDER BY created_at', wid);
      if (runs.length >= 2 && runs[1].status === 'done') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(prompts.length, 2, 'the portal ran the next turn by itself');
    const [item] = inboxOf(wid);
    assert.equal(item.payload.kind, 'turn-interrupted');
    assert.match(String(item.payload.reason), /process stopped before the turn finished/);
    assert.equal(item.payload.continued, true);
    assert.match(prompts[1], /Running: python3 build_report\.py/, 'what it had been doing');
    assert.match(prompts[1], /inside the work folder, not in \/tmp/);
  });

  it('a turn that keeps getting cut off is retried twice and then left for the person, with the inbox item to say so', async () => {
    const wid = await session('Check the scan');
    let turns = 0;
    _setEngineOverride(async () => { turns++; throw new AgentCoreStallError(95); });
    const { startRun } = await import('../server/workflows/driver.ts');
    await startRun(wid);
    for (let i = 0; i < 300 && inboxOf(wid).length < MAX_AUTO_RECOVERIES + 1; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(turns, MAX_AUTO_RECOVERIES + 1, 'the first turn and two automatic ones, no more');
    const items = inboxOf(wid);
    assert.equal(items.length, MAX_AUTO_RECOVERIES + 1);
    assert.equal(items.at(-1)!.payload.canContinue, true);
    assert.equal(items.at(-1)!.payload.continued, false);
  });
});
