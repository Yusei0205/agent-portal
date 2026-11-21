# Cat Project Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The cat keeps its conversation per project in the browser and reads the project's approved memory facts.

**Architecture:** Pure storage helpers in `web/src/lib/cat-assistant.js` used by `CatChatPanel.jsx`; a project-level reader of approved facts in `server/agentcore-memory.ts` feeding a new prompt part in `server/assistant/prompt.ts` via `server/assistant/routes.ts`.

**Tech Stack:** React web, TypeScript server, node:test, Playwright smoke.

**Spec:** `docs/superpowers/specs/2026-11-21-cat-project-context-design.md`

## Global Constraints

- Storage key `portal.cat.chat.<userId>.<projectId or "portal">`; keep the newest 20 messages; drop an entry unused for 14 days; never save the greeting (id 0) or a pending reply.
- History sent to the server unchanged (`trimHistory`, last 8).
- Notes: approved facts only, facts namespace only, 3 s timeout, 2,500-character cap, `[]` on any failure or when memory is off/unavailable.
- Prompt part heading `[Approved project notes]`, inside the existing REFERENCE MATERIAL block, defanged; trimmed after knowledge, before guide and history.
- No new dependency. Tests: `node --disable-warning=ExperimentalWarning --import tsx --test <file>`; `npm run typecheck`; `npm run test:map:check`; `npm run build`.

## Review Focus

- Storage unavailable or corrupt JSON: the panel starts with the greeting and does not throw (test in Task 1).
- Two users on one browser: one never sees the other's chat (key includes user id; test in Task 1).
- Project switch while a reply is pending: the reply lands in the conversation it was asked in, not the new one (Task 1: pending is not saved; the switch reloads from storage).
- A note containing the end-of-reference marker cannot close the reference block (defang; test in Task 2).
- A member of project A asking with project B's id gets no B notes (existing membership check runs first; test in Task 2).

---

### Task 1: Conversation kept per project (web)

**Files:** Modify `web/src/lib/cat-assistant.js`, `web/src/components/CatChatPanel.jsx` (+ its CSS for the Clear chat button); Test `test/cat-assistant.test.ts` (extend), `test/ui/smoke.ts`.

**Interfaces (produces):**
- `chatKey(userId, projectId) -> string`
- `serialiseChat(messages, now) -> string` (JSON `{ savedAt, messages }`, messages filtered: id≠0, not pending, last 20, fields role/text/href/links/error)
- `parseChat(raw, now) -> Array` (`[]` for null, bad JSON, wrong shape, or `now - savedAt > 14 days`)

- [ ] Tests: key shape incl. `portal` fallback; serialise drops greeting and pending and keeps 20; parse round-trips; parse returns `[]` for garbage and for 15-day-old data.
- [ ] Implement; panel loads `[greeting, ...parseChat(...)]` on open and when `route.projectId` changes, saves on every messages change (try/catch), header **Clear chat** button (aria-label "Clear chat") resets to the greeting and removes the key.
- [ ] Smoke: ask (mocked `/api/assistant/chat`), close, reopen → question and reply still shown; Clear chat empties it; another project shows its own (empty) chat.
- [ ] Run tests, `npm run build:web`, smoke section for the cat; commit.

### Task 2: The cat reads approved project memory (server)

**Files:** Modify `server/agentcore-memory.ts`, `server/assistant/prompt.ts`, `server/assistant/routes.ts`; Test `test/agentcore-memory.test.ts` (or the existing memory test file), `test/assistant-prompt.test.ts`, `test/assistant-routes.test.ts`.

**Interfaces (produces):**
- `projectMemoryNotes(projectId: string, query: string): Promise<string[]>` in `agentcore-memory.ts`; `buildProjectMemoryBlock` reuses it.
- `buildPrompt` input gains `notes: string[]`.

- [ ] Tests (fake client via `_setMemoryClient`): only approved records returned; memory off → `[]`; client throws → `[]`; cap respected. Prompt: notes appear under the heading, defanged; trimmed before guide. Route: notes passed for a member's project question; none without a project.
- [ ] Implement; route fetches notes in parallel with knowledge (`Promise.all`), only after the membership check.
- [ ] Run new and existing `test/assistant-*.test.ts` and memory tests, typecheck, map check, build; commit.

### Task 3: Docs

- [ ] `docs/user-guide.md`: cat section (chat kept per project in this browser, Clear chat, uses approved project notes); project memory section (approved notes also inform the cat). Update the cat-assistant spec status line. Commit.
