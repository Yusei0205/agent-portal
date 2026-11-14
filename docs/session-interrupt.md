# Interrupting a turn, and messages sent during one

The same behaviour on every engine, as in the terminal agents (Claude Code, Kiro, Codex):

| | What happens |
|---|---|
| **Esc** (in the message box or on the page), **Ctrl+C** (with nothing selected), the header **Stop**, **Stop this turn and send now** | `POST /api/projects/:id/workflows/:wid/cancel` with a `source`. It ends **only the current turn**. The session is `paused` with `stop_reason: interrupted`: it is **not** "resumable", so there is nothing to reopen and the next message just goes on. The request is audited as `session.interrupt` with its source. |
| **Kiro** | The runner sends ACP `session/cancel`: kiro-cli ends the prompt and **stays** (same process, same conversation). If it does not end it within 8 s, it is stopped the hard way and the next message starts a new kiro-cli with a recap. |
| **Claude Code** | The query is aborted; the SDK transcript is kept and the next message resumes it (or starts with a recap when there is no saved session yet). |
| **Codex** | `turn/interrupt` ends the turn; the runner then **saves the conversation state** with the interrupted turn in it (thread and state snapshot), so the next message continues the same thread. |
| **What the next turn knows** | The recap (`server/agent/recap.ts`) includes the interrupted turn: the person's request and what the agent had said so far, marked as stopped before it finished. |
| **A message sent while a turn runs** | It is saved but only read when a turn **starts**. The chat says so (with **Stop this turn and send now**). When the turn ends, or finishes being interrupted, the portal **starts the next turn by itself** for a waiting message (`continueWithQueuedMessages`). |
| **Files attached to a follow-up message** | Written into the run's work folder on **every** turn: Claude and Codex runners do it each invocation; the Kiro runner now also does it for a session that carries on in the same kiro-cli (it used to do it only for a fresh one). |

Tests: `test/queued-messages.test.ts` (portal), `test/kiro-runner-interrupt.test.ts` (real runner against a fake kiro-cli; Linux/macOS), `test/codex-runner.test.ts`, `test/web-stop-shortcut.test.ts`.
