# Plan: agent runs that outlast the 15-minute Lambda limit

Status: proposal, not started. Nothing here has been built or tested against a real AgentCore run.

## Problem

An agent run stops at about 14 minutes, whatever the "Run timeout" setting says (default 60 minutes).

What the code does today:

- A run executes inside a self-invoked Lambda (`runInBackground('execute-run', ...)` in `server/workflows/driver.ts`). Lambda's hard maximum is 15 minutes (`infra/lib/portal-stack.ts`), and `PORTAL_RUN_TIMEOUT_MS` is set to 14 minutes to end the run just before that.
- The portal reads the agent's output as one open stream (`invokeAgentCore` in `server/agent/claude-agentcore.ts`, `kiro-agentcore.ts`, `codex-agentcore.ts`).
- The runner container stops the run when that stream closes (`res.on('close', () => { if (!res.writableFinished) stop.abort(); })` in `agent-runner/src/index.ts`).

So the stream cannot be dropped and picked up later: closing it ends the run. The agent containers themselves can live far longer (`maxLifetime` is now 8 hours).

Raising `PORTAL_RUN_TIMEOUT_MS` alone does nothing, because Lambda stops the request at 15 minutes regardless.

## Design: detach the run from the connection, hand over between Lambdas

### Runner side

1. **Runs survive a closed connection.** A run is registered in memory by `runId`. Closing the stream no longer aborts it. Only an explicit stop request (`{ action: 'stop', runId }`) or the run's own limit does.
2. **Numbered event buffer.** Every event the run emits gets a sequence number and is kept in a bounded buffer (large screenshots and file payloads need a size cap or spill to disk; to be decided in slice 1).
3. **Attach.** A new request `{ action: 'attach', runId, fromSeq }` replays buffered events from `fromSeq`, then continues live until the run ends. If the run is already finished, it replays to the end and closes.
4. **Busy reporting.** While a run is active with no connection, `/ping` keeps reporting HealthyBusy (it already does this for runs waiting for approval), so the idle timeout does not release the session.

### Portal side

1. **Handover instead of timeout.** When a Lambda is near its limit (about 13 minutes), the engine stops reading and returns a handover with a small carry record instead of failing: the text so far, cost and token totals, the repository changes seen, the list of files already received, and `lastSeq`.
2. **Continue job.** The run lifecycle stores the carry and starts a new `continue-run` background job. The new Lambda re-attaches with `fromSeq = lastSeq + 1`, restores the carry and carries on with the same event handling. This repeats until the run finishes or reaches the real limit (the "Run timeout" setting, and the session's 8-hour lifetime).
3. **No duplicates.** Sequence numbers make the re-attach exact, so events are neither lost nor repeated.
4. **Stop button.** It sends the explicit stop request to the runner, as well as ending the portal's own handling.
5. **Files.** Files received before a handover must already be saved outside the Lambda's temporary storage. `persistFile` mirrors files to S3 today; the continue job must rebuild the work folder from that. To be checked in slice 2.
6. **Orphan watchdog.** If the continue job fails to start, the run would keep going unobserved. The existing scheduled tick looks for runs marked running with no active Lambda and restarts the attach, or fails the run clearly after a grace period.

## Slices

1. **Runner (Claude engine):** detach, buffer, attach, stop; unit tests on a fake event source.
2. **Portal (Claude engine):** carry record, handover, `continue-run` job, file restore; tests with a fake runtime that replays events across two "Lambdas".
3. **One real long run on AgentCore** (about 20 minutes of paid agent time): confirm the run survives the handover, nothing is duplicated, and files and cost totals are right. Needs your go-ahead.
4. **Kiro and Codex engines**, using the same runner pattern.
5. **Watchdog, docs, and removing the 14-minute cap** (`PORTAL_RUN_TIMEOUT_MS` then comes from the Run timeout setting).

## Risks and unverified assumptions

- **Not verified:** that AgentCore routes a second request with the same session id to the same container while no first request is open. This is the main assumption and slice 3 tests it. If it is false, the design needs a different way to reach the run (for example the runner posting events to the portal).
- **Memory:** the event buffer grows with the run; it needs a cap, and a long run with many screenshots could hit it.
- **Approvals and terminals** that wait on a person pass through the stream today; their handling across a handover needs its own test.
- **Three engines** have separate runners, so the work is repeated three times (slice 4).
- **Cost:** longer runs cost more agent time. Today's 14-minute cap acts as an accidental spending limit; the "Run timeout" and budget settings become the real limits.

## Alternatives considered

- **Move the portal off Lambda (ECS Fargate or App Runner):** removes the cap everywhere with little code change, but gives up the current serverless setup and adds always-on cost. Reasonable if the Lambda design is not kept for other reasons.
- **Re-attach without runner changes:** not possible; the runner stops when the connection closes.
